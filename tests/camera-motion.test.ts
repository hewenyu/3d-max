import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Vector3 } from 'three';
import { createDemoProject, createObject } from '../shared/project';
import { applyCommands } from '../shared/commands';
import { sampleCamera, sampleObject } from '../shared/timeline';
import { attachedCameraFixture } from './fixtures/camera-prop';
import { ContinuityScene } from '../shared/continuity-scene';
import { createCameraSubjectSampler } from '../shared/camera-subject';

test('prop follow samples constrained hands and handover under moving transformed parents deterministically', () => {
  const project = attachedCameraFixture();
  const commands = [
    {
      type: 'camera.motion' as const,
      payload: { id: 'prop-camera', motion: 'follow', start: 0, end: 3, subjectId: 'handover-prop' },
    },
  ];
  const first = applyCommands(project, commands).project.cameras[0].keyframes;
  const again = applyCommands(project, commands).project.cameras[0].keyframes;
  const values = (keys: typeof first) => keys.map(({ id: _id, ...value }) => value);
  assert.deepEqual(values(first), values(again));
  const scene = new ContinuityScene(project, 'test');
  try {
    const offset = new Vector3(...first[0].position).sub(new Vector3(...first[0].target));
    for (const key of first) {
      const { sampled, contacts } = scene.sampleTransforms(key.time);
      const prop = sampled.get('handover-prop')!;
      assert.equal(prop.attachment!.objectId, key.time < 1.5 ? 'giver' : 'receiver');
      const root = scene.objects.get('handover-prop')!.root;
      assert.ok(new Vector3(...key.target).distanceTo(root.getWorldPosition(new Vector3())) < 1e-9);
      assert.ok(new Vector3(...key.position).sub(new Vector3(...key.target)).distanceTo(offset) < 1e-9);
      const contact = contacts.get(prop.attachment!.objectId)![0];
      assert.equal(contact.reached, true, JSON.stringify(contact));
      assert.ok(new Vector3(...key.target).distanceTo(new Vector3(...contact.target!)) < 0.002);
    }
  } finally {
    scene.dispose();
  }
  assert.deepEqual(project.cameras[0].keyframes, []);
});

test('mounted prop follow retains camera pose in the constrained subject frame through a handover', () => {
  const project = attachedCameraFixture();
  const scene = new ContinuityScene(project, 'test');
  const camera = project.cameras[0];
  const keys = applyCommands(project, [
    {
      type: 'camera.motion',
      payload: {
        id: camera.id,
        motion: 'follow',
        start: 0,
        end: 3,
        subjectId: 'handover-prop',
        rotateWithSubject: true,
      },
    },
  ]).project.cameras[0].keyframes;
  try {
    scene.sampleTransforms(0);
    const inverse = scene.objects.get('handover-prop')!.root.matrixWorld.clone().invert();
    const position = new Vector3(...camera.position).applyMatrix4(inverse);
    const target = new Vector3(...camera.target).applyMatrix4(inverse);
    for (const key of [...keys].reverse()) {
      scene.sampleTransforms(key.time);
      const transform = scene.objects.get('handover-prop')!.root.matrixWorld;
      assert.ok(new Vector3(...key.position).distanceTo(position.clone().applyMatrix4(transform)) < 1e-8);
      assert.ok(new Vector3(...key.target).distanceTo(target.clone().applyMatrix4(transform)) < 1e-8);
    }
  } finally {
    scene.dispose();
  }
});

test('rig sampling handles a child of an attached object and does not depend on seek order', () => {
  const project = attachedCameraFixture();
  const child = createObject('box');
  child.parentId = 'handover-prop';
  child.position = [0.1, 0.2, 0.3];
  child.rotation = [10, 20, 30];
  project.objects.push(child);
  const sampler = createCameraSubjectSampler(project, child.id);
  const scene = new ContinuityScene(project, 'test');
  try {
    const expected = new Map<number, Matrix4>();
    for (const time of [0, 1, 1.5, 2, 3]) expected.set(time, sampler.matrix(time));
    for (const time of [3, 0, 2, 1.5, 1]) {
      assert.deepEqual(sampler.matrix(time).elements, expected.get(time)!.elements);
      scene.sampleTransforms(time);
      assert.deepEqual(sampler.matrix(time).elements, scene.objects.get(child.id)!.root.matrixWorld.elements);
    }
  } finally {
    sampler.dispose();
    scene.dispose();
  }
});

test('non-frame-aligned handover and detach events retain exact source times in editable keys', () => {
  const project = attachedCameraFixture();
  const prop = project.objects.find((object) => object.id === 'handover-prop')!;
  prop.keyframes[0].time = 1.513;
  prop.keyframes.push({ id: 'detach', time: 2.713, attachment: null, position: [3, 1, 0] });
  const camera = applyCommands(project, [
    {
      type: 'camera.motion',
      payload: { id: 'prop-camera', motion: 'follow', start: 0, end: 3, subjectId: prop.id },
    },
  ]).project.cameras[0];
  for (const time of [1.513, 2.713]) expectEvent(time);
  function expectEvent(time: number) {
    const key = camera.keyframes.find((frame) => frame.time === time)!;
    assert.equal(key.easing, 'step');
    const subject = createCameraSubjectSampler(project, prop.id);
    try {
      assert.ok(new Vector3(...sampleCamera(camera, time).target).distanceTo(subject.position(time)) < 1e-9);
    } finally {
      subject.dispose();
    }
  }
});

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

test('mounted follow keeps cockpit camera position and aim attached while the subject turns', () => {
  const project = createDemoProject();
  const vehicle = createObject('box');
  vehicle.id = 'turning-car';
  vehicle.keyframes = [{ id: 'turn', time: 2, position: [10, 0, 0], rotation: [0, 90, 0], easing: 'linear' }];
  project.objects.push(vehicle);
  const camera = project.cameras[0]!;
  camera.position = [0, 1, 0];
  camera.target = [0, 1, 10];
  camera.keyframes = [];
  const updated = applyCommands(project, [
    {
      type: 'camera.motion',
      payload: {
        id: camera.id,
        motion: 'follow',
        subjectId: vehicle.id,
        rotateWithSubject: true,
        start: 0,
        end: 2,
        easing: 'linear',
      },
    },
  ]).project;
  const final = sampleCamera(updated.cameras[0]!, 2);
  assert.ok(new Vector3(...final.position).distanceTo(new Vector3(10, 1, 0)) < 1e-8);
  assert.ok(new Vector3(...final.target).distanceTo(new Vector3(20, 1, 0)) < 1e-8);
  assert.deepEqual(project.cameras[0]!.keyframes, []);
});
