import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommands, commandDefinitions, DomainError, validateProject } from '../shared/commands';
import { createDemoProject, createEmptyProject, createObject } from '../shared/project';
import { sampleCamera, sampleObject, sampleTimeline, sequenceDuration } from '../shared/timeline';
import type { Command, Project, Sequence, ShotCamera } from '../shared/types';

const command = (type: string, payload: Record<string, unknown>): Command => ({ type, payload });
const execute = (project: Project, type: string, payload: Record<string, unknown>) =>
  applyCommands(project, [command(type, payload)]).project;

test('demo validates, covers a complete 10-second scene, and holds reaction for twelve frames', () => {
  const project = validateProject(createDemoProject());
  assert.equal(sequenceDuration(project), 10);
  assert.equal(project.shots.length, 3);
  const pause = project.beats.find((beat) => beat.kind === 'pause')!;
  const dialogue = project.beats.find((beat) => beat.kind === 'dialogue')!;
  assert.equal(pause.time, dialogue.endTime);
  assert.equal((pause.endTime - pause.time) * project.settings.fps, 12);
  const b = project.objects.find((object) => object.id === 'actor-b')!;
  assert.equal(sampleObject(b, 4.5).actor?.pose.headPitch, 20);
  assert.equal(sampleObject(b, 4.999).actor?.pose.headPitch, 20);
  assert.equal(sampleObject(b, 5.6).actor?.pose.headPitch, 0);
});

test('timeline uses next clip exactly at cuts and maps repeated source intervals correctly', () => {
  const project = createDemoProject();
  assert.equal(sampleTimeline(project, 3.499).shot?.id, 'shot-wide');
  assert.equal(sampleTimeline(project, 3.5).shot?.id, 'shot-reaction');
  assert.equal(sampleTimeline(project, 3.5).sourceTime, 3.5);
  assert.equal(sampleTimeline(project, 100).sourceTime, 10);
  assert.equal(sampleTimeline(project, -10).sourceTime, 0);
  project.sequences[0]!.clips = [
    { id: 'one', shotId: 'shot-reaction', sourceIn: 5, sourceOut: 6 },
    { id: 'two', shotId: 'shot-reaction', sourceIn: 5, sourceOut: 7 },
  ];
  validateProject(project);
  const sample = sampleTimeline(project, 1.5);
  assert.equal(sample.sourceTime, 5.5);
  assert.equal(sample.clipStart, 1);
  assert.equal(sample.duration, 3);
  assert.deepEqual(sample.camera, sampleCamera(project.cameras[1]!, 5.5));
  assert.equal(sampleTimeline(createEmptyProject(), 0).clip, null);
});

test('sparse animation interpolates every component independently and discrete values hold', () => {
  const actor = createObject('actor');
  actor.keyframes = [
    { id: 'position', time: 10, position: [10, 0, 0] },
    { id: 'pose', time: 4, pose: { rightArm: -80 }, action: 'talk' },
    {
      id: 'head',
      time: 6,
      pose: { headPitch: 30 },
      attachment: { objectId: 'mount', bone: 'root', offset: [0, 0, 0] },
    },
    { id: 'detach', time: 8, attachment: null },
  ];
  const original = structuredClone(actor);
  const at2 = sampleObject(actor, 2);
  assert.deepEqual(at2.position, [2, 0, 0]);
  assert.equal(at2.actor!.pose.rightArm, -40);
  assert.equal(at2.actor!.pose.headPitch, 10);
  assert.equal(at2.actor!.action, 'idle');
  assert.equal(sampleObject(actor, 4).actor!.action, 'talk');
  assert.equal(sampleObject(actor, 5).attachment, undefined);
  assert.equal(sampleObject(actor, 6).attachment!.objectId, 'mount');
  assert.equal(sampleObject(actor, 8).attachment, null);
  assert.deepEqual(actor, original);
});

test('easing is applied from the destination keyframe and rotations retain intentional full turns', () => {
  const object = createObject('box');
  object.keyframes = [{ id: 'end', time: 4, position: [4, 0, 0], rotation: [0, 720, 0], easing: 'smooth' }];
  assert.equal(sampleObject(object, 1).position[0], 0.625);
  assert.equal(sampleObject(object, 2).rotation[1], 360);
  object.keyframes[0]!.easing = 'step';
  assert.equal(sampleObject(object, 3.99).position[0], 0);
  assert.equal(sampleObject(object, 4).position[0], 4);
});

test('a failed batch is atomic, including earlier creations and revision', () => {
  const project = createEmptyProject();
  const original = structuredClone(project);
  assert.throws(
    () =>
      applyCommands(project, [
        command('object.create', { type: 'box', id: 'box' }),
        command('object.update', { id: 'box', patch: { parentId: 'missing' } }),
      ]),
    /Missing parent/,
  );
  assert.deepEqual(project, original);
  const output = applyCommands(project, [
    command('object.create', { type: 'box', id: 'box' }),
    command('object.update', { id: 'box', patch: { name: 'Prop' } }),
  ]);
  assert.equal(output.project.revision, 1);
  assert.equal(output.results.length, 2);
  assert.equal((output.results[0] as { name: string }).name, '方块');
  assert.equal(output.project.objects[0]!.name, 'Prop');
});

test('locked entities need explicit separate unlock and locked shot protects camera motion', () => {
  let project = createDemoProject();
  assert.throws(
    () => execute(project, 'object.update', { id: 'floor', patch: { position: [0, 0, 0], locked: false } }),
    (error: unknown) => error instanceof DomainError && error.code === 'LOCKED',
  );
  project = execute(project, 'object.update', { id: 'floor', patch: { locked: false } });
  project = execute(project, 'object.update', { id: 'floor', patch: { name: '地板' } });
  project = execute(project, 'shot.update', { id: 'shot-reaction', patch: { locked: true } });
  assert.throws(
    () => execute(project, 'camera.update', { id: 'camera-reaction', patch: { fov: 50 } }),
    /locked shot/,
  );
  assert.throws(
    () => execute(project, 'camera.keyframe.delete', { id: 'camera-reaction', keyframeId: 'reaction-start' }),
    /locked shot/,
  );
});

test('validation rejects parent cycles, mixed attachment cycles, dangling references, duplicate IDs and invalid numbers', () => {
  const project = createEmptyProject();
  const cycle = [
    command('object.create', { type: 'group', id: 'a', parentId: 'b' }),
    command('object.create', { type: 'group', id: 'b', parentId: 'a' }),
  ];
  assert.throws(() => applyCommands(project, cycle), /cycle/);
  assert.throws(
    () =>
      applyCommands(project, [
        command('object.create', { type: 'box', id: 'a' }),
        command('object.create', { type: 'box', id: 'b', parentId: 'a' }),
        command('object.keyframe.set', {
          id: 'a',
          keyframe: { time: 2, attachment: { objectId: 'b', bone: 'root', offset: [0, 0, 0] } },
        }),
      ]),
    /cycle/,
  );
  assert.throws(
    () => execute(createDemoProject(), 'shot.update', { id: 'shot-wide', patch: { cameraId: 'gone' } }),
    /Missing camera/,
  );
  assert.throws(
    () =>
      applyCommands(project, [
        command('object.create', { type: 'box', id: 'same' }),
        command('camera.create', { id: 'same' }),
      ]),
    /Duplicate entity/,
  );
  assert.throws(() => execute(project, 'object.create', { type: 'box', position: [NaN, 0, 0] }));
  assert.throws(() => execute(project, 'object.create', { type: 'box', scale: [0, 1, 1] }));
  assert.throws(() => execute(project, 'camera.create', { fov: 180 }));
  assert.throws(
    () => execute(project, 'camera.create', { position: [0, 0, 0], target: [0, 0, 0] }),
    /must differ/,
  );
});

test('keyframe replacement uses time or ID and rejects collisions without mutation', () => {
  let project = execute(createEmptyProject(), 'object.create', { type: 'box', id: 'box' });
  project = execute(project, 'object.keyframe.set', {
    id: 'box',
    keyframe: { id: 'k1', time: 1, position: [1, 0, 0] },
  });
  project = execute(project, 'object.keyframe.set', {
    id: 'box',
    keyframe: { time: 1, position: [2, 0, 0] },
  });
  assert.equal(project.objects[0]!.keyframes.length, 1);
  assert.deepEqual(project.objects[0]!.keyframes[0]!.position, [2, 0, 0]);
  project = execute(project, 'object.keyframe.set', { id: 'box', keyframe: { id: 'k2', time: 2 } });
  assert.throws(
    () => execute(project, 'object.keyframe.set', { id: 'box', keyframe: { id: 'k2', time: 1 } }),
    /already exists/,
  );
});

test('deletion cleans references and refuses locked dependents and attached targets', () => {
  const demo = createDemoProject();
  assert.throws(() => execute(demo, 'object.delete', { id: 'actor-b' }), /Detach phone/);
  let project = execute(demo, 'object.delete', { id: 'phone' });
  project = execute(project, 'object.delete', { id: 'actor-b' });
  assert.equal(project.objects.find((object) => object.id === 'actor-a')!.actor!.lookAtId, null);
  assert.deepEqual(project.settings.axisActorIds, ['actor-a']);
  assert.equal(project.beats.find((beat) => beat.id === 'beat-reaction')!.actorId, null);
  assert.equal(project.shots[1]!.subjectIds.length, 0);
  project = execute(demo, 'sequence.update', { id: 'sequence-main', patch: { locked: true } });
  assert.throws(() => execute(project, 'shot.delete', { id: 'shot-wide' }), /locked/);
  project = execute(demo, 'shot.delete', { id: 'shot-wide' });
  assert.equal(project.sequences[0]!.clips.length, 2);
  assert.throws(() => execute(demo, 'camera.delete', { id: 'camera-wide' }), /referenced/);
});

test('sequence duplication isolates shots, camera keyframes and notes while sharing actors', () => {
  const demo = createDemoProject();
  const withNote = execute(demo, 'note.create', { text: '推进慢一些', shotId: 'shot-reaction', time: 4 });
  const result = applyCommands(withNote, [
    command('sequence.duplicate', { id: 'sequence-main', newId: 'alt', name: '方案 B' }),
  ]);
  let project = result.project;
  const duplicate = result.results[0] as Sequence;
  assert.equal(duplicate.id, 'alt');
  assert.equal(project.objects.length, demo.objects.length);
  assert.equal(project.notes.length, 2);
  const shot = project.shots.find((item) => item.id === duplicate.clips[1]!.shotId)!;
  assert.notEqual(shot.id, 'shot-reaction');
  assert.notEqual(shot.cameraId, 'camera-reaction');
  const sourceCamera = project.cameras.find((camera) => camera.id === 'camera-reaction')!;
  const cloneCamera = project.cameras.find((camera) => camera.id === shot.cameraId)!;
  assert.notEqual(sourceCamera.keyframes[0]!.id, cloneCamera.keyframes[0]!.id);
  project = execute(project, 'camera.update', { id: cloneCamera.id, patch: { fov: 60, keyframes: [] } });
  assert.equal(project.cameras.find((camera) => camera.id === 'camera-reaction')!.fov, sourceCamera.fov);
  assert.equal(project.cameras.find((camera) => camera.id === 'camera-reaction')!.keyframes.length, 2);
});

test('hierarchy duplication includes attached props and rewrites internal references', () => {
  const demo = createDemoProject();
  const output = applyCommands(demo, [command('object.duplicate', { id: 'actor-b', newId: 'b-copy' })]);
  const prop = output.project.objects.find((object) => object.attachment?.objectId === 'b-copy');
  assert.ok(prop);
  assert.notEqual(prop.id, 'phone');
  assert.equal(output.project.objects.filter((object) => object.id === 'phone').length, 1);
});

test('grouping preserves local transforms and alignment offsets position animation', () => {
  let project = applyCommands(createEmptyProject(), [
    command('object.create', {
      type: 'box',
      id: 'a',
      position: [1, 0, 0],
      keyframes: [{ id: 'move', time: 1, position: [2, 0, 0] }],
    }),
    command('object.create', { type: 'box', id: 'b', position: [3, 0, 0] }),
    command('object.group', { ids: ['a', 'b'], id: 'group' }),
  ]).project;
  assert.deepEqual(project.objects[0]!.position, [1, 0, 0]);
  assert.equal(project.objects[0]!.parentId, 'group');
  project = execute(project, 'object.align', { ids: ['a', 'b'], axis: 'x', mode: 'center' });
  assert.equal(project.objects[0]!.position[0], 2);
  assert.equal(project.objects[1]!.position[0], 2);
  assert.equal(project.objects[0]!.keyframes[0]!.position![0], 3);
  project = execute(project, 'object.delete', { id: 'group' });
  assert.equal(project.objects.length, 0);
});

test('editing clip ranges preserves shot bounds and last sequence cannot be removed', () => {
  const demo = createDemoProject();
  assert.throws(
    () =>
      execute(demo, 'sequence.update', {
        id: 'sequence-main',
        patch: { clips: [{ id: 'bad', shotId: 'shot-wide', sourceIn: 0, sourceOut: 10 }] },
      }),
    /outside shot/,
  );
  assert.throws(() => execute(demo, 'sequence.delete', { id: 'sequence-main' }), /at least one/);
  const result = applyCommands(demo, [
    command('sequence.create', { id: 'new' }),
    command('sequence.delete', { id: 'sequence-main' }),
  ]);
  assert.equal(result.project.activeSequenceId, 'new');
});

test('all command payloads are strict and project identity cannot be patched', () => {
  assert.equal(new Set(commandDefinitions.map((item) => item.type)).size, commandDefinitions.length);
  assert.throws(() => execute(createEmptyProject(), 'project.update', { revision: 99 }));
  assert.throws(() =>
    execute(createDemoProject(), 'object.update', { id: 'actor-a', patch: { id: 'changed' } }),
  );
  assert.throws(() =>
    execute(createDemoProject(), 'object.update', { id: 'actor-a', patch: { type: 'box' } }),
  );
  assert.throws(() => applyCommands(createEmptyProject(), []));
  assert.throws(
    () =>
      applyCommands(createDemoProject(), [
        command('object.create', { id: 'actor-a', type: 'box' }),
        command('object.delete', { id: 'actor-a' }),
      ]),
    /Duplicate entity/,
  );
});

test('camera sampling holds endpoints and applies smooth motion without changing source', () => {
  const camera: ShotCamera = {
    id: 'camera',
    name: 'Move',
    position: [0, 1, 5],
    target: [0, 1, 0],
    fov: 50,
    locked: false,
    keyframes: [
      { id: 'start', time: 0, position: [0, 1, 5], target: [0, 1, 0], fov: 50, easing: 'linear' },
      { id: 'end', time: 2, position: [2, 1, 3], target: [1, 1, 0], fov: 40, easing: 'smooth' },
    ],
  };
  assert.deepEqual(sampleCamera(camera, 1).position, [1, 1, 4]);
  assert.equal(sampleCamera(camera, 1).fov, 45);
  assert.deepEqual(sampleCamera(camera, 20).position, [2, 1, 3]);
  assert.deepEqual(camera.position, [0, 1, 5]);
});
