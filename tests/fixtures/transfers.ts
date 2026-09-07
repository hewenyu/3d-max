import { createHash, randomFillSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDirectories, type ServerConfig } from '../../server/config';
import { Store } from '../../server/store';
import { TransferService } from '../../server/transfers';
import { transferLimits } from '../../server/transfer-schema';

export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const smallModel = Buffer.from(
  JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
);

export function largeModel(binarySize = 26 * 1024 * 1024) {
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: binarySize }],
  });
  const jsonSize = Math.ceil(Buffer.byteLength(json) / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonSize + binarySize, 0x20);
  bytes.write('glTF');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonSize, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.write(json, 20);
  bytes.writeUInt32LE(binarySize, 20 + jsonSize);
  bytes.writeUInt32LE(0x004e4942, 24 + jsonSize);
  const binary = bytes.subarray(28 + jsonSize);
  randomFillSync(binary);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => binary.writeFloatLE(value, index * 4));
  return bytes;
}

export function transferInput(
  bytes: Buffer,
  kind: 'asset' | 'project-package' = 'asset',
  name = 'model.gltf',
) {
  return { kind, name, size: bytes.length, sha256: digest(bytes), requestId: randomUUID() };
}

export function chunkInput(id: string, bytes: Buffer, index = 0) {
  const chunk = bytes.subarray(index * transferLimits.chunkBytes, (index + 1) * transferLimits.chunkBytes);
  return { id, index, dataBase64: chunk.toString('base64'), sha256: digest(chunk) };
}

export async function stage(
  service: TransferService,
  bytes: Buffer,
  kind: 'asset' | 'project-package' = 'asset',
  name = 'model.gltf',
) {
  const transfer = await service.begin(transferInput(bytes, kind, name));
  for (let index = 0; index < transfer.totalChunks; index++)
    await service.chunk(chunkInput(transfer.id, bytes, index));
  return transfer.id;
}

export async function transferFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-transfers-'));
  const config: ServerConfig = {
    dataDir: directory,
    distDir: join(directory, 'dist'),
    port: 0,
    apiUrl: 'http://127.0.0.1:4173',
    appUrl: 'http://127.0.0.1:5173',
  };
  prepareDirectories(config);
  let store = new Store(directory);
  let service = new TransferService(store, config);
  return {
    config,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    restart() {
      store.close();
      store = new Store(directory);
      service = new TransferService(store, config);
    },
    async close() {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
