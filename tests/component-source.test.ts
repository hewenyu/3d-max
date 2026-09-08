import test from 'node:test';
import assert from 'node:assert/strict';
import { meshToGeometry } from '../shared/mesh-geometry';
import { ComponentSource } from '../src/engine/ComponentSource';
import { componentSourceTransfers, prepareComponentSource } from '../src/engine/ComponentSourceData';
import type { TopologyMesh } from '../shared/topology/types';
import { topologyCube } from './fixtures/topology-command-cases';

test('worker source payload transfers complete picking geometry, stable topology maps and static feedback', () => {
  const input = topologyCube();
  const expected = meshToGeometry(input);
  try {
    const source = prepareComponentSource(input);
    const transferred = structuredClone(source, { transfer: componentSourceTransfers(source) });
    assert.equal(source.positions.byteLength, 0);
    assert.deepEqual(Array.from(transferred.positions), Array.from(expected.getAttribute('position').array));
    assert.deepEqual(Array.from(transferred.indices), Array.from(expected.getIndex()!.array));
    assert.deepEqual(Array.from(transferred.polygonIndices), expected.userData.polygonIndices);
    assert.deepEqual(Array.from(transferred.faceRanges), [0, 2, 4, 6, 8, 10, 12]);
    assert.equal(transferred.topology.faceById.get(transferred.topology.mesh.identity.faceIds[1]), 1);
    assert.equal(transferred.wire.length, transferred.topology.edges.length * 6);
    assert.equal(transferred.boundaries.length, 0);
    assert.equal(transferred.normals.length, input.faces.length * 6);
    assert.deepEqual(transferred.bounds.min, [-1, -1, -1]);
    assert.deepEqual(transferred.bounds.max, [1, 1, 1]);
  } finally {
    expected.dispose();
  }
});

test('source cache retains only the current version, retries worker failures and terminates superseded workers', async () => {
  class ControlledWorker {
    static instances: ControlledWorker[] = [];
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { message: string }) => void;
    onmessageerror?: () => void;
    mesh?: TopologyMesh;
    terminated = false;
    constructor() {
      ControlledWorker.instances.push(this);
    }
    postMessage(mesh: TopologyMesh) {
      this.mesh = structuredClone(mesh);
    }
    terminate() {
      this.terminated = true;
    }
    finish() {
      this.onmessage?.({ data: { data: prepareComponentSource(this.mesh!) } });
    }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: ControlledWorker,
  });
  const cache = new ComponentSource();
  try {
    const first = topologyCube();
    const pending = cache.prepare(first);
    const cancelled = assert.rejects(pending, { code: 'SOURCE_CANCELLED' });
    assert.equal(cache.prepare(first), pending);
    const second = structuredClone(first);
    second.vertices[0][0] -= 0.2;
    const next = cache.prepare(second);
    await cancelled;
    assert.equal(ControlledWorker.instances[0].terminated, true);
    ControlledWorker.instances[1].finish();
    const result = await next;
    assert.equal(ControlledWorker.instances[1].terminated, true);
    const clone = structuredClone(second);
    const reused = await cache.prepare(clone);
    assert.equal(reused.input, clone);
    assert.equal(reused.data, result.data);
    assert.equal((await cache.prepare(clone)).input, clone);
    assert.equal(ControlledWorker.instances.length, 2);
    const failed = cache.prepare(first);
    ControlledWorker.instances[2].onerror?.({ message: 'Module load failed' });
    await assert.rejects(failed, { code: 'SOURCE_WORKER_FAILED' });
    const retry = cache.prepare(first);
    assert.equal(ControlledWorker.instances.length, 4);
    ControlledWorker.instances[2].onerror?.({ message: 'Late failure from a replaced worker' });
    assert.equal(cache.prepare(first), retry);
    ControlledWorker.instances[3].finish();
    await retry;
    assert.equal(cache.prepare(first), retry);
    const older = cache.prepare(second);
    const disposed = assert.rejects(older, { code: 'SOURCE_CANCELLED' });
    cache.dispose();
    await disposed;
    assert.equal(ControlledWorker.instances.at(-1)!.terminated, true);
    await assert.rejects(cache.prepare(first), { code: 'SOURCE_CANCELLED' });
  } finally {
    cache.dispose();
    if (previous) Object.defineProperty(globalThis, 'Worker', previous);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
});
