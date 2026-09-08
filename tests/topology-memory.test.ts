import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store';
import { ModelingJobService } from '../server/modeling-jobs';
import { ensureMeshIdentity } from '../shared/topology';
import type { ModelingJob } from '../shared/modeling-jobs';

test('a 40000-vertex whole-mesh transform completes within the bounded worker heap and preserves exact undo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-topology-memory-'));
  const store = new Store(directory);
  const service = new ModelingJobService(store, (checked, publish) =>
    store.commitModelingJob(checked, publish),
  );
  try {
    store.newProject('Large editable topology', 'empty');
    store.commands({
      commands: [
        { type: 'object.create', payload: { id: 'target', type: 'box' } },
        {
          type: 'surface.set',
          payload: {
            id: 'target',
            surface: {
              kind: 'surface',
              operation: 'revolve',
              segments: 200,
              profileSegments: 50,
              profile: {
                closed: true,
                points: [
                  [1.2, 0],
                  [2, 0],
                  [2, 3],
                  [1.2, 3],
                ].map((position) => ({ position })),
              },
            },
          },
        },
        { type: 'mesh.convert', payload: { id: 'target' } },
      ],
    });
    const source = store.project();
    const original = source.objects[0].modeling;
    assert.equal(original?.kind, 'mesh');
    if (original?.kind !== 'mesh') assert.fail('Expected editable mesh');
    const identified = ensureMeshIdentity(original);
    assert.equal(identified.vertices.length, 40000);
    const job = service.start({
      projectId: source.id,
      expectedRevision: source.revision,
      expectedContext: { sceneId: null, performanceId: null },
      requestId: 'large-transform',
      commands: [
        {
          type: 'topology.transform',
          payload: {
            id: 'target',
            translation: [0.02, 0, 0],
            selection: {
              namespace: identified.identity.namespace,
              kind: 'vertex',
              ids: identified.identity.vertexIds,
            },
          },
        },
      ],
    });
    const finished = await new Promise<ModelingJob>((resolve, reject) => {
      const timer = setTimeout(() => {
        service.off('job', listener);
        reject(new Error('Large worker transform timed out'));
      }, 30000);
      const listener = (current: ModelingJob) => {
        if (current.id !== job.id || !['completed', 'failed', 'cancelled'].includes(current.status)) return;
        clearTimeout(timer);
        service.off('job', listener);
        resolve(current);
      };
      service.on('job', listener);
    });
    assert.equal(finished.status, 'completed', JSON.stringify(finished.error));
    const edited = store.project().objects[0].modeling;
    assert.equal(edited?.kind, 'mesh');
    if (edited?.kind !== 'mesh') assert.fail('Expected editable mesh');
    assert.deepEqual(edited.identity, identified.identity);
    assert.deepEqual(edited.faces, original.faces);
    edited.vertices.forEach((vertex, index) => {
      assert.ok(Math.abs(vertex[0] - original.vertices[index][0] - 0.02) < 1e-12);
      assert.ok(Math.abs(vertex[1] - original.vertices[index][1]) < 1e-12);
      assert.ok(Math.abs(vertex[2] - original.vertices[index][2]) < 1e-12);
    });
    assert.deepEqual(store.travel(-1).objects, source.objects);
    assert.deepEqual(store.travel(1).objects[0].modeling, edited);
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
