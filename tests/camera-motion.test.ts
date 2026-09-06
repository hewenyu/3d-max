import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createDemoProject, createObject } from '../shared/project';
import { applyCommands } from '../shared/commands';
import { sampleCamera, sampleObject } from '../shared/timeline';

test('dolly creates editable source-time keys and preserves keys outside its range', () => {
  const project = createDemoProject();
  const before = project.cameras.find((camera) => camera.id === 'camera-reaction')!;
  const first = sampleCamera(before, 4);
  const { project: updated } = applyCommands(project, [
    {
      type: 'camera.motion',
      payload: {
        id: before.id,
        motion: 'dolly_in',
        start: 4,
        end: 6,
        distance: 0.5,
      },
    },
  ]);
  const camera = updated.cameras.find((c) => c.id === before.id)!;
  assert.equal(camera.keyframes.find((k) => k.id === 'reaction-start')?.time, 3.5);
  assert.equal(camera.keyframes.find((k) => k.id === 'reaction-end')?.time, 7);
  const final = sampleCamera(camera, 6);
  assert.ok(Math.abs(new Vector3(...first.position).distanceTo(new Vector3(...final.position)) - 0.5) < 1e-9);
  assert.deepEqual(final.target, first.target);
  assert.deepEqual(
    project.cameras.find((c) => c.id === before.id),
    before,
  );
});

test('orbit maintains radius and follow tracks animated subject in a transformed parent', () => {
  const project = createDemoProject();
  const baseCamera = project.cameras[0];
  const orbit = applyCommands(project, [
    {
      type: 'camera.motion',
      payload: {
        id: baseCamera.id,
        motion: 'orbit',
        start: 0,
        end: 2,
        angle: 90,
        easing: 'linear',
      },
    },
  ]).project.cameras[0];
  const radius = new Vector3(...baseCamera.position).distanceTo(new Vector3(...baseCamera.target));
  for (const key of orbit.keyframes)
    assert.ok(Math.abs(new Vector3(...key.position).distanceTo(new Vector3(...key.target)) - radius) < 1e-9);
  const group = createObject('group');
  group.position = [3, 0, 1];
  group.rotation = [0, 90, 0];
  project.objects.push(group);
  project.objects.find((object) => object.id === 'actor-a')!.parentId = group.id;
  const follow = applyCommands(project, [
    {
      type: 'camera.motion',
      payload: {
        id: baseCamera.id,
        motion: 'follow',
        start: 0,
        end: 2.2,
        subjectId: 'actor-a',
      },
    },
  ]).project.cameras[0];
  const keys = follow.keyframes;
  const initialOffset = new Vector3(...keys[0].position).sub(new Vector3(...keys[0].target));
  for (const key of keys)
    assert.ok(new Vector3(...key.position).sub(new Vector3(...key.target)).distanceTo(initialOffset) < 1e-9);
  const a = sampleObject(
    project.objects.find((object) => object.id === 'actor-a')!,
    2.2,
  );
  const finalTarget = keys.at(-1)!.target;
  assert.ok(Math.abs(finalTarget[0] - (3 + a.position[2])) < 1e-9);
  assert.ok(Math.abs(finalTarget[2] - (1 - a.position[0])) < 1e-9);
});

test('camera motion rejects invalid subjects and respects shot locks atomically', () => {
  const project = createDemoProject();
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'camera.motion', payload: { id: 'camera-wide', motion: 'follow', start: 0, end: 2 } },
      ]),
    /主体/,
  );
  assert.throws(
    () =>
      applyCommands(project, [
        {
          type: 'camera.motion',
          payload: { id: 'camera-wide', motion: 'follow', start: 2, end: 1, subjectId: 'actor-a' },
        },
      ]),
    /结束时间/,
  );
  project.shots[0].locked = true;
  const before = structuredClone(project);
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'project.update', payload: { name: 'Invalid' } },
        { type: 'camera.motion', payload: { id: 'camera-wide', motion: 'pan', start: 0, end: 2 } },
      ]),
    /locked/,
  );
  assert.deepEqual(project, before);
});
