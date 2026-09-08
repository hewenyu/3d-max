import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store';
import { prepareDirectories } from '../server/config';
import { errorBody, errorStatus } from '../server/errors';
import { inspectMesh } from '../server/modeling-service';
import { planModelConversion } from '../server/modeling-assets';
import { exportProjectPackage, importProjectPackage } from '../server/project-packages';
import {
  getModelingJobService,
  inspectMeshInWorker,
  planModelConversionInWorker,
  exportModelAssetInWorker,
} from '../server/modeling-job-access';

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'whiteframe-legacy-modeling-'));
  const config = {
    dataDir,
    distDir: dataDir,
    port: 0,
    appUrl: 'http://localhost',
    apiUrl: 'http://localhost',
  };
  prepareDirectories(config);
  const store = new Store(dataDir);
  store.newProject('Legacy modeling workers', 'empty');
  store.commands({ commands: [{ type: 'object.create', payload: { id: 'box', type: 'box' } }] });
  const service = getModelingJobService(store, config);
  const guard = () => {
    const project = store.project();
    return {
      projectId: project.id,
      expectedRevision: project.revision,
      expectedContext: {
        sceneId: project.production?.activeSceneId ?? null,
        performanceId: project.production?.activePerformanceId ?? null,
      },
    };
  };
  return {
    store,
    config,
    service,
    guard,
    close: async () => {
      await service.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('legacy inspect, conversion and export return compatible results from persisted workers', async () => {
  const f = await fixture();
  try {
    const inspection = {
      ...f.guard(),
      objectId: 'box',
      stage: 'evaluated',
      kind: 'edge',
      offset: 1,
      limit: 3,
    };
    assert.deepEqual(
      await inspectMeshInWorker(f.store, f.config, inspection),
      inspectMesh(f.store, inspection),
    );
    const exported = await exportModelAssetInWorker(f.store, f.config, { ...f.guard(), scope: 'scene' });
    assert.equal(exported.triangles, 12);
    assert.ok(f.store.asset(exported.id));
    f.store.commands({
      commands: [
        { type: 'object.create', payload: { id: 'imported', type: 'model', assetUrl: exported.url } },
      ],
    });
    const conversion = { ...f.guard(), objectId: 'imported' };
    assert.deepEqual(
      await planModelConversionInWorker(f.store, f.config, conversion),
      await planModelConversion(f.store, conversion),
    );
    const jobs = f.service.list();
    assert.deepEqual(jobs.map((job) => job.kind).sort(), ['conversion', 'export', 'inspect']);
    assert.ok(jobs.every((job) => job.status === 'completed' && /^[0-9a-f-]{36}$/.test(job.requestId)));
    assert.equal(f.service.listenerCount('job'), 0);
  } finally {
    await f.close();
  }
});

test('legacy wrappers validate the source schema before creating jobs and preserve existing guard errors', async () => {
  const f = await fixture();
  try {
    const assertError = (run: () => unknown, code: string, status: number) =>
      assert.throws(
        run,
        (error: unknown) => errorBody(error).error.code === code && errorStatus(error) === status,
      );
    assertError(
      () =>
        planModelConversionInWorker(f.store, f.config, {
          ...f.guard(),
          objectId: 'box',
          requestId: 'injected',
        }),
      'VALIDATION_ERROR',
      400,
    );
    assertError(
      () => exportModelAssetInWorker(f.store, f.config, { ...f.guard(), scope: 'scene', kind: 'export' }),
      'VALIDATION_ERROR',
      400,
    );
    assertError(
      () =>
        inspectMeshInWorker(f.store, f.config, { ...f.guard(), objectId: 'box', componentKind: 'vertex' }),
      'VALIDATION_ERROR',
      400,
    );
    assertError(
      () => inspectMeshInWorker(f.store, f.config, { ...f.guard(), expectedRevision: 0, objectId: 'box' }),
      'REVISION_MISMATCH',
      409,
    );
    assertError(
      () =>
        exportModelAssetInWorker(f.store, f.config, { ...f.guard(), expectedRevision: 0, scope: 'scene' }),
      'REVISION_MISMATCH',
      409,
    );
    assert.equal(f.service.list().length, 0);
    assert.equal(f.service.listenerCount('job'), 0);
  } finally {
    await f.close();
  }
});

test('legacy worker failures preserve HTTP status and diagnostics while removing wait listeners', async () => {
  const f = await fixture();
  try {
    f.store.commands({
      commands: [{ type: 'object.update', payload: { id: 'box', patch: { visible: false } } }],
    });
    await assert.rejects(
      exportModelAssetInWorker(f.store, f.config, { ...f.guard(), scope: 'scene' }),
      (error: unknown) => {
        assert.equal(errorStatus(error), 422);
        assert.equal(errorBody(error).error.code, 'EMPTY_EXPORT');
        assert.deepEqual(errorBody(error).error.details, { hiddenObjectIds: ['box'] });
        return true;
      },
    );
    await assert.rejects(
      planModelConversionInWorker(f.store, f.config, { ...f.guard(), objectId: 'missing' }),
      (error: unknown) => errorStatus(error) === 404 && errorBody(error).error.code === 'NOT_FOUND',
    );
    assert.deepEqual(
      f.service
        .list()
        .map((job) => job.error?.status)
        .sort(),
      [404, 422],
    );
    assert.equal(f.service.listenerCount('job'), 0);
  } finally {
    await f.close();
  }
});

test('converted meshes retain the original GLB in history-free packages and after clean-store restart', async () => {
  const f = await fixture();
  const targetDir = await mkdtemp(join(tmpdir(), 'whiteframe-converted-package-'));
  const targetConfig = { ...f.config, dataDir: targetDir, distDir: targetDir };
  prepareDirectories(targetConfig);
  let target = new Store(targetDir);
  try {
    const source = await exportModelAssetInWorker(f.store, f.config, { ...f.guard(), scope: 'scene' });
    const original = await readFile(f.store.asset(source.id)!.path);
    f.store.commands({
      commands: [{ type: 'object.create', payload: { id: 'imported', type: 'model', assetUrl: source.url } }],
    });
    const plan = await planModelConversionInWorker(f.store, f.config, { ...f.guard(), objectId: 'imported' });
    f.store.commands({ commands: [{ type: 'mesh.set', payload: { id: 'imported', mesh: plan.mesh } }] });
    const converted = f.store.project().objects.find((object) => object.id === 'imported')!;
    assert.equal(converted.assetUrl, undefined);
    assert.equal(converted.sourceAssetUrl, source.url);
    const archive = await exportProjectPackage(f.store, f.config, {
      includeHistory: false,
      includeVideos: false,
    });
    assert.equal(archive.assets, 1, 'sourceAssetUrl alone must retain the original binary');
    const restored = await importProjectPackage(target, targetConfig, archive.data);
    assert.deepEqual(
      restored.project.objects.find((object) => object.id === 'imported'),
      converted,
    );
    assert.deepEqual(await readFile(target.asset(source.id)!.path), original);
    target.close();
    target = new Store(targetDir);
    assert.deepEqual(
      target.project().objects.find((object) => object.id === 'imported'),
      converted,
    );
    assert.deepEqual(await readFile(target.asset(source.id)!.path), original);
    const repacked = await exportProjectPackage(target, targetConfig, {
      includeHistory: false,
      includeVideos: false,
    });
    assert.equal(repacked.assets, 1);
  } finally {
    await f.close();
    target.close();
    await rm(targetDir, { recursive: true, force: true });
  }
});
