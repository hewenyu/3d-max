import * as THREE from 'three';
import { meshBoolean } from './modifiers/boolean';
import { evaluateModelObject } from './object-modeling';
import { modelingWorldMatrix } from './modeling-transforms';
import { modifyStack } from './modifier-operations';
import type { Command, Project, SceneObject, Vec3 } from './types';
import { allocateComponentId } from './topology/identity';
import { ensureMeshIdentity } from './topology/identity';
import { applyTopologyCommand } from './topology-commands';
import { surfaceDataSchema } from './surfaces/schema';
import {
  ModelingError,
  curveDataSchema,
  meshDataSchema,
  modelingSchema,
  terrainDataSchema,
  supportsMeshConversion,
  type MeshData,
  type ModelingData,
  type TerrainData,
} from './modeling';
import { faceNormal, meshToGeometry, terrainHeight } from './modeling-geometry';

type ModelingObject = SceneObject & { modeling?: ModelingData };

function editable(project: Project, id: unknown): ModelingObject {
  const object = project.objects.find((value) => value.id === id);
  if (!object) throw new ModelingError(`Object not found: ${String(id)}`, 'NOT_FOUND', 404);
  if (object.locked) throw new ModelingError(`Object is locked: ${object.id}`, 'LOCKED', 409);
  if (object.type === 'actor' || object.type === 'group')
    throw new ModelingError('Modeling operations require a mesh object, not an actor or group');
  return object;
}

function currentMesh(object: ModelingObject, project: Project): MeshData {
  if (!supportsMeshConversion(object))
    throw new ModelingError(`Cannot convert ${object.type}; choose a primitive or editable modeling object`);
  return evaluateModelObject(project, object);
}

function indexedMesh(object: ModelingObject): MeshData {
  if (object.modeling?.kind !== 'mesh')
    throw new ModelingError('Convert the object to an editable mesh first');
  return structuredClone(object.modeling);
}

function installGeometry(project: Project, object: ModelingObject, input: ModelingData) {
  const modeling = modelingSchema.parse(input);
  const geometry = meshToGeometry(evaluateModelObject(project, object, modeling));
  try {
    const size = geometry.boundingBox!.getSize(new THREE.Vector3());
    object.dimensions = [Math.max(0.001, size.x), Math.max(0.001, size.y), Math.max(0.001, size.z)];
  } finally {
    geometry.dispose();
  }
  object.modeling = modeling;
  if (object.assetUrl) object.sourceAssetUrl ??= object.assetUrl;
  delete object.assetUrl;
  delete object.animationName;
  return { id: object.id, modeling, dimensions: object.dimensions };
}

function faceAt(mesh: MeshData, index: unknown) {
  const face = mesh.faces[index as number];
  if (!face) throw new ModelingError(`Face does not exist: ${String(index)}`, 'NOT_FOUND', 404);
  return face;
}

function booleanGeometry(
  project: Project,
  target: ModelingObject,
  operand: ModelingObject,
  operation: string,
): MeshData {
  if (target.id === operand.id) throw new ModelingError('Choose a different Boolean operand');
  const transform = modelingWorldMatrix(project, target)
    .invert()
    .multiply(modelingWorldMatrix(project, operand));
  return meshBoolean(
    currentMesh(target, project),
    currentMesh(operand, project),
    transform,
    operation as 'union' | 'subtract' | 'intersect',
  );
}

function replaceTerrain(object: ModelingObject, input: Record<string, unknown>): TerrainData {
  const previous = object.modeling?.kind === 'terrain' ? object.modeling : undefined;
  const sizeX = input.sizeX as number;
  const sizeZ = input.sizeZ as number;
  const segmentsX = input.segmentsX as number;
  const segmentsZ = input.segmentsZ as number;
  const heights =
    (input.heights as number[] | undefined) ||
    Array.from({ length: (segmentsX + 1) * (segmentsZ + 1) }, (_, index) => {
      if (!previous) return 0;
      const row = Math.floor(index / (segmentsX + 1));
      const column = index % (segmentsX + 1);
      return terrainHeight(
        previous,
        (column / segmentsX - 0.5) * previous.sizeX,
        (row / segmentsZ - 0.5) * previous.sizeZ,
      );
    });
  return terrainDataSchema.parse({
    kind: 'terrain',
    sizeX,
    sizeZ,
    segmentsX,
    segmentsZ,
    heights,
    thickness: input.thickness ?? previous?.thickness ?? 1,
  });
}

export function applyModelingCommand(project: Project, command: Command): unknown {
  const install = (object: ModelingObject, input: ModelingData) => installGeometry(project, object, input);
  const payload = command.payload;
  const object = editable(project, payload.id);
  if (command.type.startsWith('modifier.'))
    return install(
      object,
      modifyStack(object, command, (modeling) => evaluateModelObject(project, object, modeling)),
    );
  if (object.modeling?.kind === 'stack' && command.type !== 'mesh.convert') {
    if (command.type === 'mesh.boolean')
      throw new ModelingError('Bake the modifier stack before a Boolean operation');
    const stack = object.modeling;
    const sourceObject: SceneObject = { ...object, modeling: structuredClone(stack.base) };
    const sourceProject = {
      ...project,
      objects: project.objects.map((current) => (current.id === object.id ? sourceObject : current)),
    };
    const result = applyModelingCommand(sourceProject, command);
    if (!sourceObject.modeling || sourceObject.modeling.kind === 'stack')
      throw new ModelingError('Source edit did not produce base geometry');
    return { ...(result as object), ...install(object, { ...stack, base: sourceObject.modeling }) };
  }
  if (command.type.startsWith('topology.')) {
    const result = applyTopologyCommand(project, object, indexedMesh(object), command);
    return { ...result, ...install(object, result.mesh) };
  }
  switch (command.type) {
    case 'surface.set':
      return install(object, surfaceDataSchema.parse(payload.surface));
    case 'mesh.convert':
      return install(object, ensureMeshIdentity(currentMesh(object, project)));
    case 'mesh.set':
      return install(
        object,
        meshDataSchema.parse({ kind: 'mesh', ...(payload.mesh as Record<string, unknown>) }),
      );
    case 'mesh.vertex.set': {
      const mesh = indexedMesh(object);
      if (!mesh.vertices[payload.index as number])
        throw new ModelingError('Vertex does not exist', 'NOT_FOUND', 404);
      mesh.vertices[payload.index as number] = payload.position as Vec3;
      return install(object, mesh);
    }
    case 'mesh.vertex.add': {
      const mesh = indexedMesh(object);
      mesh.vertices.push(payload.position as Vec3);
      if (mesh.identity) mesh.identity.vertexIds.push(allocateComponentId(mesh.identity, 'vertex'));
      return { ...install(object, mesh), vertexIndex: mesh.vertices.length - 1 };
    }
    case 'mesh.vertex.delete': {
      const mesh = indexedMesh(object);
      const index = payload.index as number;
      if (!mesh.vertices[index]) throw new ModelingError('Vertex does not exist', 'NOT_FOUND', 404);
      if (mesh.faces.some((face) => face.includes(index)))
        throw new ModelingError('Remove faces referencing this vertex before deleting it');
      mesh.vertices.splice(index, 1);
      mesh.identity?.vertexIds.splice(index, 1);
      mesh.faces = mesh.faces.map((face) => face.map((vertex) => (vertex > index ? vertex - 1 : vertex)));
      return install(object, mesh);
    }
    case 'mesh.face.extrude': {
      const mesh = indexedMesh(object);
      const face = faceAt(mesh, payload.faceIndex);
      const offset = faceNormal(mesh.vertices, face).multiplyScalar(payload.distance as number);
      const cap = face.map((index) => {
        const position = new THREE.Vector3(...mesh.vertices[index]).add(offset);
        mesh.vertices.push(position.toArray() as Vec3);
        if (mesh.identity) mesh.identity.vertexIds.push(allocateComponentId(mesh.identity, 'vertex'));
        return mesh.vertices.length - 1;
      });
      mesh.faces[payload.faceIndex as number] = cap;
      face.forEach((index, side) => {
        const next = (side + 1) % face.length;
        mesh.faces.push([index, face[next], cap[next], cap[side]]);
        if (mesh.identity) mesh.identity.faceIds.push(allocateComponentId(mesh.identity, 'face'));
      });
      return install(object, mesh);
    }
    case 'mesh.face.delete': {
      const mesh = indexedMesh(object);
      faceAt(mesh, payload.faceIndex);
      mesh.faces.splice(payload.faceIndex as number, 1);
      mesh.identity?.faceIds.splice(payload.faceIndex as number, 1);
      return install(object, mesh);
    }
    case 'mesh.face.add': {
      const mesh = indexedMesh(object);
      mesh.faces.push(payload.indices as number[]);
      if (mesh.identity) mesh.identity.faceIds.push(allocateComponentId(mesh.identity, 'face'));
      return install(object, mesh);
    }
    case 'mesh.boolean': {
      const operand = project.objects.find((value) => value.id === payload.operandId) as
        ModelingObject | undefined;
      if (!operand) throw new ModelingError('Boolean operand does not exist', 'NOT_FOUND', 404);
      if (payload.keepOperand === false && operand.locked)
        throw new ModelingError('The Boolean operand is locked and cannot be hidden', 'LOCKED', 409);
      const result = install(object, booleanGeometry(project, object, operand, payload.operation as string));
      if (payload.keepOperand === false) operand.visible = false;
      return result;
    }
    case 'curve.set':
      return install(
        object,
        curveDataSchema.parse({ kind: 'curve', ...(payload.curve as Record<string, unknown>) }),
      );
    case 'terrain.set':
      return install(object, replaceTerrain(object, payload.terrain as Record<string, unknown>));
    case 'terrain.point.set': {
      if (object.modeling?.kind !== 'terrain') throw new ModelingError('Select an editable terrain');
      const terrain = structuredClone(object.modeling);
      const row = payload.row as number;
      const column = payload.column as number;
      if (row > terrain.segmentsZ || column > terrain.segmentsX)
        throw new ModelingError('Terrain grid point is out of range');
      terrain.heights[row * (terrain.segmentsX + 1) + column] = payload.height as number;
      return install(object, terrain);
    }
    case 'terrain.sculpt': {
      if (object.modeling?.kind !== 'terrain') throw new ModelingError('Select an editable terrain');
      const terrain = structuredClone(object.modeling);
      const initial = [...terrain.heights];
      const [centerX, centerZ] = payload.center as [number, number];
      const radius = payload.radius as number;
      const amount = payload.amount as number;
      if (payload.mode === 'smooth' && (amount < 0 || amount > 1))
        throw new ModelingError('Smoothing amount must be between zero and one');
      let changed = 0;
      for (let row = 0; row <= terrain.segmentsZ; row++) {
        for (let column = 0; column <= terrain.segmentsX; column++) {
          const distance = Math.hypot(
            (column / terrain.segmentsX - 0.5) * terrain.sizeX - centerX,
            (row / terrain.segmentsZ - 0.5) * terrain.sizeZ - centerZ,
          );
          if (distance >= radius) continue;
          const influence = (1 - distance / radius) ** 2;
          const index = row * (terrain.segmentsX + 1) + column;
          if (payload.mode === 'raise') terrain.heights[index] += amount * influence;
          else if (payload.mode === 'flatten')
            terrain.heights[index] += (amount - terrain.heights[index]) * influence;
          else {
            const neighbors: number[] = [];
            for (let r = Math.max(0, row - 1); r <= Math.min(terrain.segmentsZ, row + 1); r++)
              for (let c = Math.max(0, column - 1); c <= Math.min(terrain.segmentsX, column + 1); c++)
                neighbors.push(initial[r * (terrain.segmentsX + 1) + c]);
            terrain.heights[index] +=
              (neighbors.reduce((sum, height) => sum + height, 0) / neighbors.length -
                terrain.heights[index]) *
              influence *
              amount;
          }
          changed++;
        }
      }
      if (!changed) throw new ModelingError('The terrain brush does not overlap any grid point');
      return install(object, terrain);
    }
    default:
      throw new ModelingError(`Unknown modeling command: ${command.type}`);
  }
}
