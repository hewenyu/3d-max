import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCommands, validateProject } from '../shared/commands';
import { createEmptyProject, createObject } from '../shared/project';
import { sampleObject, sampleTimeline, sequenceDuration } from '../shared/timeline';
import {
  cameraToClipTime,
  clipDuration,
  fitRetiming,
  retimingSourceDuration,
  sampleClipTime,
  segmentSourceDuration,
  sourceToClipTime,
  splitClip,
  trimClip,
} from '../shared/time-map';
import type { ClipRetiming, Project, SequenceClip } from '../shared/types';
import { audioArguments, audioSegments } from '../server/audio';
import type { Store } from '../server/store';
import { audioPlacements } from '../shared/audio-plan';
import { ensureProduction, syncProduction } from '../shared/production';

const close = (actual: number, expected: number, epsilon = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`);
const ramp: ClipRetiming = {
  audio: 'mute',
  segments: [
    { duration: 2, fromSpeed: 1, toSpeed: 1, easing: 'constant' },
    { duration: 2, fromSpeed: 1, toSpeed: 0.25, easing: 'smooth' },
    { duration: 4, fromSpeed: 0.25, toSpeed: 0.25, easing: 'constant' },
    { duration: 2, fromSpeed: 0.25, toSpeed: 1, easing: 'smooth' },
    { duration: 2, fromSpeed: 1, toSpeed: 1, easing: 'constant' },
  ],
};
const clip: SequenceClip = {
  id: 'clip',
  shotId: 'shot',
  sourceIn: 10,
  sourceOut: 17.5,
  retiming: ramp,
  cameraTiming: { mode: 'independent', sourceIn: 20, rate: 1 },
};

function projectFor(input: SequenceClip = clip): Project {
  const project = createEmptyProject();
  const actor = {
    ...createObject('actor'),
    id: 'actor',
    keyframes: [
      { id: 'start', time: 10, position: [0, 0, 0] as [number, number, number], action: 'walk' as const },
      { id: 'end', time: 17.5, position: [7.5, 0, 0] as [number, number, number], action: 'idle' as const },
    ],
  };
  project.objects.push(actor);
  project.cameras.push({
    id: 'camera',
    name: 'Camera',
    position: [0, 1, 8],
    target: [0, 1, 0],
    fov: 45,
    locked: false,
    keyframes: [
      { id: 'camera-in', time: 20, position: [0, 1, 8], target: [0, 1, 0], fov: 45, easing: 'linear' },
      { id: 'camera-out', time: 32, position: [12, 1, 8], target: [0, 1, 0], fov: 45, easing: 'linear' },
    ],
  });
  project.shots.push({
    id: 'shot',
    name: 'Shot',
    cameraId: 'camera',
    sourceIn: 0,
    sourceOut: 50,
    subjectIds: ['actor'],
    hiddenIds: [],
    beatId: null,
    intent: '',
    locked: false,
  });
  project.sequences[0]!.clips = [structuredClone(input)];
  return validateProject(project);
}

test('analytic normal-slow-normal ramp maps edit time continuously without duplicated animation samples', () => {
  close(retimingSourceDuration(ramp), 7.5);
  close(clipDuration(clip), 12);
  close(sampleClipTime(clip, 2).sourceTime, 12);
  close(sampleClipTime(clip, 4).sourceTime, 13.25);
  close(sampleClipTime(clip, 8).sourceTime, 14.25);
  close(sampleClipTime(clip, 12).sourceTime, 17.5);
  close(sampleClipTime(clip, 3).playbackRate, 0.625);
  const project = projectFor();
  const values = Array.from({ length: 288 }, (_, frame) => {
    const sample = sampleTimeline(project, frame / 24);
    return sampleObject(project.objects[0]!, sample.sourceTime).position[0];
  });
  assert.ok(values.every((value, index) => index === 0 || value > values[index - 1]!));
  close(values[145]! - values[144]!, 0.25 / 24);
  close(sequenceDuration(project), 12);
});

test('linear and smooth speed ramps integrate to the correct source displacement, including partial ramps', () => {
  const linear = { duration: 2, fromSpeed: 1, toSpeed: 3, easing: 'linear' as const };
  close(segmentSourceDuration(linear), 4);
  close(segmentSourceDuration(linear, 0.5), 1.5);
  const smooth = { ...linear, easing: 'smooth' as const };
  close(segmentSourceDuration(smooth), 4);
  close(segmentSourceDuration(smooth, 0.25), 0.5546875);
  const sub = { ...smooth, duration: 1, curveIn: 0.25, curveOut: 0.75 };
  close(
    segmentSourceDuration(sub),
    segmentSourceDuration(smooth, 0.75) - segmentSourceDuration(smooth, 0.25),
  );
});

test('camera clock advances independently while performance and discrete events slow down', () => {
  const project = projectFor();
  const sample = sampleTimeline(project, 6);
  close(sample.sourceTime, 13.75);
  close(sample.cameraTime, 26);
  close(sample.camera!.position[0], 6);
  close(sample.playbackRate, 0.25);
  assert.equal(sample.audioMuted, true);
  close(cameraToClipTime(clip, 26), 6);
  const sourceSynchronized = { ...clip, cameraTiming: { mode: 'source' as const } };
  close(sampleClipTime(sourceSynchronized, 6).cameraTime, 13.75);
  close(sourceToClipTime(clip, 13.75), 6);
});

test('splitting inside a smooth ramp preserves its exact shape and camera clock on both sides', () => {
  for (const split of [1.5, 2.7, 6, 9.25]) {
    const [left, right] = splitClip(clip, split, 'right');
    close(clipDuration(left) + clipDuration(right), 12);
    close(left.sourceOut, right.sourceIn);
    for (let time = 0; time <= 12; time += 0.03125) {
      const original = sampleClipTime(clip, time);
      const splitSample = time < split ? sampleClipTime(left, time) : sampleClipTime(right, time - split);
      close(splitSample.sourceTime, original.sourceTime);
      close(splitSample.cameraTime, original.cameraTime);
      close(splitSample.playbackRate, original.playbackRate);
    }
    validateProject(projectFor(left));
    validateProject(projectFor(right));
  }
});

test('source trim inverts a nonlinear ramp and repetition maps events to each occurrence', () => {
  const start = sampleClipTime(clip, 2.45).sourceTime;
  const end = sampleClipTime(clip, 9.3).sourceTime;
  const trimmed = trimClip(clip, start, end);
  close(clipDuration(trimmed), 6.85);
  for (let time = 0; time < clipDuration(trimmed); time += 0.1) {
    close(sampleClipTime(trimmed, time).sourceTime, sampleClipTime(clip, time + 2.45).sourceTime);
    close(sampleClipTime(trimmed, time).cameraTime, sampleClipTime(clip, time + 2.45).cameraTime);
  }
  const project = projectFor(trimmed);
  project.sequences[0]!.clips.push({ ...structuredClone(trimmed), id: 'repeat' });
  close(sampleTimeline(project, clipDuration(trimmed) + 1).sourceTime, sampleClipTime(trimmed, 1).sourceTime);
  close(sampleTimeline(project, clipDuration(trimmed)).sourceTime, start);
  assert.throws(() => trimClip(clip, 9, 12), /inside/);
});

test('legacy project imports retain 1x timing while commands expose ramps, trim, split and locks atomically', () => {
  const legacy = { id: 'clip', shotId: 'shot', sourceIn: 10, sourceOut: 17.5 };
  const project = projectFor(legacy);
  assert.equal(project.sequences[0]!.clips[0]!.retiming, undefined);
  close(sequenceDuration(project), 7.5);
  const sequenceId = project.activeSequenceId;
  const output = applyCommands(project, [
    {
      type: 'clip.retime',
      payload: { sequenceId, clipId: 'clip', retiming: ramp, cameraTiming: clip.cameraTiming },
    },
  ]);
  close(sequenceDuration(output.project), 12);
  const split = applyCommands(output.project, [
    { type: 'clip.split', payload: { sequenceId, clipId: 'clip', time: 2.7, rightId: 'right' } },
  ]).project;
  close(sequenceDuration(split), 12);
  assert.equal(split.sequences[0]!.clips.length, 2);
  split.shots[0]!.locked = true;
  assert.throws(
    () =>
      applyCommands(split, [
        { type: 'clip.retime', payload: { sequenceId, clipId: 'right', retiming: null } },
      ]),
    /locked/,
  );
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'object.update', payload: { id: 'actor', patch: { name: 'Should roll back' } } },
        {
          type: 'clip.retime',
          payload: { sequenceId, clipId: 'clip', retiming: { ...ramp, audio: 'follow' } },
        },
      ]),
    /mute/,
  );
  assert.notEqual(project.objects[0]!.name, 'Should roll back');
  const fit = fitRetiming(ramp, 15);
  close(retimingSourceDuration(fit), 15);
  close(
    fit.segments.reduce((sum, segment) => sum + segment.duration, 0),
    24,
  );
});

test('source audio follows exact constant-speed spans and independent sequence audio ignores ramp mute', () => {
  const project = projectFor({
    ...clip,
    sourceOut: 16,
    retiming: {
      audio: 'follow',
      segments: [
        { duration: 2, fromSpeed: 1, toSpeed: 1, easing: 'constant' },
        { duration: 4, fromSpeed: 0.5, toSpeed: 0.5, easing: 'constant' },
        { duration: 2, fromSpeed: 1, toSpeed: 1, easing: 'constant' },
      ],
    },
  });
  project.audio = [
    {
      id: 'voice',
      name: 'Voice',
      url: '/voice.wav',
      start: 11,
      sourceIn: 3,
      duration: 4,
      volume: 1,
      muted: false,
      locked: false,
      sync: 'source',
    },
    {
      id: 'music',
      name: 'Music',
      url: '/music.wav',
      start: 0,
      sourceIn: 0,
      duration: 20,
      volume: 1,
      muted: false,
      locked: false,
      sync: 'sequence',
    },
  ];
  const store = { assetByUrl: (url: string) => ({ path: url, mime: 'audio/wav', duration: 30 }) } as Pick<
    Store,
    'assetByUrl'
  >;
  const segments = audioSegments(project, { includeAudio: true }, 8, store);
  const expected = [
    [3, 1, 1, 1],
    [4, 2, 2, 0.5],
    [6, 1, 6, 1],
    [0, 8, 0, 1],
  ];
  assert.equal(segments.length, expected.length);
  segments.forEach((segment, index) => {
    [segment.sourceStart, segment.duration, segment.start, segment.rate!].forEach((value, field) =>
      close(value, expected[index]![field]!),
    );
  });
  assert.match(audioArguments(segments, 8).filters.join(';'), /atempo=0.5/);
  project.sequences[0]!.clips = [structuredClone(clip)];
  const muted = audioSegments(project, { includeAudio: true }, 12, store);
  assert.equal(muted.length, 1);
  assert.equal(muted[0]!.path, '/music.wav');
  close(muted[0]!.duration, 12);
});

test('audio uses the shot-bound performance and preserves a trimmed speed ramp', () => {
  const project = projectFor({ ...clip, retiming: { ...ramp, audio: 'warp' } });
  const production = ensureProduction(project);
  const scene = production.scenes[0]!;
  const bound = structuredClone(scene.performances[0]!);
  bound.id = 'alternate-audio';
  bound.audio = [
    {
      id: 'voice',
      name: 'Bound take',
      url: '/bound.wav',
      start: 12.4,
      sourceIn: 1,
      duration: 2,
      volume: 1,
      muted: false,
      locked: false,
      sync: 'source',
    },
  ];
  scene.performances.push(bound);
  project.shots[0]!.performanceId = bound.id;
  project.audio = [{ ...bound.audio[0]!, url: '/active.wav' }];
  syncProduction(project);
  const placements = audioPlacements(project, { includeAudio: true }, 12);
  assert.equal(placements.length, 1);
  const placement = placements[0]!;
  assert.equal(placement.audio.url, '/bound.wav');
  assert.equal(placement.warp, true);
  close(placement.start, sourceToClipTime(clip, 12.4));
  close(placement.sourceDuration, 2);
  const trimmed = {
    ...clip,
    sourceIn: 12.4,
    sourceOut: 14.4,
    retiming: { audio: 'warp' as const, segments: placement.segments! },
  };
  for (let time = 0; time < placement.duration; time += 0.1)
    close(sampleClipTime(trimmed, time).sourceTime, sampleClipTime(clip, placement.start + time).sourceTime);
});

test('constant slow-motion audio export preserves pitch and exact duration through actual FFmpeg', () => {
  const directory = mkdtempSync(join(tmpdir(), 'whiteframe-retime-'));
  try {
    const input = join(directory, 'tone.wav');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-y',
      input,
    ]);
    const { inputs, filters } = audioArguments(
      [{ path: input, sourceStart: 0, duration: 1, start: 0, volume: 1, rate: 0.5 }],
      2,
    );
    const output = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=size=16x16:duration=2:rate=24',
        ...inputs,
        '-filter_complex',
        filters.join(';'),
        '-map',
        '[audio]',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-f',
        's16le',
        'pipe:1',
      ],
      { maxBuffer: 1024 * 1024, timeout: 10000 },
    );
    close(output.length / 2 / 48000, 2, 1 / 48000);
    let crossings = 0;
    for (let index = 2; index < output.length; index += 2)
      if (output.readInt16LE(index - 2) <= 0 && output.readInt16LE(index) > 0) crossings++;
    assert.ok(crossings / 2 > 420 && crossings / 2 < 460, `Expected 440Hz, got ${crossings / 2}Hz`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
