import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { BoxGeometry } from 'three';
import { Store } from '../server/store';
import { ModelingJobService } from '../server/modeling-jobs';
import { importAssetFile } from '../server/assets';
import { prepareDirectories, type ServerConfig } from '../server/config';
import type { ModelingJob } from '../shared/modeling-jobs';
import type { ExportedModelAsset, planModelConversion } from '../server/modeling-assets';

const terminal = (job: ModelingJob) => ['completed', 'failed', 'cancelled'].includes(job.status);
function waitFor(service: ModelingJobService, id: string, predicate = terminal): Promise<ModelingJob> {
  const current = service.status(id);
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.off('job', listener);
      reject(new Error(`Asset job timeout: ${JSON.stringify(service.status(id))}`));
    }, 15000);
    const listener = (job: ModelingJob) => {
      if (job.id === id && predicate(job)) {
        clearTimeout(timer);
        service.off('job', listener);
        resolve(service.status(id));
      }
    };
    service.on('job', listener);
  });
}
async function sourceGlb() {
  const document = new Document(),
    buffer = document.createBuffer(),
    geometry = new BoxGeometry(2, 2, 2);
  const primitive = document
    .createPrimitive()
    .setAttribute(
      'POSITION',
      document
        .createAccessor()
        .setType('VEC3')
        .setArray(Float32Array.from(geometry.getAttribute('position').array))
        .setBuffer(buffer),
    )
    .setAttribute(
      'TEXCOORD_0',
      document
        .createAccessor()
        .setType('VEC2')
        .setArray(Float32Array.from(geometry.getAttribute('uv').array))
        .setBuffer(buffer),
    )
    .setIndices(
      document
        .createAccessor()
        .setType('SCALAR')
        .setArray(Uint16Array.from(geometry.index!.array))
        .setBuffer(buffer),
    )
    .setMaterial(document.createMaterial('source').setBaseColorFactor([0.2, 0.7, 0.4, 1]));
  document
    .getRoot()
    .setDefaultScene(
      document
        .createScene()
        .addChild(document.createNode('source').setMesh(document.createMesh().addPrimitive(primitive))),
    );
  geometry.dispose();
  return Buffer.from(await new NodeIO().writeBinary(document));
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-asset-jobs-'));
  const config: ServerConfig = {
    dataDir: directory,
    distDir: directory,
    appUrl: 'http://127.0.0.1:4186',
    apiUrl: 'http://127.0.0.1:4186',
    port: 4186,
  };
  prepareDirectories(config);
  const store = new Store(directory);
  store.newProject('Asset jobs', 'empty');
  const source = await sourceGlb(),
    input = join(directory, 'source.glb');
  await writeFile(input, source);
  const asset = await importAssetFile(store, config, { path: input, name: 'source.glb' });
  store.commands({
    commands: [
      {
        type: 'object.create',
        payload: { id: 'model', type: 'model', assetUrl: asset.url, dimensions: [3, 3, 3] },
      },
      { type: 'object.create', payload: { id: 'box', type: 'box', position: [4, 0, 0] } },
      { type: 'object.create', payload: { id: 'hidden', type: 'box', position: [-4, 0, 0], visible: false } },
    ],
  });
  const service = new ModelingJobService(
    store,
    (checked, publish) => store.commitModelingJob(checked, publish),
    config,
  );
  const request = (requestId: string, kind: 'conversion' | 'export' = 'export') => {
    const project = store.project();
    return {
      projectId: project.id,
      expectedRevision: project.revision,
      expectedContext: {
        sceneId: project.production?.activeSceneId ?? null,
        performanceId: project.production?.activePerformanceId ?? null,
      },
      requestId,
      kind,
      ...(kind === 'conversion' ? { objectId: 'model' } : { scope: 'scene' }),
    };
  };
  const count = () =>
    (store.db.prepare('SELECT COUNT(*) count FROM assets').get() as { count: number }).count;
  return {
    directory,
    config,
    store,
    source,
    asset,
    service,
    request,
    count,
    close: async () => {
      await service.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('conversion worker reads an immutable asset manifest without creating a Store or mutating project history', async () => {
  const f = await fixture();
  try {
    const before = f.store.project(),
      updates: ModelingJob['progress'][] = [];
    f.service.on('job', (job: ModelingJob) => updates.push(job.progress));
    const job = f.service.start(f.request('conversion', 'conversion'));
    const done = await waitFor(f.service, job.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.ok(done.assetSnapshotHash);
    const result = done.result as Awaited<ReturnType<typeof planModelConversion>>;
    assert.equal(result.asset.url, f.asset.url);
    assert.equal(result.asset.sha256, createHash('sha256').update(f.source).digest('hex'));
    assert.equal(result.mesh.vertices.length, 24);
    assert.equal(result.mesh.faces.length, 12);
    assert.ok(result.diagnostics.some((item) => item.attributes?.includes('TEXCOORD_0')));
    assert.ok(updates.some((progress) => progress.asset?.stage === 'reading'));
    assert.ok(
      updates.some((progress) => progress.asset?.stage === 'geometry' && progress.asset.completed === 1),
    );
    assert.deepEqual(f.store.project(), before);
    assert.equal(f.count(), 1);
  } finally {
    await f.close();
  }
});

test('export worker transfers actual GLB bytes and publishes one asset with durable idempotency and honest object progress', async () => {
  const f = await fixture();
  let reopened: ModelingJobService | undefined;
  try {
    const before = f.store.project(),
      progress: ModelingJob['progress'][] = [];
    f.service.on('job', (job: ModelingJob) => {
      progress.push(job.progress);
      if (job.status === 'completed') {
        const stored = f.service.status(job.id).result as ExportedModelAsset;
        assert.ok(f.store.asset(stored.id), 'completion cannot precede asset registration');
      }
    });
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 1);
    const input = f.request('export-replay'),
      job = f.service.start(input);
    assert.equal(f.service.start(input).id, job.id);
    assert.throws(() => f.service.start({ ...input, includeHidden: true }), { code: 'IDEMPOTENCY_CONFLICT' });
    const done = await waitFor(f.service, job.id);
    clearInterval(heartbeat);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.ok(ticks > 2);
    const result = done.result as ExportedModelAsset,
      bytes = await readFile(f.store.asset(result.id)!.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sha256);
    assert.equal(bytes.length, result.bytes);
    assert.deepEqual(result.objectIds, ['model', 'box']);
    assert.deepEqual(result.hiddenObjectIds, ['hidden']);
    const document = await new NodeIO().readBinary(bytes);
    assert.equal(document.getRoot().listMeshes().length, 2);
    assert.ok(
      progress.some(
        (item) => item.asset?.stage === 'geometry' && item.asset.completed === 2 && item.asset.total === 2,
      ),
    );
    assert.ok(progress.some((item) => item.asset?.stage === 'encoding'));
    assert.ok(progress.some((item) => item.phase === 'committing' && item.asset?.stage === 'storing'));
    assert.deepEqual(done.progress.asset, { stage: 'storing', completed: 1, total: 1 });
    assert.equal(f.count(), 2);
    assert.deepEqual(f.store.project(), before);
    await f.service.close();
    reopened = new ModelingJobService(
      f.store,
      (checked, publish) => f.store.commitModelingJob(checked, publish),
      f.config,
    );
    assert.deepEqual(reopened.start(input), done);
    assert.equal(f.count(), 2);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

for (const stage of ['queued', 'starting', 'geometry', 'storing'] as const)
  test(`asset cancellation during ${stage} leaves no partial file or metadata`, async () => {
    const f = await fixture();
    try {
      const before = f.store.project(),
        files = await readdir(join(f.directory, 'assets'));
      let cancellation: Promise<ModelingJob> | undefined;
      f.service.on('job', (job: ModelingJob) => {
        const match =
          stage === 'queued'
            ? job.status === 'queued'
            : job.status === 'running' &&
              (stage === 'starting'
                ? job.progress.phase === 'starting'
                : job.progress.asset?.stage === stage);
        if (match && !cancellation) cancellation = f.service.cancel(job.id);
      });
      const job = f.service.start(f.request(`cancel-${stage}`));
      const done = await waitFor(f.service, job.id);
      await cancellation;
      assert.equal(done.status, 'cancelled');
      assert.equal(f.service.status(job.id).result, undefined);
      assert.equal(f.count(), 1);
      assert.deepEqual((await readdir(join(f.directory, 'assets'))).sort(), files.sort());
      assert.deepEqual(f.store.project(), before);
    } finally {
      await f.close();
    }
  });

test('concurrent edits before asset publication fail without replacing the scene or registering a GLB', async () => {
  const f = await fixture();
  try {
    let edited = false;
    f.service.on('job', (job: ModelingJob) => {
      if (!edited && job.progress.asset?.stage === 'encoding') {
        edited = true;
        f.store.commands({
          commands: [{ type: 'object.update', payload: { id: 'box', patch: { name: 'Intervening edit' } } }],
        });
      }
    });
    const job = f.service.start(f.request('asset-conflict'));
    const done = await waitFor(f.service, job.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'REVISION_MISMATCH');
    assert.equal(f.store.project().objects.find((object) => object.id === 'box')!.name, 'Intervening edit');
    assert.equal(f.count(), 1);
    assert.equal((await readdir(join(f.directory, 'assets'))).length, 1);
  } finally {
    await f.close();
  }
});

test('failed completed-job publication rolls back the asset registration and removes the file', async () => {
  const f = await fixture();
  try {
    f.store.db.exec(
      "CREATE TRIGGER reject_asset_completion BEFORE UPDATE ON modeling_jobs WHEN json_extract(NEW.document,'$.status')='completed' BEGIN SELECT RAISE(ABORT,'forced publication failure'); END;",
    );
    const job = f.service.start(f.request('publication-failure'));
    const done = await waitFor(f.service, job.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.result, undefined);
    assert.equal(f.count(), 1);
    assert.equal((await readdir(join(f.directory, 'assets'))).length, 1);
  } finally {
    await f.close();
  }
});

test('changed stored asset manifests cannot be substituted beneath queued requests', async () => {
  const f = await fixture();
  try {
    const job = f.service.start(f.request('manifest-tamper', 'conversion'));
    f.store.db.prepare('UPDATE modeling_jobs SET assets=? WHERE id=?').run('[]', job.id);
    const done = await waitFor(f.service, job.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'INPUT_DIGEST_MISMATCH');
    assert.equal(done.result, undefined);
    assert.equal(f.count(), 1);
  } finally {
    await f.close();
  }
});
