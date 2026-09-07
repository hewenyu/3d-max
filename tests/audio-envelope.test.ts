import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCommands } from '../shared/commands';
import { createEmptyProject } from '../shared/project';
import { audioEnvelope, audioGain } from '../shared/audio-envelope';
import { audioArguments, audioSegments, type AudioSegment } from '../server/audio';
import type { Store } from '../server/store';
import type { AudioClip } from '../shared/types';

const sound: AudioClip = {
  id: 'voice',
  name: 'Voice',
  url: '/voice.wav',
  start: 0,
  sourceIn: 1,
  duration: 4,
  volume: 1.5,
  muted: false,
  locked: false,
  sync: 'source',
  fadeIn: 2,
  fadeOut: 2,
  fadeCurve: 'linear',
};
const close = (a: number, b: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('audio fade envelopes preserve boost, silence bounds and equal-power crossfade energy', () => {
  close(audioGain(sound, 0), 0);
  close(audioGain(sound, 1), 0.75);
  close(audioGain(sound, 2), 1.5);
  close(audioGain(sound, 3), 0.75);
  close(audioGain(sound, 4), 0);
  close(audioGain({ ...sound, muted: true }, 2), 0);
  const incoming = { ...sound, fadeIn: 2, fadeOut: 0, fadeCurve: 'equalPower' as const };
  const outgoing = { ...sound, fadeIn: 0, fadeOut: 2, fadeCurve: 'equalPower' as const };
  for (let time = 0; time <= 2; time += 0.125)
    close(audioEnvelope(incoming, time) ** 2 + audioEnvelope(outgoing, time + 2) ** 2, 1);
});

test('fade edits validate against clip duration and reject invalid batches atomically', () => {
  const project = applyCommands(createEmptyProject(), [
    { type: 'audio.create', payload: { ...sound } },
  ]).project;
  const original = structuredClone(project);
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'project.update', payload: { name: 'Invalid transaction' } },
        { type: 'audio.update', payload: { id: 'voice', patch: { duration: 1 } } },
      ]),
    /fade-in exceeds/,
  );
  assert.deepEqual(project, original);
  const trimmed = applyCommands(project, [
    {
      type: 'audio.update',
      payload: { id: 'voice', patch: { sourceIn: 2, duration: 1, fadeIn: 0.5, fadeOut: 0.5 } },
    },
  ]).project;
  assert.equal(trimmed.audio[0]!.sourceIn, 2);
  assert.equal(trimmed.audio[0]!.fadeIn, 0.5);
});

test('real FFmpeg fade processing retains phase across cuts, source trim and time stretching', () => {
  const directory = mkdtempSync(join(tmpdir(), 'whiteframe-audio-envelope-'));
  const path = join(directory, 'reference.wav');
  try {
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.25:s=48000:d=6',
      '-c:a',
      'pcm_f32le',
      '-y',
      path,
    ]);
    const initial = createEmptyProject();
    const project = applyCommands(initial, [
      { type: 'audio.create', payload: { ...sound } },
      { type: 'camera.create', payload: { id: 'camera' } },
      { type: 'shot.create', payload: { id: 'a', cameraId: 'camera', sourceIn: 0, sourceOut: 2 } },
      { type: 'shot.create', payload: { id: 'b', cameraId: 'camera', sourceIn: 2, sourceOut: 4 } },
      {
        type: 'sequence.update',
        payload: {
          id: initial.activeSequenceId,
          patch: {
            clips: [
              { id: 'a-edit', shotId: 'a', sourceIn: 0, sourceOut: 2 },
              { id: 'b-edit', shotId: 'b', sourceIn: 2, sourceOut: 4 },
            ],
          },
        },
      },
    ]).project;
    const store = { assetByUrl: () => ({ path, mime: 'audio/wav', duration: 6 }) } as unknown as Pick<
      Store,
      'assetByUrl'
    >;
    const segments = audioSegments(project, { includeAudio: true }, 4, store);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments[0]!.fade, segments[1]!.fade);
    const decode = (items: AudioSegment[], duration: number) => {
      const args = audioArguments(items, duration);
      return execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `color=size=16x16:duration=${duration}:rate=24`,
          ...args.inputs,
          '-filter_complex',
          args.filters.join(';'),
          '-map',
          '[audio]',
          '-ac',
          '1',
          '-ar',
          '48000',
          '-f',
          'f32le',
          'pipe:1',
        ],
        { maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
      );
    };
    const samples = decode(segments, 4);
    assert.equal(samples.length / 4, 192000);
    for (const time of [0.1, 0.5, 1, 1.99, 2.01, 3, 3.9])
      close(samples.readFloatLE(Math.round(time * 48000) * 4), 0.25 * audioGain(sound, time), 0.0001);
    const stretched = decode([{ ...segments[0]!, duration: 4, rate: 0.5 }], 8);
    for (const time of [1, 2, 3, 4.5, 6])
      close(stretched.readFloatLE(Math.round(time * 48000) * 4), 0.25 * audioGain(sound, time * 0.5), 0.015);
    const equal = decode(
      [{ ...segments[0]!, duration: 4, fade: { ...segments[0]!.fade!, curve: 'equalPower' } }],
      4,
    );
    close(equal.readFloatLE(48000 * 4), 0.25 * audioGain({ ...sound, fadeCurve: 'equalPower' }, 1), 0.0001);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
