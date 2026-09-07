import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { NodeIO, type GLTF } from '@gltf-transform/core';
import { modelCatalogRequestSchema, type ModelCatalog } from '../shared/model-catalog';
import type { SceneObject } from '../shared/types';
import type { AssetRecord, Store } from './store';
import { ApiError } from './errors';

const documents = new Map<string, GLTF.IGLTF>();
class LocalModelIO extends NodeIO {
  constructor(
    private readonly store: Store,
    private readonly asset: AssetRecord,
  ) {
    super();
  }
  protected override async readURI(uri: string, type: 'view'): Promise<Uint8Array<ArrayBuffer>>;
  protected override async readURI(uri: string, type: 'text'): Promise<string>;
  protected override async readURI(
    uri: string,
    type: 'view' | 'text',
  ): Promise<Uint8Array<ArrayBuffer> | string> {
    await this.init();
    const path = uri === this.asset.path ? this.asset.path : this.store.assetByUrl(uri)?.path;
    if (!path) throw new ApiError('EXTERNAL_ASSET', 'Model references an unavailable local resource');
    const bytes = await readFile(path);
    return type === 'text' ? bytes.toString('utf8') : new Uint8Array(bytes);
  }
}
function documentBytes(bytes: Buffer): GLTF.IGLTF {
  return JSON.parse(
    bytes.toString(
      'utf8',
      bytes.toString('ascii', 0, 4) === 'glTF' ? 20 : 0,
      bytes.toString('ascii', 0, 4) === 'glTF' ? 20 + bytes.readUInt32LE(12) : bytes.length,
    ),
  );
}
export function assertModelAnimation(asset: AssetRecord, object: SceneObject) {
  if (object.animationIndex === undefined && object.animationName === undefined) return;
  const key = `${asset.id}:${asset.path}:${asset.size}`;
  let document = documents.get(key);
  if (!document) {
    document = documentBytes(readFileSync(asset.path));
    if (documents.size > 100) documents.clear();
    documents.set(key, document);
  }
  const animations = document.animations ?? [];
  if (
    (typeof object.animationIndex === 'number' && object.animationIndex >= animations.length) ||
    (object.animationIndex === undefined &&
      object.animationName !== undefined &&
      !animations.some(
        (animation, index) => (animation.name || `animation_${index}`) === object.animationName,
      ))
  )
    throw new ApiError('INVALID_ANIMATION', 'Selected animation is absent from the imported model');
}

export async function modelCatalog(store: Store, input: unknown): Promise<ModelCatalog> {
  const request = modelCatalogRequestSchema.parse(input);
  const project = store.project();
  if (request.projectId && project.id !== request.projectId)
    throw new ApiError('PROJECT_CONFLICT', 'Active project changed', 409);
  const object = project.objects.find((item) => item.id === request.objectId);
  const asset = object?.assetUrl ? store.assetByUrl(object.assetUrl) : undefined;
  if (!object || object.type !== 'model' || !asset)
    throw new ApiError('INVALID_MODEL', 'Select an imported glTF model');
  try {
    const document = await new LocalModelIO(store, asset).read(asset.path);
    const root = document.getRoot();
    const nodes = root.listNodes();
    const skins = root.listSkins();
    const animations = root.listAnimations();
    return {
      objectId: object.id,
      assetUrl: asset.url,
      nodes: nodes.map((node, index) => ({
        index,
        name: node.getName() || `Node ${index}`,
        parent: node.getParentNode() ? nodes.indexOf(node.getParentNode()!) : null,
        mesh: Boolean(node.getMesh()),
        skin: node.getSkin() ? skins.indexOf(node.getSkin()!) : null,
      })),
      skins: skins.map((skin, index) => ({
        index,
        name: skin.getName() || `Skeleton ${index}`,
        skeleton: skin.getSkeleton() ? nodes.indexOf(skin.getSkeleton()!) : null,
        joints: skin.listJoints().map((joint) => nodes.indexOf(joint)),
      })),
      animations: animations.map((animation, index) => ({
        index,
        name: animation.getName() || `animation_${index}`,
        duration: Math.max(
          0,
          ...animation.listSamplers().flatMap((sampler) => {
            const input = sampler.getInput();
            return input ? [input.getMax([])[0] ?? 0] : [];
          }),
        ),
        channels: animation.listChannels().map((channel) => ({
          node: nodes.indexOf(channel.getTargetNode()!),
          path: channel.getTargetPath() ?? '',
        })),
      })),
      compatibility: {
        embeddedAnimation: animations.length ? 'available' : 'none',
        skeleton: skins.length ? 'skinned' : 'static',
        builtinActorRetargeting: false,
      },
    };
  } catch (error) {
    throw new ApiError(
      'MODEL_CATALOG_UNSUPPORTED',
      `Unable to inspect this glTF model: ${(error as Error).message}`,
      422,
    );
  }
}
