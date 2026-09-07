import assert from 'node:assert/strict';
import test from 'node:test';
import { actorAnimationSchema } from '../shared/actor-animation';
import { applyCommands } from '../shared/commands';
import { motionPathSchema } from '../shared/motion';
import { createEmptyProject, createObject } from '../shared/project';
import {
  duplicatePerformance,
  ensureProduction,
  selectProduction,
  syncProduction,
} from '../shared/production';
import {
  resolveTimingMember,
  timingAnchor,
  timingMembers,
  type SynchronizationProject,
  type TimingReference,
} from '../shared/synchronization';
import type { Command } from '../shared/types';

function fixture(): SynchronizationProject {
  const project: SynchronizationProject = createEmptyProject('Timing test');
  const actor = { ...createObject('actor', 'Actor'), id: 'actor' };
  actor.keyframes = [{ id: 'key', time: 5, position: [1, 0, 0] }];
  actor.actor!.animation = actorAnimationSchema.parse({
    clips: [{ id: 'action', action: 'gesture', start: 4, end: 6, sourceOffset: 0.4 }],
    constraints: [
      {
        id: 'contact',
        effector: 'leftHand',
        start: 4.4,
        end: 5.2,
        target: { kind: 'world', position: [0, 1, 0] },
      },
    ],
    jointKeys: [{ id: 'joint', time: 4.5, joint: 'head', rotation: [0, 20, 0] }],
  });
  actor.motionEvents = [
    { id: 'event', time: 5.5, kind: 'impact', position: [0, 0, 0], strength: 1, duration: 0.2 },
  ];
  actor.motion = motionPathSchema.parse({
    points: [{ position: [0, 0, 0] }, { position: [1, 0, 0] }],
    start: 4,
    speed: [{ duration: 3, fromSpeed: 1, toSpeed: 1, easing: 'constant' }],
  });
  const effect = { ...createObject('sphere', 'Impact'), id: 'impact' };
  effect.effect = { kind: 'impact', start: 5.5, duration: 0.5, radius: 1 };
  project.objects.push(actor, effect);
  project.beats = [
    {
      id: 'line',
      label: 'Dialogue',
      time: 2,
      endTime: 4,
      kind: 'dialogue',
      actorId: actor.id,
      text: 'Go',
      notes: '',
      locked: false,
    },
  ];
  project.audio = [
    {
      id: 'voice',
      name: 'Dialogue audio',
      url: '/assets/voice.wav',
      start: 2.1,
      sourceIn: 0.5,
      duration: 1.5,
      volume: 1,
      muted: false,
      locked: false,
      sync: 'source',
    },
  ];
  return applyCommands(project, [
    {
      type: 'sync.group.set',
      payload: {
        group: {
          id: 'linked',
          name: 'Dialogue and reaction',
          members: timingMembers(project).map((m) => m.reference),
        },
      },
    },
  ]).project;
}

function command(project: SynchronizationProject, type: string, payload: Record<string, unknown>) {
  return applyCommands(project, [{ type, payload }]).project as SynchronizationProject;
}
const reference = (kind: TimingReference['kind'], id: string): TimingReference =>
  ({
    kind,
    id,
    objectId: kind === 'beat' || kind === 'audio' ? undefined : 'actor',
    anchor: 'start',
  }) as TimingReference;
const timeOf = (project: SynchronizationProject, ref: TimingReference) =>
  timingAnchor(resolveTimingMember(project, ref)!);

test('moving dialogue shifts all nine kinds of timed content while preserving durations and audio trim', () => {
  const before = fixture();
  const after = command(before, 'beat.update', { id: 'line', patch: { time: 5, endTime: 7 } });
  assert.equal(timingMembers(before).length, 9);
  for (const member of timingMembers(before)) {
    const moved = resolveTimingMember(after, member.reference)!;
    assert.ok(Math.abs(moved.start - member.start - 3) < 1e-8, member.label);
    assert.ok(Math.abs(moved.end - member.end - 3) < 1e-8, member.label);
  }
  assert.equal(after.audio[0]!.sourceIn, 0.5);
  assert.equal(after.objects[0]!.actor!.animation!.clips[0]!.sourceOffset, 0.4);
  assert.equal(before.beats[0]!.time, 2);
});

test('dialogue end anchors shift reaction and sound when a line is extended without moving its start', () => {
  const project = fixture();
  project.synchronization![0]!.members[0]!.anchor = 'end';
  const after = command(project, 'beat.update', { id: 'line', patch: { endTime: 6.5 } });
  assert.equal(after.beats[0]!.time, 2);
  assert.equal(after.beats[0]!.endTime, 6.5);
  assert.equal(after.objects[0]!.actor!.animation!.clips[0]!.start, 6.5);
  assert.equal(after.objects[0]!.actor!.animation!.clips[0]!.end, 8.5);
  assert.equal(after.audio[0]!.start, 4.6);
  const unchanged = command(fixture(), 'beat.update', { id: 'line', patch: { endTime: 6.5 } });
  assert.equal(unchanged.audio[0]!.start, 2.1);
});

test('audio duration and action endpoint edits are bidirectional anchor drivers', () => {
  let project = fixture();
  project.synchronization![0]!.members.find((item) => item.kind === 'audio')!.anchor = 'end';
  project = command(project, 'audio.update', { id: 'voice', patch: { duration: 2.5 } });
  assert.ok(Math.abs(project.beats[0]!.time - 3) < 1e-8);
  assert.equal(project.audio[0]!.start, 2.1);
  const clip = project.objects[0]!.actor!.animation!.clips[0]!;
  project = command(project, 'actor.clip.set', {
    id: 'actor',
    clip: { ...clip, start: clip.start + 2, end: clip.end + 2 },
  });
  assert.ok(Math.abs(project.beats[0]!.time - 5) < 1e-8);
  assert.equal(project.audio[0]!.start, 4.1);
});

test('linked object, audio, group and take locks reject the entire transaction', () => {
  const assertLocked = (project: SynchronizationProject) => {
    const snapshot = structuredClone(project);
    assert.throws(
      () => command(project, 'beat.update', { id: 'line', patch: { time: 4, endTime: 6 } }),
      /locked/i,
    );
    assert.deepEqual(project, snapshot);
  };
  const actorLocked = fixture();
  actorLocked.objects[0]!.locked = true;
  assertLocked(actorLocked);
  const audioLocked = fixture();
  audioLocked.audio[0]!.locked = true;
  assertLocked(audioLocked);
  const groupLocked = fixture();
  groupLocked.synchronization![0]!.locked = true;
  assertLocked(groupLocked);
  const takeLocked = fixture();
  const production = ensureProduction(takeLocked);
  production.scenes[0]!.performances[0]!.locked = true;
  assertLocked(takeLocked);
});

test('incompatible explicit member edits in one batch fail atomically while consistent edits succeed', () => {
  const project = fixture();
  const snapshot = structuredClone(project);
  const commands: Command[] = [
    { type: 'beat.update', payload: { id: 'line', patch: { time: 4, endTime: 6 } } },
    { type: 'audio.update', payload: { id: 'voice', patch: { start: 5.1 } } },
  ];
  assert.throws(() => applyCommands(project, commands), /Conflicting explicit timing/);
  assert.deepEqual(project, snapshot);
  commands[1]!.payload.patch = { start: 4.1 };
  const after = applyCommands(project, commands).project;
  assert.equal(after.beats[0]!.time, 4);
  assert.equal(after.audio[0]!.start, 4.1);
});

test('conflicting edits to multiple linked clips in one actor replacement fail before partial propagation', () => {
  const project = fixture();
  const animation = structuredClone(project.objects[0]!.actor!.animation!);
  animation.clips[0]!.start += 2;
  animation.clips[0]!.end += 2;
  animation.constraints[0]!.start += 3;
  animation.constraints[0]!.end += 3;
  assert.throws(
    () => command(project, 'actor.animation.set', { id: 'actor', animation }),
    /Conflicting timing/,
  );
  assert.equal(project.beats[0]!.time, 2);
});

test('unlinking an item or group preserves timing and permits independent edits and deletion', () => {
  let project = fixture();
  const audioBefore = structuredClone(project.audio[0]!);
  project = command(project, 'sync.member.remove', { id: 'linked', member: { kind: 'audio', id: 'voice' } });
  assert.deepEqual(project.audio[0], audioBefore);
  project = command(project, 'beat.update', { id: 'line', patch: { time: 4, endTime: 6 } });
  assert.deepEqual(project.audio[0], audioBefore);
  assert.throws(() => command(project, 'object.delete', { id: 'actor' }), /Unlink/);
  project = command(project, 'sync.group.delete', { id: 'linked' });
  const objects = structuredClone(project.objects);
  project = command(project, 'beat.update', { id: 'line', patch: { time: 5, endTime: 7 } });
  assert.deepEqual(project.objects, objects);
  project = command(project, 'object.delete', { id: 'actor' });
  assert.equal(project.objects.length, 1);
});

test('group moves retain offsets, reject negative dependent starts and validate member ownership and clock', () => {
  let project = fixture();
  project = command(project, 'sync.group.move', { id: 'linked', time: 10 });
  assert.equal(project.beats[0]!.time, 10);
  assert.equal(project.audio[0]!.start, 10.1);
  project.synchronization![0]!.members[0]!.anchor = 'end';
  assert.throws(() => command(project, 'sync.group.move', { id: 'linked', time: 0 }), /outside/);
  assert.throws(
    () => command(project, 'audio.update', { id: 'voice', patch: { sync: 'sequence' } }),
    /source-time audio/,
  );
  assert.throws(
    () =>
      command(project, 'sync.group.set', {
        group: { name: 'Duplicate', members: project.synchronization![0]!.members },
      }),
    /multiple groups/,
  );
  assert.throws(() => command(project, 'sync.group.set', { group: { name: 'Empty', members: [] } }));
});

test('independent performance copies retain their own links, anchor settings and synchronized timing', () => {
  const project = fixture();
  const state = ensureProduction(project);
  const first = state.activePerformanceId;
  const sceneId = state.activeSceneId;
  const second = duplicatePerformance(project, sceneId, first, 'Second take');
  selectProduction(project, sceneId, second.id);
  let edited = command(project, 'beat.update', { id: 'line', patch: { time: 5, endTime: 7 } });
  edited = command(edited, 'sync.member.remove', { id: 'linked', member: { kind: 'audio', id: 'voice' } });
  syncProduction(edited);
  selectProduction(edited, sceneId, first);
  assert.equal(edited.beats[0]!.time, 2);
  assert.equal(edited.synchronization![0]!.members.length, 9);
  selectProduction(edited, sceneId, second.id);
  assert.equal(edited.beats[0]!.time, 5);
  assert.equal(edited.synchronization![0]!.members.length, 8);
  assert.equal(timeOf(edited, reference('actor-clip', 'action')), 7);
});
