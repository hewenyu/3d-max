import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePackageRecords, readPackageRecords, type PackageRecord } from '../server/package-codec';

test('record streaming round-trips history larger than the JavaScript single-string limit', async () => {
  const payload = 'x'.repeat(1024 * 1024);
  const history = 520;
  async function* records(): AsyncGenerator<PackageRecord> {
    yield {
      type: 'header',
      value: { format: 'whiteframe-project', createdAt: new Date().toISOString(), project: {}, cursor: 519 },
    };
    for (let position = 0; position < history; position++)
      yield { type: 'history', value: { position, snapshot: { payload } } };
    yield { type: 'end', history, assets: 0, jobs: 0 };
  }
  const bytes = await encodePackageRecords(records());
  let count = 0;
  for await (const record of readPackageRecords(bytes)) {
    if (record.type === 'history') {
      assert.equal(record.value.position, count++);
      assert.equal((record.value.snapshot as { payload: string }).payload.length, payload.length);
    }
  }
  assert.equal(count, history);
});

test('record framing rejects missing records, trailing records and truncated gzip streams', async () => {
  const header: PackageRecord = {
    type: 'header',
    value: { format: 'whiteframe-project', createdAt: new Date().toISOString(), project: {}, cursor: 0 },
  };
  const history: PackageRecord = { type: 'history', value: { position: 0, snapshot: {} } };
  const end: PackageRecord = { type: 'end', history: 1, assets: 0, jobs: 0 };
  const encode = (values: PackageRecord[]) =>
    encodePackageRecords(
      (async function* () {
        yield* values;
      })(),
    );
  const read = async (bytes: Buffer) => {
    for await (const _record of readPackageRecords(bytes)) {
      /* exhaust validation */
    }
  };
  await assert.rejects(read(await encode([header, end])), /counts do not match/);
  await assert.rejects(read(await encode([header, history, end, history])), /record order/);
  await assert.rejects(read(await encode([header, history])), /incomplete/);
  const complete = await encode([header, history, end]);
  await assert.rejects(read(complete.subarray(0, complete.length - 8)), /valid Whiteframe/);
});
