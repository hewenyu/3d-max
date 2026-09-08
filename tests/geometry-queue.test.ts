import assert from 'node:assert/strict';
import test from 'node:test';
import { createObject } from '../shared/project';
import { evaluateGeometry, GEOMETRY_QUEUE_LIMITS } from '../src/engine/GeometryEvaluation';

class GeometryWorkerStub {
  static instances: GeometryWorkerStub[] = [];
  static failConstruction = false;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  terminated = false;
  failPost = false;
  constructor() {
    if (GeometryWorkerStub.failConstruction) throw new Error('worker unavailable');
    GeometryWorkerStub.instances.push(this);
  }
  postMessage() {
    if (this.failPost) throw new Error('message could not be cloned');
  }
  terminate() {
    this.terminated = true;
  }
}

const object = createObject('box', 'queue fixture');
const project = { objects: [object] };
async function withWorker(check: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  GeometryWorkerStub.instances = [];
  Object.defineProperty(globalThis, 'Worker', { value: GeometryWorkerStub, configurable: true });
  try {
    await check();
  } finally {
    GeometryWorkerStub.failConstruction = false;
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
}

test('geometry queue rejects capacity overflow and releases cancelled active and queued requests', async () => {
  await withWorker(async () => {
    const controllers = Array.from({ length: GEOMETRY_QUEUE_LIMITS.requests }, () => new AbortController());
    const pending = controllers.map((controller) =>
      evaluateGeometry(project, object, controller.signal).catch((error: Error) => error),
    );
    assert.equal(GeometryWorkerStub.instances.length, 1);
    await assert.rejects(evaluateGeometry(project, object, new AbortController().signal), /queue exceeds/);
    controllers.at(-1)!.abort();
    const replacement = new AbortController();
    const replaced = evaluateGeometry(project, object, replacement.signal).catch((error: Error) => error);
    replacement.abort();
    for (const controller of [...controllers].reverse()) controller.abort();
    for (const result of await Promise.all([...pending, replaced])) {
      assert.ok(result instanceof Error);
      assert.equal(result.name, 'AbortError');
    }
    assert.equal(GeometryWorkerStub.instances[0].terminated, true);
    const next = new AbortController();
    const result = evaluateGeometry(project, object, next.signal);
    GeometryWorkerStub.instances.at(-1)!.onmessage!({ data: { mesh: { vertices: [], faces: [] } } });
    assert.deepEqual(await result, { vertices: [], faces: [] });
  });
});

test('worker failures release reservations and late events cannot finish a newer geometry request', async () => {
  await withWorker(async () => {
    GeometryWorkerStub.failConstruction = true;
    await assert.rejects(evaluateGeometry(project, object, new AbortController().signal), /unavailable/);
    GeometryWorkerStub.failConstruction = false;
    const failed = evaluateGeometry(project, object, new AbortController().signal);
    const old = GeometryWorkerStub.instances.at(-1)!;
    old.failPost = true;
    old.onmessage!({ data: { ready: true } });
    await assert.rejects(failed, /could not be cloned/);
    const current = evaluateGeometry(project, object, new AbortController().signal);
    const worker = GeometryWorkerStub.instances.at(-1)!;
    old.onerror!({ message: 'late error' });
    old.onmessage!({ data: { error: { message: 'late result' } } });
    assert.equal(worker.terminated, false);
    worker.onmessage!({ data: { mesh: { vertices: [], faces: [] } } });
    assert.deepEqual(await current, { vertices: [], faces: [] });
  });
});
