import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transferLimits } from '../server/transfer-schema';
import { exportProjectPackage } from '../server/project-packages';
import { ApiError } from '../server/errors';
import {
  chunkInput,
  digest,
  largeModel,
  smallModel,
  stage,
  transferFixture,
  transferInput,
} from './fixtures/transfers';

test('chunk sessions enforce browser byte limits, stable requests and bounded unfinished storage', async () => {
  const fixture = await transferFixture();
  try {
    const { service } = fixture;
    const options = transferInput(smallModel);
    const initial = await service.begin(options);
    assert.equal((await service.begin(options)).id, initial.id);
    await assert.rejects(service.begin({ ...options, name: 'other.gltf' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(service.begin({ ...transferInput(smallModel), name: 'bad.exe' }), {
      code: 'UNSUPPORTED_ASSET',
    });
    await assert.rejects(
      service.begin({ ...transferInput(smallModel), size: transferLimits.assetBytes + 1 }),
      { code: 'TRANSFER_TOO_LARGE' },
    );
    await assert.rejects(
      service.begin({
        ...transferInput(smallModel, 'project-package'),
        size: transferLimits.packageBytes + 1,
      }),
    );
    const maximumAsset = await service.begin({
      ...transferInput(smallModel),
      size: transferLimits.assetBytes,
    });
    assert.equal(maximumAsset.totalChunks, 100);
    await service.cancel(initial.id);
    await service.cancel(maximumAsset.id);
    for (let index = 0; index < 4; index++) {
      const transfer = await service.begin({
        ...transferInput(smallModel, 'project-package'),
        size: transferLimits.packageBytes,
      });
      assert.equal(transfer.totalChunks, 512);
    }
    await assert.rejects(service.begin(transferInput(smallModel)), { code: 'TRANSFER_QUOTA' });
    for (const transfer of service.list()) await service.cancel(transfer.id);
    for (let index = 0; index < transferLimits.activeTransfers; index++)
      await service.begin(transferInput(smallModel));
    await assert.rejects(service.begin(transferInput(smallModel)), { code: 'TRANSFER_QUOTA' });
  } finally {
    await fixture.close();
  }
});

test('out-of-order uploads resume after a real Store restart and repeated commits import once', async () => {
  const fixture = await transferFixture();
  try {
    const bytes = largeModel(2 * transferLimits.chunkBytes);
    const options = transferInput(bytes, 'asset', 'resume.glb');
    const initial = await fixture.service.begin(options);
    await fixture.service.chunk(chunkInput(initial.id, bytes, 2));
    await fixture.service.chunk(chunkInput(initial.id, bytes, 0));
    assert.deepEqual(fixture.service.status(initial.id).missingChunks, [1]);
    await assert.rejects(fixture.service.commit(initial.id), { code: 'TRANSFER_INCOMPLETE' });
    fixture.restart();
    assert.equal((await fixture.service.begin(options)).id, initial.id);
    assert.deepEqual(fixture.service.status(initial.id).missingChunks, [1]);
    assert.equal((await fixture.service.chunk(chunkInput(initial.id, bytes, 0))).replayed, true);
    await fixture.service.chunk(chunkInput(initial.id, bytes, 1));
    fixture.store.db.prepare("UPDATE file_transfers SET state='committing' WHERE id=?").run(initial.id);
    fixture.restart();
    assert.equal(fixture.service.status(initial.id).state, 'receiving');
    const [result, duplicate] = await Promise.all([
      fixture.service.commit(initial.id),
      fixture.service.commit(initial.id),
    ]);
    assert.deepEqual(duplicate, result);
    assert.ok('id' in result);
    assert.deepEqual(await readFile(fixture.store.asset(result.id)!.path), bytes);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM assets').get()!.count, 1);
    fixture.restart();
    assert.deepEqual(await fixture.service.commit(initial.id), result);
    assert.equal((await fixture.service.cancel(initial.id)).state, 'completed');
    assert.deepEqual(await readdir(join(fixture.config.dataDir, 'transfers')), []);
  } finally {
    await fixture.close();
  }
});

test('chunk validation, explicit replacements and disk repair retain recoverable progress', async () => {
  const fixture = await transferFixture();
  try {
    const { service, config } = fixture;
    const transfer = await service.begin(transferInput(smallModel));
    const correct = chunkInput(transfer.id, smallModel);
    await assert.rejects(service.chunk({ ...correct, dataBase64: '!!!!' }), { code: 'INVALID_BASE64' });
    await assert.rejects(service.chunk({ ...correct, dataBase64: 'AB==' }), { code: 'INVALID_BASE64' });
    await assert.rejects(service.chunk({ ...correct, sha256: '0'.repeat(64) }), {
      code: 'CHECKSUM_MISMATCH',
    });
    await assert.rejects(service.chunk({ ...correct, index: 1 }), { code: 'INVALID_CHUNK' });
    await assert.rejects(service.chunk(chunkInput(transfer.id, Buffer.from('x'))), { code: 'INVALID_CHUNK' });
    const incorrectBytes = Buffer.from(smallModel);
    incorrectBytes[0] = 0;
    const incorrect = chunkInput(transfer.id, incorrectBytes);
    await service.chunk(incorrect);
    await assert.rejects(service.chunk(correct), { code: 'CHUNK_CONFLICT' });
    await assert.rejects(service.commit(transfer.id), { code: 'CHECKSUM_MISMATCH' });
    assert.equal(service.status(transfer.id).state, 'receiving');
    await assert.rejects(service.chunk({ ...correct, replaceSha256: '0'.repeat(64) }), {
      code: 'CHUNK_CONFLICT',
    });
    await service.chunk({ ...correct, replaceSha256: incorrect.sha256 });
    const path = join(config.dataDir, 'transfers', transfer.id, '0.part');
    await writeFile(path, 'damaged');
    await assert.rejects(service.commit(transfer.id), { code: 'CHECKSUM_MISMATCH' });
    await rm(path);
    await assert.rejects(service.commit(transfer.id), { code: 'TRANSFER_CHUNK_MISSING' });
    assert.equal((await service.chunk(correct)).replayed, true);
    assert.ok('id' in (await service.commit(transfer.id)));
    await assert.rejects(service.chunk(correct), { code: 'TRANSFER_NOT_WRITABLE' });
  } finally {
    await fixture.close();
  }
});

test('asset receipt failures roll back files and metadata, and a retained upload can retry', async () => {
  const fixture = await transferFixture();
  try {
    const { store, service, config } = fixture;
    const id = await stage(service, smallModel);
    store.db.exec(
      "CREATE TRIGGER reject_receipt BEFORE UPDATE OF state ON file_transfers WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
    );
    await assert.rejects(service.commit(id), { code: 'INVALID_ASSET' });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM assets').get()!.count, 0);
    assert.deepEqual(await readdir(join(config.dataDir, 'assets')), []);
    assert.equal(service.status(id).state, 'receiving');
    store.db.exec('DROP TRIGGER reject_receipt');
    assert.ok('id' in (await service.commit(id)));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM assets').get()!.count, 1);
  } finally {
    await fixture.close();
  }
});

test('package receipt rollback preserves the active project, assets and history, with idempotent replay after restart', async () => {
  const source = await transferFixture();
  const target = await transferFixture();
  try {
    const asset = await source.service.commit(await stage(source.service, smallModel));
    assert.ok('id' in asset);
    source.store.commands({
      commands: [{ type: 'object.create', payload: { type: 'model', assetUrl: asset.url } }],
    });
    source.store.commands({ commands: [{ type: 'project.update', payload: { name: 'Packaged history' } }] });
    const archive = await exportProjectPackage(source.store, source.config, { includeHistory: true });
    const before = target.store.project();
    const historyCount = target.store.db.prepare('SELECT COUNT(*) AS count FROM history').get()!.count;
    const id = await stage(target.service, archive.data, 'project-package', 'portable.whiteframe');
    target.store.db.exec(
      "CREATE TRIGGER reject_receipt BEFORE UPDATE OF state ON file_transfers WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
    );
    await assert.rejects(target.service.commit(id), /receipt failure/);
    assert.deepEqual(target.store.project(), before);
    assert.equal(target.store.projects().length, 1);
    assert.equal(target.store.db.prepare('SELECT COUNT(*) AS count FROM history').get()!.count, historyCount);
    assert.equal(target.store.db.prepare('SELECT COUNT(*) AS count FROM assets').get()!.count, 0);
    assert.deepEqual(await readdir(join(target.config.dataDir, 'assets')), []);
    target.store.db.exec('DROP TRIGGER reject_receipt');
    const result = await target.service.commit(id);
    assert.ok('project' in result);
    assert.equal(result.project.name, 'Packaged history');
    const other = target.store.newProject('Keep this project selected', 'empty');
    target.restart();
    assert.deepEqual(await target.service.commit(id), result);
    assert.equal(target.store.project().id, other.id);
    assert.equal(target.store.projects().length, 3);
    assert.equal(target.store.db.prepare('SELECT COUNT(*) AS count FROM assets').get()!.count, 1);
  } finally {
    await source.close();
    await target.close();
  }
});

test('cancellation is repeatable and interrupts a pending commit before publication', async () => {
  const fixture = await transferFixture();
  try {
    const { service, store, config } = fixture;
    const id = await stage(service, smallModel);
    const pending = service.commit(id);
    const rejected = assert.rejects(pending, { code: 'TRANSFER_CANCELLED' });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(service.status(id).state, 'committing');
    assert.equal((await service.cancel(id)).state, 'cancelled');
    await rejected;
    assert.equal((await service.cancel(id)).state, 'cancelled');
    await assert.rejects(service.commit(id), { code: 'TRANSFER_CANCELLED' });
    await assert.rejects(service.chunk(chunkInput(id, smallModel)), { code: 'TRANSFER_CANCELLED' });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM assets').get()!.count, 0);
    assert.deepEqual(await readdir(join(config.dataDir, 'transfers')), []);
    const invalid = Buffer.from('invalid model');
    const invalidId = await stage(service, invalid);
    await assert.rejects(
      service.commit(invalidId),
      (error) => error instanceof ApiError && error.code === 'INVALID_MODEL',
    );
    assert.equal(service.status(invalidId).sha256, digest(invalid));
  } finally {
    await fixture.close();
  }
});
