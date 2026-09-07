import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { RenderJob } from '../shared/types';

test('completed MP4 streams support seek ranges while downloads remain attachments', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), '.whiteframe-stream-'));
  const config = {
    port: 0,
    dataDir,
    distDir: join(dataDir, 'dist'),
    appUrl: 'http://127.0.0.1:5173',
    apiUrl: 'http://127.0.0.1:4173',
    token: 'stream-test',
  };
  const service = createApp(config);
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  config.apiUrl = base;
  const bytes = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const project = service.store.project();
  const job: RenderJob = {
    id: 'stream-fixture',
    status: 'completed',
    progress: 1,
    frame: 24,
    totalFrames: 24,
    projectRevision: project.revision,
    createdAt: new Date().toISOString(),
    options: {},
    url: '/api/renders/stream-fixture/file',
  };
  service.store.addJob(job, project);
  service.store.addJob({ ...job, id: 'not-finished', status: 'queued' }, project);
  service.store.addJob({ ...job, id: 'missing-file' }, project);
  await writeFile(join(dataDir, 'renders', `${job.id}.mp4`), bytes);
  try {
    const stream = `${base}/api/renders/${job.id}/stream`;
    const full = await fetch(stream);
    assert.equal(full.status, 200);
    assert.match(full.headers.get('content-type')!, /^video\/mp4/);
    assert.match(full.headers.get('content-disposition')!, /^inline;/);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const head = await fetch(stream, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const [range, start, end] of [
      ['bytes=4-11', 4, 11],
      ['bytes=20-', 20, 35],
      ['bytes=-5', 31, 35],
    ] as const) {
      const partial = await fetch(stream, { headers: { Range: range } });
      assert.equal(partial.status, 206);
      assert.equal(partial.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(start, end + 1));
    }
    const outside = await fetch(stream, { headers: { Range: 'bytes=999-1000' } });
    assert.equal(outside.status, 416);
    assert.equal(outside.headers.get('content-range'), `bytes */${bytes.length}`);
    assert.equal((await outside.json()).error.code, 'RANGE_NOT_SATISFIABLE');
    const download = await fetch(`${base}${job.url}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    await download.arrayBuffer();
    assert.equal((await fetch(`${base}/api/renders/not-finished/stream`)).status, 409);
    assert.equal((await fetch(`${base}/api/renders/missing-file/stream`)).status, 404);
    assert.equal((await fetch(`${base}/api/renders/unknown/stream`)).status, 404);
  } finally {
    await service.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
