import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createEmptyProject, createObject } from '../shared/project';
import { prepareDirectories, type ServerConfig } from '../server/config';
import { encodePackageRecords, type PackageRecord } from '../server/package-codec';
import { importProjectPackage } from '../server/project-packages';
import { Store, type AssetRecord } from '../server/store';

const modelBytes = (label: string) =>
  Buffer.from(
    JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, extras: { label } }),
  );

async function archiveFor(label: string) {
  const project = createEmptyProject(label);
  const assets = [
    { id: `exclusive-${label}`, bytes: modelBytes(`exclusive-${label}`) },
    { id: 'concurrent-shared', bytes: modelBytes(label) },
  ];
  project.objects = assets.map(({ id }) => ({
    ...createObject('model'),
    assetUrl: `/api/assets/${id}/file`,
  }));
  async function* records(): AsyncGenerator<PackageRecord> {
    yield {
      type: 'header',
      value: { format: 'whiteframe-project', createdAt: project.updatedAt, project, cursor: 0 },
    };
    yield { type: 'history', value: { position: 0, snapshot: project } };
    for (const { id, bytes } of assets)
      yield {
        type: 'asset',
        value: {
          id,
          name: `${id}.gltf`,
          extension: '.gltf',
          mime: 'model/gltf+json',
          size: bytes.length,
          url: `/api/assets/${id}/file`,
          file: { data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') },
        },
      };
    yield { type: 'end', history: 1, assets: assets.length, jobs: 0 };
  }
  return encodePackageRecords(records());
}

async function storesForTest() {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-package-concurrent-'));
  const config: ServerConfig = {
    dataDir: directory,
    distDir: join(directory, 'dist'),
    port: 4173,
    apiUrl: 'http://127.0.0.1:4173',
    appUrl: 'http://127.0.0.1:5173',
  };
  prepareDirectories(config);
  const stores = [new Store(directory), new Store(directory)];
  return {
    config,
    stores,
    async close() {
      for (const store of stores) store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function assertNoOrphans(store: Store, directory: string) {
  const assets = store.db
    .prepare('SELECT metadata FROM assets')
    .all()
    .map((row) => JSON.parse(String(row.metadata)) as AssetRecord);
  assert.deepEqual(
    (await readdir(join(directory, 'assets'))).sort(),
    assets.map((asset) => basename(asset.path)).sort(),
  );
  return assets;
}

test('concurrent restoration of the same package shares committed assets and removes duplicate staged files', async (t) => {
  const fixture = await storesForTest();
  try {
    const data = await archiveFor('same');
    const missing = new Set<number>();
    fixture.stores.forEach((store, index) => {
      const original = store.asset.bind(store);
      t.mock.method(store, 'asset', (id: string) => {
        const value = original(id);
        if (id === 'concurrent-shared' && !value) missing.add(index);
        return value;
      });
    });
    const results = await Promise.all(
      fixture.stores.map((store) => importProjectPackage(store, fixture.config, data)),
    );
    assert.equal(missing.size, 2, 'both imports must have staged the shared asset before either committed');
    assert.notEqual(results[0].project.id, results[1].project.id);
    assert.equal(fixture.stores[0].projects().length, 3);
    const assets = await assertNoOrphans(fixture.stores[0], fixture.config.dataDir);
    assert.equal(assets.length, 2);
    assert.deepEqual(await readFile(fixture.stores[0].asset('concurrent-shared')!.path), modelBytes('same'));
  } finally {
    await fixture.close();
  }
});

test('concurrent packages with different bytes under the same asset ID reject and roll back the losing project and exclusive asset', async (t) => {
  const fixture = await storesForTest();
  try {
    const archives = await Promise.all(['left', 'right'].map(archiveFor));
    const missing = new Set<number>();
    fixture.stores.forEach((store, index) => {
      const original = store.asset.bind(store);
      t.mock.method(store, 'asset', (id: string) => {
        const value = original(id);
        if (id === 'concurrent-shared' && !value) missing.add(index);
        return value;
      });
    });
    const outcomes = await Promise.allSettled(
      fixture.stores.map((store, index) => importProjectPackage(store, fixture.config, archives[index])),
    );
    assert.equal(missing.size, 2, 'both packages must pass the pre-transaction missing-asset check');
    const completed = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(completed.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'ASSET_CONFLICT');
    const winner = completed[0].value.project;
    const loser = winner.name === 'left' ? 'right' : 'left';
    const store = fixture.stores[0];
    assert.equal(store.projects().length, 2);
    assert.equal(store.project().id, winner.id);
    assert.equal(store.asset(`exclusive-${loser}`), undefined);
    assert.deepEqual(await readFile(store.asset('concurrent-shared')!.path), modelBytes(winner.name));
    assert.equal((await assertNoOrphans(store, fixture.config.dataDir)).length, 2);
    assert.equal(store.db.prepare('SELECT count(DISTINCT project_id) AS count FROM history').get()!.count, 2);
    assert.equal(store.jobs().length, 0);
  } finally {
    await fixture.close();
  }
});
