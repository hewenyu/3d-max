import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { Store } from '../server/store';
import { prepareDirectories, type ServerConfig } from '../server/config';
import { exportProjectPackage, importProjectPackage } from '../server/project-packages';
import { saveProjectPackage } from '../server/package-routes';
import type { RenderJob } from '../shared/types';
import { readPackageRecords, encodePackageRecords, type PackageRecord } from '../server/package-codec';

const exec = promisify(execFile);
const zip = promisify(gzip);
const configFor = (directory: string): ServerConfig => ({
  port: 4173,
  dataDir: directory,
  distDir: join(directory, 'dist'),
  appUrl: 'http://127.0.0.1:5173',
  apiUrl: 'http://127.0.0.1:4173',
});

test('portable package restores assets, independent takes, undo/redo and playable videos in clean SQLite storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-package-'));
  const sourceConfig = configFor(join(directory, 'source'));
  const targetConfig = configFor(join(directory, 'target'));
  prepareDirectories(sourceConfig);
  prepareDirectories(targetConfig);
  const source = new Store(sourceConfig.dataDir);
  let target = new Store(targetConfig.dataDir);
  try {
    source.newProject('Portable performance', 'empty');
    const model = Buffer.from(
      JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
    );
    const modelPath = join(sourceConfig.dataDir, 'assets', 'portable-model.gltf');
    await writeFile(modelPath, model);
    source.addAsset({
      id: 'portable-model',
      name: 'Prop.gltf',
      mime: 'model/gltf+json',
      size: model.length,
      url: '/api/assets/portable-model/file',
      path: modelPath,
    });
    source.commands({
      commands: [
        {
          type: 'object.create',
          payload: { type: 'model', id: 'imported-prop', assetUrl: '/api/assets/portable-model/file' },
        },
        { type: 'object.create', payload: { type: 'actor', id: 'performer' } },
        { type: 'actor.clip.set', payload: { id: 'performer', clip: { action: 'punch', start: 0, end: 1 } } },
        { type: 'production.initialize', payload: {} },
      ],
    });
    const state = source.project();
    source.commands({
      commands: [
        {
          type: 'performance.duplicate',
          payload: {
            sceneId: state.production!.activeSceneId,
            id: state.production!.activePerformanceId,
            newId: 'take-two',
            name: 'Alternate',
          },
        },
      ],
    });
    source.commands({ commands: [{ type: 'project.update', payload: { name: 'Saved cut' } }] });
    source.commands({ commands: [{ type: 'project.update', payload: { name: 'Future cut' } }] });
    source.travel(-1);
    const current = source.project();
    const videoPath = join(sourceConfig.dataDir, 'renders', 'packaged-video.mp4');
    await exec('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1280x720:r=24:d=1,noise=alls=100:allf=t',
      '-c:v',
      'libx264',
      '-crf',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      videoPath,
    ]);
    assert.ok((await readFile(videoPath)).length > 8 * 1024 * 1024);
    const job: RenderJob = {
      id: 'packaged-video',
      name: 'Portable performance / Alternate cut',
      status: 'completed',
      progress: 1,
      frame: 24,
      totalFrames: 24,
      projectRevision: current.revision,
      createdAt: new Date().toISOString(),
      options: { projectId: current.id, fps: 24, resolution: 720 },
      url: '/api/renders/packaged-video/file',
    };
    source.addJob(job, current);
    const pendingArchive = exportProjectPackage(source, sourceConfig, { includeVideos: true });
    source.commands({
      commands: [{ type: 'project.update', payload: { name: 'Concurrent edit after export began' } }],
    });
    const archive = await pendingArchive;
    assert.equal(archive.assets, 1);
    assert.equal(archive.videos, 1);
    const restored = await importProjectPackage(target, targetConfig, archive.data);
    assert.notEqual(restored.project.id, current.id);
    assert.equal(restored.project.name, 'Saved cut');
    assert.equal(restored.project.production!.scenes[0]!.performances.length, 2);
    assert.deepEqual(target.history(), { canUndo: true, canRedo: true });
    assert.deepEqual(await readFile(target.asset('portable-model')!.path), model);
    assert.ok(target.asset('portable-model')!.path.startsWith(targetConfig.dataDir));
    const video = target.jobs().find((item) => item.status === 'completed')!;
    assert.notEqual(video.id, job.id);
    assert.equal(video.name, job.name);
    assert.deepEqual(
      await readFile(join(targetConfig.dataDir, 'renders', `${video.id}.mp4`)),
      await readFile(videoPath),
    );
    assert.equal(target.jobProject(video.id).id, restored.project.id);
    target.close();
    target = new Store(targetConfig.dataDir);
    assert.equal(target.project().id, restored.project.id);
    assert.equal(target.travel(1).name, 'Future cut');
    assert.equal(target.travel(-1).name, 'Saved cut');
    const again = await importProjectPackage(target, targetConfig, archive.data);
    assert.notEqual(again.project.id, restored.project.id);
    assert.equal(
      (target.db.prepare('SELECT count(*) AS count FROM assets').get() as { count: number }).count,
      1,
    );
    const exportRecord = await saveProjectPackage(target, targetConfig, { includeVideos: false });
    assert.ok(exportRecord.size > 100);
    assert.ok(target.db.prepare('SELECT 1 FROM project_packages WHERE id=?').get(exportRecord.id));
  } finally {
    source.close();
    target.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt assets and missing references roll package import back without orphan files or partial projects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-package-invalid-'));
  const config = configFor(directory);
  prepareDirectories(config);
  const store = new Store(directory);
  try {
    const before = store.project();
    const archive = await exportProjectPackage(store, config, {});
    const manifest = {
      format: 'whiteframe-project',
      version: 1,
      createdAt: new Date().toISOString(),
      project: structuredClone(before),
      cursor: 0,
      history: [{ position: 0, snapshot: structuredClone(before) }],
      assets: [] as unknown[],
      jobs: [],
    };
    manifest.assets = [
      {
        id: 'corrupt-model',
        name: 'Bad.gltf',
        extension: '.gltf',
        mime: 'model/gltf+json',
        size: 1,
        url: '/api/assets/corrupt-model/file',
        file: { data: 'YQ==', sha256: '0'.repeat(64) },
      },
    ];
    await assert.rejects(
      importProjectPackage(store, config, await zip(Buffer.from(JSON.stringify(manifest)))),
      /checksum mismatch/,
    );
    assert.deepEqual(store.project(), before);
    assert.deepEqual(await readdir(join(directory, 'assets')), []);
    manifest.assets = [];
    manifest.project.objects[0].assetUrl = '/api/assets/missing/file';
    await assert.rejects(
      importProjectPackage(store, config, await zip(Buffer.from(JSON.stringify(manifest)))),
      /unavailable local asset/,
    );
    assert.deepEqual(store.project(), before);
    assert.equal(store.projects().length, 1);
    const records: PackageRecord[] = [];
    for await (const record of readPackageRecords(archive.data)) records.push(record);
    async function* damaged() {
      for (const record of records) if (record.type !== 'end') yield record;
      const model = Buffer.from(
        JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
      );
      yield {
        type: 'asset' as const,
        value: {
          id: 'rollback-model',
          name: 'Rollback.gltf',
          extension: '.gltf' as const,
          mime: 'model/gltf+json',
          size: model.length,
          url: '/api/assets/rollback-model/file',
          file: { data: model.toString('base64'), sha256: createHash('sha256').update(model).digest('hex') },
        },
      };
    }
    await assert.rejects(
      importProjectPackage(store, config, await encodePackageRecords(damaged())),
      /incomplete/,
    );
    assert.deepEqual(store.project(), before);
    assert.deepEqual(await readdir(join(directory, 'assets')), []);
    const validLegacy = { ...manifest, project: before, history: [{ position: 0, snapshot: before }] };
    const restored = await importProjectPackage(
      store,
      config,
      await zip(Buffer.from(JSON.stringify(validLegacy))),
    );
    assert.equal(restored.project.name, before.name);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
