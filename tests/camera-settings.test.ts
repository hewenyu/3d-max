import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommands } from '../shared/commands';
import { createDemoProject } from '../shared/project';
import { sampleTimeline } from '../shared/timeline';
import type { CameraOptics } from '../shared/camera-optics';

test('independent portrait edits and camera motion do not change landscape keys or pose', () => {
  let project = createDemoProject();
  const camera = project.cameras[0]!;
  const original = structuredClone(camera);
  project = applyCommands(project, [
    {
      type: 'camera.composition.set',
      payload: {
        id: camera.id,
        aspect: '9:16',
        composition: { position: [3, 4, 9], target: [0, 1, 0], fov: 30, keyframes: [] },
      },
    },
    {
      type: 'camera.keyframe.set',
      payload: {
        id: camera.id,
        aspect: '9:16',
        keyframe: {
          id: 'portrait-key',
          time: 1,
          position: [3, 4, 8],
          target: [0, 1, 0],
          fov: 32,
          easing: 'linear',
        },
      },
    },
    { type: 'project.settings', payload: { aspect: '9:16' } },
  ]).project;
  assert.deepEqual(sampleTimeline(project, 1).camera!.position, [3, 4, 8]);
  project = applyCommands(project, [
    {
      type: 'camera.motion',
      payload: { id: camera.id, aspect: '9:16', motion: 'dolly_in', start: 1, end: 2, distance: 1 },
    },
  ]).project;
  const { compositions, ...base } = project.cameras[0]!;
  assert.deepEqual(base, original);
  assert.ok(compositions!['9:16']!.keyframes.length >= 25);
  project = applyCommands(project, [
    { type: 'camera.composition.delete', payload: { id: camera.id, aspect: '9:16' } },
  ]).project;
  assert.deepEqual(project.cameras[0]!.keyframes, original.keyframes);
  assert.throws(
    () =>
      applyCommands(project, [
        {
          type: 'camera.keyframe.delete',
          payload: { id: camera.id, aspect: '9:16', keyframeId: 'portrait-key' },
        },
      ]),
    /Create the 9:16 composition/,
  );
});

test('optical focus is independent of camera aim, validates shot targets and respects locks', () => {
  let project = createDemoProject();
  const camera = project.cameras[0]!;
  const optics: CameraOptics = {
    enabled: true,
    focusDistance: 2,
    fStop: 2,
    sensorWidthMm: 36,
    focusTargetId: null,
    keyframes: [],
  };
  project = applyCommands(project, [
    { type: 'camera.optics.set', payload: { id: camera.id, optics } },
    {
      type: 'camera.optics.keyframe.set',
      payload: {
        id: camera.id,
        keyframe: { id: 'pull', time: 2, focusDistance: 6, fStop: 4, easing: 'linear' },
      },
    },
  ]).project;
  const sampled = sampleTimeline(project, 1).camera!;
  assert.equal(sampled.optics!.focusDistance, 4);
  assert.equal(sampled.optics!.fStop, 3);
  assert.deepEqual(project.cameras[0]!.target, camera.target);
  assert.throws(
    () =>
      applyCommands(project, [
        {
          type: 'camera.optics.set',
          payload: { id: camera.id, optics: { ...optics, focusTargetId: 'missing' } },
        },
      ]),
    /Missing focus target/,
  );
  project = applyCommands(project, [
    { type: 'shot.update', payload: { id: project.shots[0]!.id, patch: { locked: true } } },
  ]).project;
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'camera.optics.keyframe.delete', payload: { id: camera.id, keyframeId: 'pull' } },
      ]),
    { code: 'LOCKED' },
  );
});
