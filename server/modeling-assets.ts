import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Document, NodeIO, type GLTF, type Node as GltfNode } from '@gltf-transform/core';
import * as THREE from 'three';
import { z } from 'zod';
import {
  modelConversionRequestSchema,
  modelExportRequestSchema,
  type ModelingAssetDiagnostic,
  type ModelingAssetProgress,
} from '../shared/model-assets';
export {
  modelConversionRequestSchema,
  modelExportRequestSchema,
  type ModelingAssetDiagnostic,
  type ModelingAssetProgress,
} from '../shared/model-assets';
import { meshDataSchema, type MeshData } from '../shared/modeling';
import { createObjectModelEvaluator } from '../shared/object-modeling';
import { referencedOperandIds } from '../shared/modifiers/dependencies';
import { sampleObject } from '../shared/object-sampling';
import type { Project, SceneObject, Vec3 } from '../shared/types';
import { buildObject, disposeBuiltObject } from '../src/engine/ObjectFactory';
import { assetByteLimit, importAssetFile, validateModel } from './assets';
import type { ServerConfig } from './config';
import { ApiError } from './errors';
import type { AssetRecord, Store } from './store';

export type ModelAssetSource = Pick<Store, 'project' | 'assetByUrl'>;

type Guard = Pick<
  z.infer<typeof modelConversionRequestSchema>,
  'projectId' | 'expectedRevision' | 'expectedContext'
>;

export interface ModelingAssetOptions {
  signal?: Pick<AbortSignal, 'aborted'>;
  onProgress?: (progress: ModelingAssetProgress) => void;
}

function cancelled(options: ModelingAssetOptions) {
  if (options.signal?.aborted) throw new ApiError('MODELING_CANCELLED', 'Model operation was cancelled', 409);
}
export function guardedModelProject(store: ModelAssetSource, guard: Guard) {
  const project = store.project();
  if (project.id !== guard.projectId)
    throw new ApiError('PROJECT_CONFLICT', 'The active project changed', 409);
  if (project.revision !== guard.expectedRevision)
    throw new ApiError('REVISION_MISMATCH', 'The project changed during model processing', 409, {
      revision: project.revision,
    });
  const context = {
    sceneId: project.production?.activeSceneId ?? null,
    performanceId: project.production?.activePerformanceId ?? null,
  };
  if (
    context.sceneId !== guard.expectedContext.sceneId ||
    context.performanceId !== guard.expectedContext.performanceId
  )
    throw new ApiError('CONTEXT_CONFLICT', 'The scene or performance changed', 409, { context });
  return project;
}
function unsupported(diagnostics: ModelingAssetDiagnostic[]): never {
  throw new ApiError(
    'MODELING_ASSET_UNSUPPORTED',
    'Static geometry cannot represent every requested object or model feature',
    422,
    { diagnostics },
  );
}

class StoredModelIO extends NodeIO {
  private loadedBytes = 0;
  private readonly resources = new Map<string, Promise<Buffer>>();
  constructor(
    private readonly store: ModelAssetSource,
    private readonly asset: AssetRecord,
    bytes: Buffer,
  ) {
    super();
    this.loadedBytes = bytes.length;
    this.resources.set(asset.path, Promise.resolve(bytes));
  }
  protected override resolve(_base: string, path: string): string {
    return path;
  }
  async verifyResources() {
    // NodeIO tolerates missing image files; model conversion still enforces every declared resource.
    await Promise.all(this.resources.values());
  }
  protected override async readURI(uri: string, type: 'view'): Promise<Uint8Array<ArrayBuffer>>;
  protected override async readURI(uri: string, type: 'text'): Promise<string>;
  protected override async readURI(
    uri: string,
    type: 'view' | 'text',
  ): Promise<Uint8Array<ArrayBuffer> | string> {
    let pending = this.resources.get(uri);
    if (!pending) {
      const asset = uri === this.asset.path ? this.asset : this.store.assetByUrl(uri);
      if (!asset)
        throw new ApiError('EXTERNAL_ASSET', 'Model resource is not a stored local asset', 422, { uri });
      pending = (async () => {
        const size = (await stat(asset.path)).size;
        this.loadedBytes += size;
        if (this.loadedBytes > assetByteLimit)
          throw new ApiError('ASSET_TOO_LARGE', 'Model and referenced resources exceed 100 MiB', 413);
        const bytes = await readFile(asset.path);
        if (bytes.length !== size)
          throw new ApiError('ASSET_CHANGED', 'Model resource changed while reading', 409);
        return bytes;
      })();
      this.resources.set(uri, pending);
    }
    const bytes = await pending;
    return type === 'text' ? bytes.toString('utf8') : new Uint8Array(bytes);
  }
}

function rawDiagnostics(json: GLTF.IGLTF, objectId: string): ModelingAssetDiagnostic[] {
  const diagnostics: ModelingAssetDiagnostic[] = [];
  if (json.skins?.length)
    diagnostics.push({
      code: 'SKINNED_MODEL',
      objectId,
      message: 'Skinning must remain in the original asset; static conversion does not bake a pose.',
    });
  if (json.animations?.length)
    diagnostics.push({
      code: 'ANIMATED_MODEL',
      objectId,
      message: 'Embedded animation is not preserved by static geometry conversion.',
    });
  if (json.extensionsUsed?.length || json.extensionsRequired?.length)
    diagnostics.push({
      code: 'MODEL_EXTENSIONS',
      objectId,
      message: `Unregistered model extensions: ${[...new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])])].join(', ')}`,
    });
  json.meshes?.forEach((mesh, meshIndex) =>
    mesh.primitives.forEach((primitive, primitiveIndex) => {
      if (primitive.targets?.length || mesh.weights?.length)
        diagnostics.push({
          code: 'MORPH_TARGETS',
          objectId,
          primitive: primitiveIndex,
          message: `Mesh ${meshIndex} has morph data that cannot be preserved.`,
        });
      const skinAttributes = Object.keys(primitive.attributes).filter((name) =>
        /^(JOINTS|WEIGHTS)_/.test(name),
      );
      if (skinAttributes.length)
        diagnostics.push({
          code: 'SKIN_ATTRIBUTES',
          objectId,
          primitive: primitiveIndex,
          attributes: skinAttributes,
          message: 'Joint and weight attributes cannot become a static editable mesh.',
        });
      if (primitive.mode !== undefined && primitive.mode !== 4)
        diagnostics.push({
          code: 'PRIMITIVE_MODE',
          objectId,
          primitive: primitiveIndex,
          message: `Mesh ${meshIndex} uses primitive mode ${primitive.mode}; only triangle surfaces are compatible.`,
        });
    }),
  );
  return diagnostics;
}

function transformGeometry(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4) {
  if (!Number.isFinite(matrix.determinant()) || matrix.determinant() === 0)
    throw new ApiError('MODELING_ASSET_TRANSFORM', 'A model transform collapses one or more dimensions', 422);
  geometry.applyMatrix4(matrix);
  if (matrix.determinant() < 0) {
    const existing = geometry.getIndex();
    const indices = existing
      ? Array.from(existing.array)
      : Array.from({ length: geometry.getAttribute('position').count }, (_, index) => index);
    for (let index = 0; index < indices.length; index += 3)
      [indices[index + 1], indices[index + 2]] = [indices[index + 2], indices[index + 1]];
    geometry.setIndex(indices);
  }
  return geometry;
}

interface StaticModel {
  geometries: THREE.BufferGeometry[];
  asset: { id: string; url: string; sha256: string };
  diagnostics: ModelingAssetDiagnostic[];
}
async function readStaticModel(
  store: ModelAssetSource,
  object: SceneObject,
  options: ModelingAssetOptions,
): Promise<StaticModel> {
  const asset = object.assetUrl ? store.assetByUrl(object.assetUrl) : undefined;
  if (!asset || object.type !== 'model')
    throw new ApiError('INVALID_MODEL', 'Select an imported GLB or glTF object');
  if (object.modeling)
    throw new ApiError('ALREADY_EDITABLE', 'The selected object already contains editable geometry');
  const size = (await stat(asset.path)).size;
  if (size > assetByteLimit) throw new ApiError('ASSET_TOO_LARGE', 'Model exceeds 100 MiB', 413);
  const bytes = await readFile(asset.path);
  if (bytes.length !== size) throw new ApiError('ASSET_CHANGED', 'Model changed while reading', 409);
  await validateModel(bytes, asset.mime === 'model/gltf-binary' ? '.glb' : '.gltf', store);
  cancelled(options);
  const io = new StoredModelIO(store, asset, bytes);
  await io.init();
  const json = await io.readAsJSON(asset.path);
  await io.verifyResources();
  const incompatible = rawDiagnostics(json.json, object.id);
  if (incompatible.length) unsupported(incompatible);
  const document = await io.readJSON(json);
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new ApiError('EMPTY_MODEL', 'The model has no scene', 422);
  const nodes: GltfNode[] = [];
  scene.traverse((node) => nodes.push(node));
  const geometries: THREE.BufferGeometry[] = [];
  const diagnostics: ModelingAssetDiagnostic[] = [];
  let vertexCount = 0;
  let triangleCount = 0;
  try {
    for (const node of nodes) {
      cancelled(options);
      const nodeIndex = root.listNodes().indexOf(node);
      for (const [primitiveIndex, primitive] of (node.getMesh()?.listPrimitives() ?? []).entries()) {
        const positions = primitive.getAttribute('POSITION');
        const indices = primitive.getIndices();
        if (!positions || positions.getType() !== 'VEC3')
          unsupported([
            {
              code: 'POSITION_ATTRIBUTE',
              objectId: object.id,
              node: nodeIndex,
              primitive: primitiveIndex,
              message: 'Triangle surfaces require VEC3 positions.',
            },
          ]);
        const count = indices?.getCount() ?? positions.getCount();
        vertexCount += positions.getCount();
        triangleCount += count / 3;
        if (count % 3 || vertexCount > 100000 || triangleCount > 100000)
          throw new ApiError(
            'MODELING_LIMIT',
            'Static conversion requires triangle indices and at most 100000 vertices and triangle faces',
            422,
            { objectId: object.id, vertexCount, triangleCount },
          );
        const vertices = new Float32Array(positions.getCount() * 3);
        const value: number[] = [];
        for (let index = 0; index < positions.getCount(); index++) {
          positions.getElement(index, value);
          if (value.some((coordinate) => !Number.isFinite(coordinate)))
            throw new ApiError('INVALID_MODEL', 'Model positions must be finite', 422);
          vertices.set(value, index * 3);
        }
        const triangleIndices = indices
          ? Array.from({ length: count }, (_, index) => indices.getScalar(index))
          : Array.from({ length: count }, (_, index) => index);
        if (
          triangleIndices.some(
            (index) => !Number.isInteger(index) || index < 0 || index >= positions.getCount(),
          )
        )
          throw new ApiError('INVALID_MODEL', 'Model indices reference unavailable vertices', 422);
        const geometry = new THREE.BufferGeometry();
        geometries.push(geometry);
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(triangleIndices);
        const normals = primitive.getAttribute('NORMAL');
        if (normals) {
          if (normals.getType() !== 'VEC3' || normals.getCount() !== positions.getCount())
            throw new ApiError('INVALID_MODEL', 'Model normal attributes have incompatible dimensions', 422);
          const values = new Float32Array(normals.getCount() * 3);
          for (let index = 0; index < normals.getCount(); index++) {
            const normal = normals.getElement(index, []);
            if (normal.some((value) => !Number.isFinite(value)))
              throw new ApiError('INVALID_MODEL', 'Model normals must be finite', 422);
            values.set(normal, index * 3);
          }
          geometry.setAttribute('normal', new THREE.BufferAttribute(values, 3));
        } else geometry.computeVertexNormals();
        transformGeometry(geometry, new THREE.Matrix4().fromArray(node.getWorldMatrix()));
        const attributes = primitive.listSemantics().filter((name) => name !== 'POSITION');
        if (attributes.length)
          diagnostics.push({
            code: 'CONVERSION_ATTRIBUTES',
            objectId: object.id,
            node: nodeIndex,
            primitive: primitiveIndex,
            attributes,
            message:
              'Editable conversion retains positions and triangles; normals are regenerated, and other vertex attributes remain only in the original asset.',
          });
        if (primitive.getMaterial())
          diagnostics.push({
            code: 'WHITE_MATERIAL',
            objectId: object.id,
            node: nodeIndex,
            primitive: primitiveIndex,
            message:
              'The white-model material replaces imported materials and textures; the original asset is retained.',
          });
      }
    }
    if (!geometries.length)
      throw new ApiError('EMPTY_MODEL', 'The selected scene contains no triangle geometry', 422);
    const bounds = new THREE.Box3();
    for (const geometry of geometries) {
      geometry.computeBoundingBox();
      bounds.union(geometry.boundingBox!);
    }
    const dimensions = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const fit = Math.min(
      ...object.dimensions.map(
        (value, axis) => Math.max(0.001, value) / Math.max(0.001, dimensions.getComponent(axis)),
      ),
    );
    const normalization = new THREE.Matrix4()
      .makeScale(fit, fit, fit)
      .setPosition(-center.x * fit, -bounds.min.y * fit, -center.z * fit);
    for (const geometry of geometries) transformGeometry(geometry, normalization);
    diagnostics.push({
      code: 'FLATTENED_STATIC_SCENE',
      objectId: object.id,
      message:
        'The default glTF scene is flattened into object-local geometry using node hierarchy transforms and the editor centering, floor alignment and uniform dimension fit. Unused scenes, cameras and node hierarchy stay in the original asset.',
    });
    return {
      geometries,
      diagnostics,
      asset: { id: asset.id, url: asset.url, sha256: createHash('sha256').update(bytes).digest('hex') },
    };
  } catch (error) {
    geometries.forEach((geometry) => geometry.dispose());
    if (error instanceof ApiError) throw error;
    throw new ApiError('INVALID_MODEL', `Unable to convert static model: ${(error as Error).message}`, 422);
  }
}

async function staticModel(store: ModelAssetSource, object: SceneObject, options: ModelingAssetOptions) {
  try {
    return await readStaticModel(store, object, options);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('INVALID_MODEL', `Unable to read static geometry: ${(error as Error).message}`, 422);
  }
}

export async function planModelConversion(
  store: ModelAssetSource,
  input: unknown,
  options: ModelingAssetOptions = {},
) {
  const request = modelConversionRequestSchema.parse(input);
  const project = guardedModelProject(store, request);
  const object = project.objects.find((item) => item.id === request.objectId);
  if (!object) throw new ApiError('NOT_FOUND', 'Model object does not exist', 404);
  if (object.locked) throw new ApiError('LOCKED', 'Unlock the object before converting its geometry', 409);
  cancelled(options);
  options.onProgress?.({ stage: 'reading', completed: 0, total: 1 });
  const result = await staticModel(store, object, options);
  try {
    const vertices: Vec3[] = [];
    const faces: number[][] = [];
    for (const geometry of result.geometries) {
      const positions = geometry.getAttribute('position');
      const start = vertices.length;
      for (let index = 0; index < positions.count; index++)
        vertices.push([positions.getX(index), positions.getY(index), positions.getZ(index)]);
      const indices = geometry.getIndex()!;
      for (let index = 0; index < indices.count; index += 3)
        faces.push([
          indices.getX(index) + start,
          indices.getX(index + 1) + start,
          indices.getX(index + 2) + start,
        ]);
    }
    const mesh: MeshData = meshDataSchema.parse({ kind: 'mesh', vertices, faces, smooth: true });
    cancelled(options);
    guardedModelProject(store, request);
    options.onProgress?.({ stage: 'geometry', completed: 1, total: 1 });
    return {
      projectId: project.id,
      revision: project.revision,
      context: request.expectedContext,
      objectId: object.id,
      asset: result.asset,
      mesh,
      diagnostics: result.diagnostics,
      sourcePreserved: true as const,
    };
  } finally {
    result.geometries.forEach((geometry) => geometry.dispose());
  }
}

function matrixAt(
  objects: Map<string, SceneObject>,
  object: SceneObject,
  seen = new Set<string>(),
): THREE.Matrix4 {
  if (seen.has(object.id))
    throw new ApiError('MODELING_HIERARCHY', 'Object hierarchy contains a cycle', 422, {
      objectId: object.id,
    });
  seen.add(object.id);
  if (object.attachment)
    unsupported([
      {
        code: 'BONE_ATTACHMENT',
        objectId: object.id,
        message: 'Detach bone attachments before static model export.',
      },
    ]);
  const local = new THREE.Matrix4().compose(
    new THREE.Vector3(...object.position),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...(object.rotation.map(THREE.MathUtils.degToRad) as Vec3), 'XYZ'),
    ),
    new THREE.Vector3(...object.scale),
  );
  if (!object.parentId) return local;
  const parent = objects.get(object.parentId);
  if (!parent)
    throw new ApiError('MODELING_HIERARCHY', 'Object parent is unavailable', 422, {
      objectId: object.id,
      parentId: object.parentId,
    });
  return matrixAt(objects, parent, seen).multiply(local);
}

function exportObjects(project: Project, request: z.infer<typeof modelExportRequestSchema>) {
  const objects = new Map(
    project.objects.map((object) => [object.id, sampleObject(object, request.sourceTime, { render: true })]),
  );
  if (request.scope === 'scene' && request.objectIds)
    throw new ApiError('INVALID_SCOPE', 'Scene export does not accept objectIds');
  if (request.scope === 'selection' && !request.objectIds?.length)
    throw new ApiError('INVALID_SCOPE', 'Selection export requires objectIds');
  const selected = new Set(request.scope === 'scene' ? objects.keys() : request.objectIds);
  for (const id of selected)
    if (!objects.has(id))
      throw new ApiError('NOT_FOUND', 'Selected object is unavailable', 404, { objectId: id });
  for (const object of objects.values()) {
    let parent = object.parentId;
    const seen = new Set<string>();
    while (parent) {
      if (seen.has(parent))
        throw new ApiError('MODELING_HIERARCHY', 'Object hierarchy contains a cycle', 422);
      seen.add(parent);
      if (selected.has(parent)) selected.add(object.id);
      parent = objects.get(parent)?.parentId ?? null;
    }
  }
  const hidden: string[] = [];
  const included = [...selected]
    .filter((id) => {
      let current: SceneObject | undefined = objects.get(id);
      while (current) {
        if (!current.visible && !request.includeHidden) {
          hidden.push(id);
          return false;
        }
        current = current.parentId ? objects.get(current.parentId) : undefined;
      }
      return true;
    })
    .map((id) => objects.get(id)!);
  const diagnostics = included.flatMap((object): ModelingAssetDiagnostic[] => {
    if (object.actor || object.type === 'actor' || object.vehicle || object.effect || object.attachment)
      return [
        {
          code: object.attachment ? 'BONE_ATTACHMENT' : 'ANIMATED_RIG',
          objectId: object.id,
          message:
            'Actor, vehicle, effect and attached rigs require a dedicated pose export; this static export leaves the scene unchanged.',
        },
      ];
    return [];
  });
  if (diagnostics.length) unsupported(diagnostics);
  return { objects, included, hidden };
}

export async function prepareModelExport(
  store: ModelAssetSource,
  input: unknown,
  options: ModelingAssetOptions = {},
) {
  const request = modelExportRequestSchema.parse(input);
  const project = guardedModelProject(store, request);
  const { objects, included, hidden } = exportObjects(project, request);
  const evaluate = createObjectModelEvaluator(project);
  cancelled(options);
  const document = new Document();
  const buffer = document.createBuffer('whiteframe-static');
  const scene = document.createScene(project.sceneName || project.name);
  document.getRoot().setDefaultScene(scene);
  const diagnostics: ModelingAssetDiagnostic[] = [];
  let vertexCount = 0;
  let triangleCount = 0;
  let bufferBytes = 0;
  const objectIds: string[] = [];
  for (const [objectIndex, object] of included.entries()) {
    cancelled(options);
    options.onProgress?.({ stage: 'geometry', completed: objectIndex, total: included.length });
    await new Promise<void>((done) => setImmediate(done));
    const geometries: { geometry: THREE.BufferGeometry; color: THREE.Color }[] = [];
    let built: Awaited<ReturnType<typeof buildObject>> | undefined;
    try {
      if (object.type === 'model' && !object.modeling) {
        const model = await staticModel(store, object, options);
        diagnostics.push(...model.diagnostics.filter((item) => item.code !== 'CONVERSION_ATTRIBUTES'));
        geometries.push(
          ...model.geometries.map((geometry) => ({
            geometry,
            color: new THREE.Color(object.tone || '#dddeda'),
          })),
        );
      } else {
        built = await buildObject(
          object,
          referencedOperandIds(object).length ? evaluate(object.id) : undefined,
        );
        built.root.updateMatrixWorld(true);
        built.root.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          if (Array.isArray(child.material))
            unsupported([
              {
                code: 'MULTI_MATERIAL',
                objectId: object.id,
                message: 'This procedural surface has material groups that need explicit geometry splitting.',
              },
            ]);
          const material = child.material as THREE.MeshStandardMaterial;
          let geometry = child.geometry.clone();
          if (material.flatShading && geometry.index) {
            const indexed = geometry;
            geometry = geometry.toNonIndexed();
            indexed.dispose();
            geometry.computeVertexNormals();
          }
          geometries.push({
            geometry,
            color: material.color?.clone() ?? new THREE.Color(object.tone || '#dddeda'),
          });
          transformGeometry(geometry, child.matrixWorld);
        });
      }
      if (!geometries.length) {
        if (object.type !== 'group')
          unsupported([
            {
              code: 'EMPTY_OBJECT',
              objectId: object.id,
              message: 'The selected object has no exportable triangle geometry.',
            },
          ]);
        options.onProgress?.({ stage: 'geometry', completed: objectIndex + 1, total: included.length });
        continue;
      }
      const world = matrixAt(objects, object);
      const mesh = document.createMesh(object.name).setExtras({ whiteframeObjectId: object.id });
      for (const { geometry, color } of geometries) {
        transformGeometry(geometry, world);
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
        const positions = geometry.getAttribute('position');
        const normals = geometry.getAttribute('normal');
        const index = geometry.getIndex();
        const count = index?.count ?? positions.count;
        if (count % 3)
          unsupported([
            { code: 'PRIMITIVE_MODE', objectId: object.id, message: 'Export requires triangle surfaces.' },
          ]);
        vertexCount += positions.count;
        triangleCount += count / 3;
        bufferBytes += positions.count * 24 + count * 4;
        if (bufferBytes > assetByteLimit)
          throw new ApiError('ASSET_TOO_LARGE', 'Evaluated geometry buffers exceed 100 MiB', 413, {
            vertexCount,
            triangleCount,
          });
        const points = new Float32Array(positions.count * 3);
        const directions = new Float32Array(positions.count * 3);
        for (let vertex = 0; vertex < positions.count; vertex++) {
          points.set([positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)], vertex * 3);
          directions.set([normals.getX(vertex), normals.getY(vertex), normals.getZ(vertex)], vertex * 3);
        }
        if (
          points.some((value) => !Number.isFinite(value)) ||
          directions.some((value) => !Number.isFinite(value))
        )
          throw new ApiError(
            'INVALID_MODEL',
            'Evaluated geometry contains non-finite coordinates or normals',
            422,
            { objectId: object.id },
          );
        const indices = Uint32Array.from({ length: count }, (_, vertex) => index?.getX(vertex) ?? vertex);
        const material = document
          .createMaterial(`${object.name} white`)
          .setBaseColorFactor([color.r, color.g, color.b, 1])
          .setRoughnessFactor(0.89)
          .setMetallicFactor(0.015);
        mesh.addPrimitive(
          document
            .createPrimitive()
            .setAttribute(
              'POSITION',
              document.createAccessor().setType('VEC3').setArray(points).setBuffer(buffer),
            )
            .setAttribute(
              'NORMAL',
              document.createAccessor().setType('VEC3').setArray(directions).setBuffer(buffer),
            )
            .setIndices(document.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer))
            .setMaterial(material),
        );
      }
      scene.addChild(
        document
          .createNode(object.name)
          .setMesh(mesh)
          .setExtras({ whiteframeObjectId: object.id, sourceTime: request.sourceTime, space: 'world' }),
      );
      objectIds.push(object.id);
      options.onProgress?.({ stage: 'geometry', completed: objectIndex + 1, total: included.length });
    } finally {
      geometries.forEach(({ geometry }) => geometry.dispose());
      if (built) disposeBuiltObject(built);
    }
  }
  if (!objectIds.length)
    throw new ApiError('EMPTY_EXPORT', 'The requested scope has no visible triangle geometry', 422, {
      hiddenObjectIds: hidden,
    });
  cancelled(options);
  options.onProgress?.({ stage: 'encoding', completed: 0, total: 1 });
  const bytes = Buffer.from(await new NodeIO().writeBinary(document));
  if (bytes.length > assetByteLimit)
    throw new ApiError('ASSET_TOO_LARGE', 'Encoded model exceeds 100 MiB', 413);
  cancelled(options);
  guardedModelProject(store, request);
  return {
    bytes,
    metadata: {
      name: `${(request.name ?? `${project.name}-${request.scope}`).replace(/\.glb$/i, '')}.glb`,
      projectId: project.id,
      revision: project.revision,
      context: request.expectedContext,
      scope: request.scope,
      space: 'world' as const,
      sourceTime: request.sourceTime,
      objectIds,
      hiddenObjectIds: hidden,
      vertices: vertexCount,
      triangles: triangleCount,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      diagnostics,
      sourcePreserved: true as const,
    },
  };
}

export type PreparedModelExport = Awaited<ReturnType<typeof prepareModelExport>>;
export type ExportedModelAsset = PreparedModelExport['metadata'] & { id: string; url: string };
export async function publishModelExport(
  store: Store,
  config: ServerConfig,
  input: unknown,
  prepared: PreparedModelExport,
  options: ModelingAssetOptions = {},
  publish?: (result: ExportedModelAsset) => void,
) {
  const request = modelExportRequestSchema.parse(input);
  guardedModelProject(store, request);
  cancelled(options);
  const { bytes, metadata } = prepared;
  if (
    bytes.length > assetByteLimit ||
    bytes.length !== metadata.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== metadata.sha256
  )
    throw new ApiError(
      'MODEL_EXPORT_DIGEST',
      'Prepared GLB does not match its declared bytes and digest',
      422,
    );
  const path = resolve(config.dataDir, 'assets', `model-export-${randomUUID()}.tmp`);
  try {
    await writeFile(path, bytes, { flag: 'wx' });
    options.onProgress?.({ stage: 'storing', completed: 0, total: 1 });
    const asset = await importAssetFile(store, config, { path, name: metadata.name }, (asset) => {
      cancelled(options);
      guardedModelProject(store, request);
      publish?.({ ...metadata, ...asset });
    });
    return { ...metadata, ...asset };
  } finally {
    await unlink(path).catch(() => {});
  }
}

export async function exportModelAsset(
  store: Store,
  config: ServerConfig,
  input: unknown,
  options: ModelingAssetOptions = {},
) {
  return publishModelExport(store, config, input, await prepareModelExport(store, input, options), options);
}
