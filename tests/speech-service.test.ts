import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store';
import { synthesizeSpeech } from '../server/speech-service';
import { createSpeechRuntime, type SpeechRuntime } from '../server/speech-runtime';
import { speechRequestSchema } from '../shared/speech';
import type { Project } from '../shared/types';

const requestFor = (project: Project, requestId = 'speech-once') => ({
  engine: 'say' as const,
  voice: 'Tingting',
  text: '请等一下，我们从这里开始。',
  rate: 180,
  start: 1.25,
  actorId: 'speaker',
  projectId: project.id,
  expectedRevision: project.revision,
  requestId,
});
const output = { bytes: Buffer.from('Test-only speech runtime bytes'), duration: 2.75 };
const fakeRuntime = (synthesize: SpeechRuntime['synthesize']): SpeechRuntime => ({
  synthesize,
  catalog: async () => {
    throw new Error('Unused in service-only test');
  },
});
async function workspace() {
  const dataDir = await mkdtemp(join(tmpdir(), 'whiteframe-speech-test-'));
  await mkdir(join(dataDir, 'assets'));
  const store = new Store(dataDir);
  store.newProject('Speech integration', 'empty');
  store.commands({ commands: [{ type: 'object.create', payload: { id: 'speaker', type: 'actor' } }] });
  return {
    dataDir,
    store,
    close: async () => {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('speech atomically arranges real-duration dialogue, linked audio and history; parallel and durable retries reuse one asset', async () => {
  const work = await workspace();
  let calls = 0;
  const runtime = fakeRuntime(async () => {
    calls++;
    return output;
  });
  try {
    work.store.commands({ commands: [{ type: 'production.initialize', payload: {} }] });
    const initial = work.store.project();
    const sceneId = initial.production!.activeSceneId;
    const takeId = initial.production!.activePerformanceId;
    work.store.commands({
      commands: [
        {
          type: 'performance.duplicate',
          payload: { sceneId, id: takeId, newId: 'speech-take', name: 'Speech take' },
        },
      ],
    });
    const before = work.store.project();
    const request = requestFor(before);
    const [result, replay] = await Promise.all([
      synthesizeSpeech(work.store, work, request, runtime),
      synthesizeSpeech(work.store, work, request, runtime),
    ]);
    assert.equal(calls, 1);
    assert.equal(replay.replayed, true);
    assert.equal(result.project.revision, before.revision + 1);
    assert.equal(result.project.audio.length, 1);
    assert.equal(result.project.audio[0].duration, output.duration);
    assert.equal(result.project.audio[0].sync, 'source');
    assert.deepEqual(result.project.beats[0], {
      id: result.speech.beatId,
      label: 'Temporary dialogue',
      kind: 'dialogue',
      text: request.text,
      actorId: 'speaker',
      time: 1.25,
      endTime: 4,
      locked: false,
      notes: '',
    });
    assert.equal(result.project.synchronization?.[0].members.length, 2);
    assert.equal(
      result.project.production!.scenes[0].performances.find((take) => take.id === takeId)!.audio.length,
      0,
    );
    const asset = work.store.asset(result.speech.assetId)!;
    assert.equal(asset.duration, output.duration);
    assert.deepEqual(await readFile(asset.path), output.bytes);
    await assert.rejects(synthesizeSpeech(work.store, work, { ...request, text: 'Changed' }, runtime), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const persisted = new Store(work.dataDir);
    try {
      const again = await synthesizeSpeech(persisted, work, request, runtime);
      assert.equal(again.replayed, true);
      assert.deepEqual(again.speech, result.speech);
      assert.equal(calls, 1);
    } finally {
      persisted.close();
    }
    const undone = work.store.travel(-1, { projectId: before.id, expectedRevision: result.project.revision });
    assert.equal(undone.audio.length, 0);
    assert.equal(undone.beats.length, 0);
    assert.deepEqual(await readFile(asset.path), output.bytes);
    const redone = work.store.travel(1, { projectId: before.id, expectedRevision: undone.revision });
    assert.equal(redone.audio[0].url, asset.url);
    const shifted = work.store.commands({
      commands: [
        { type: 'beat.update', payload: { id: result.speech.beatId, patch: { time: 2.25, endTime: 5 } } },
      ],
    }).project;
    assert.equal(shifted.audio[0].start, 2.25);
  } finally {
    await work.close();
  }
});

test('two Store instances replay the committed speech without deleting its file', async () => {
  const work = await workspace();
  const second = new Store(work.dataDir);
  const runtime = fakeRuntime(async () => output);
  try {
    const request = requestFor(work.store.project());
    const results = await Promise.all([
      synthesizeSpeech(work.store, work, request, runtime),
      synthesizeSpeech(second, work, request, runtime),
    ]);
    assert.equal(results.filter((result) => result.replayed).length, 1);
    assert.deepEqual(results[0].speech, results[1].speech);
    const asset = work.store.asset(results[0].speech.assetId)!;
    assert.deepEqual(await readFile(asset.path), output.bytes);
    assert.equal((await readdir(join(work.dataDir, 'assets'))).length, 1);
    assert.equal(work.store.db.prepare('SELECT COUNT(*) AS n FROM assets').get()!.n, 1);
  } finally {
    second.close();
    await work.close();
  }
});

test('speech rejects stale project/context, locked beats/takes and concurrent edits without orphan files', async () => {
  const work = await workspace();
  let calls = 0;
  let release!: (value: typeof output) => void;
  const runtime = fakeRuntime(() => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  try {
    let project = work.store.project();
    await assert.rejects(
      synthesizeSpeech(work.store, work, { ...requestFor(project), expectedRevision: 0 }, runtime),
      { code: 'REVISION_CONFLICT' },
    );
    await assert.rejects(
      synthesizeSpeech(
        work.store,
        work,
        { ...requestFor(project), expectedContext: { sceneId: 'other', performanceId: null } },
        runtime,
      ),
      { code: 'CONTEXT_CONFLICT' },
    );
    assert.equal(calls, 0);
    const pending = synthesizeSpeech(work.store, work, requestFor(project), runtime);
    await assert.rejects(
      synthesizeSpeech(
        work.store,
        work,
        { ...requestFor(project), text: 'A conflicting in-flight request' },
        runtime,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    work.store.commands({
      commands: [{ type: 'project.update', payload: { name: 'Edited while speaking' } }],
    });
    release(output);
    await assert.rejects(pending, { code: 'REVISION_CONFLICT' });
    assert.equal(work.store.project().audio.length, 0);
    assert.equal((await readdir(join(work.dataDir, 'assets'))).length, 0);
    assert.equal(work.store.db.prepare('SELECT COUNT(*) AS n FROM assets').get()!.n, 0);
    project = work.store.project();
    const switched = synthesizeSpeech(work.store, work, requestFor(project, 'switch'), runtime);
    work.store.newProject('Other', 'empty');
    release(output);
    await assert.rejects(switched, { code: 'PROJECT_CONFLICT' });
    work.store.openProject(project.id);
    work.store.commands({
      commands: [{ type: 'beat.create', payload: { id: 'locked-beat', kind: 'dialogue', locked: true } }],
    });
    project = work.store.project();
    await assert.rejects(
      synthesizeSpeech(
        work.store,
        work,
        { ...requestFor(project, 'locked'), beatId: 'locked-beat' },
        runtime,
      ),
      /locked/i,
    );
    work.store.commands({ commands: [{ type: 'production.initialize', payload: {} }] });
    project = work.store.project();
    work.store.commands({
      commands: [
        {
          type: 'performance.update',
          payload: {
            sceneId: project.production!.activeSceneId,
            id: project.production!.activePerformanceId,
            patch: { locked: true },
          },
        },
      ],
    });
    await assert.rejects(
      synthesizeSpeech(work.store, work, requestFor(work.store.project(), 'locked-take'), runtime),
      /Performance is locked/,
    );
    assert.equal(calls, 2);
    assert.equal((await readdir(join(work.dataDir, 'assets'))).length, 0);
  } finally {
    await work.close();
  }
});

test('missing local speech dependencies are discoverable and reject synthesis; plain text and limits are validated', async () => {
  const runtime = createSpeechRuntime({
    platform: 'linux',
    espeakPath: '/missing/espeak-ng',
    ffmpegPath: '/missing/ffmpeg',
    ffprobePath: '/missing/ffprobe',
  });
  const catalog = await runtime.catalog();
  assert.equal(catalog.available, false);
  assert.equal(catalog.encoding.available, false);
  assert.match(
    catalog.engines.find((engine) => engine.id === 'espeak-ng')!.diagnostic!,
    /WHITEFRAME_ESPEAK_PATH/,
  );
  const request = speechRequestSchema.parse({
    engine: 'espeak-ng',
    voice: 'en',
    text: 'Hello',
    projectId: 'p',
    expectedRevision: 1,
    requestId: 'a',
  });
  await assert.rejects(runtime.synthesize(request), { code: 'TTS_UNAVAILABLE' });
  for (const patch of [
    { text: '[[rate 999]] Hello' },
    { text: '!!!' },
    { text: 'a'.repeat(5001) },
    { rate: 351 },
  ])
    assert.equal(speechRequestSchema.safeParse({ ...request, ...patch }).success, false);
});
