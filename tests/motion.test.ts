import assert from 'node:assert/strict';
import test from 'node:test';
import { Group, Vector3 } from 'three';
import { applyCommands, validateProject } from '../shared/commands';
import {
  compilePath,
  motionPathSchema,
  pathClock,
  pathDistance,
  pathDuration,
  quaternionFor,
  sampleMotionPath,
  vehicleSchema,
} from '../shared/motion';
import { createEmptyProject, createObject } from '../shared/project';
import { sampleObject } from '../shared/timeline';
import { sampleClipTime } from '../shared/time-map';
import { VehicleRig } from '../src/engine/VehicleRig';
import { EffectRig } from '../src/engine/EffectRig';

const close = (actual: number, expected: number, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} differs from ${expected}`);
const straight = () =>
  motionPathSchema.parse({
    points: [{ position: [0, 0, 0] }, { position: [0, 0, 20] }],
    speed: [
      { duration: 2, fromSpeed: 4, toSpeed: 4, easing: 'constant' },
      { duration: 2, fromSpeed: 4, toSpeed: 8, easing: 'smooth' },
    ],
  });

test('path speed integrates meters over source time and samples arc-length position', () => {
  const path = straight();
  close(compilePath(path).length, 20);
  close(pathDuration(path), 4);
  close(pathDistance(path), 20);
  close(pathClock(path, 2).distance, 8);
  close(sampleMotionPath(path, 2).position[2], 8, 1e-4);
  close(pathClock(path, 3).speed, 6);
  close(sampleMotionPath(path, 4).position[2], 20);
  const facing = new Vector3(0, 0, 1).applyQuaternion(quaternionFor(sampleMotionPath(path, 2).rotation));
  close(facing.z, 1);
  close(facing.y, 0);
  close(sampleMotionPath(path, 8).speed, 0);
});

test('parallel-transport frames preserve continuous spacecraft orientation around a vertical loop', () => {
  const path = motionPathSchema.parse({
    closed: true,
    lookAhead: 0,
    points: [
      { position: [0, 0, 0] },
      { position: [0, 5, 5] },
      { position: [0, 10, 0] },
      { position: [0, 5, -5] },
    ],
    speed: [{ duration: 8, fromSpeed: 1, toSpeed: 1, easing: 'constant' }],
  });
  const length = compilePath(path).length;
  path.speed[0]!.fromSpeed = path.speed[0]!.toSpeed = length / 8;
  let previous = quaternionFor(sampleMotionPath(path, 0).rotation);
  const first = previous.clone();
  for (let frame = 1; frame <= 480; frame++) {
    const current = quaternionFor(sampleMotionPath(path, frame / 60).rotation);
    assert.ok(Math.abs(previous.dot(current)) > 0.999, `Orientation jumped at frame ${frame}`);
    previous = current;
  }
  assert.ok(Math.abs(first.dot(previous)) > 0.99999);
});

test('shared motion commands fit and bake editable keys while preserving scale and outside-range animation', () => {
  const project = createEmptyProject();
  const object = createObject('box');
  object.id = 'moving';
  object.keyframes = [
    { id: 'scale', time: 3, scale: [2, 2, 2] },
    { id: 'outside', time: 12, position: [2, 0, 0] },
  ];
  project.objects.push(object);
  const path = straight();
  path.start = 2;
  const result = applyCommands(project, [
    { type: 'motion.path.set', payload: { id: object.id, path } },
    { type: 'motion.path.fit', payload: { id: object.id, duration: 8 } },
    { type: 'motion.path.bake', payload: { id: object.id, fps: 24 } },
  ]).project;
  const baked = result.objects[0]!;
  close(pathDistance(baked.motion!), 20);
  close(pathDuration(baked.motion!), 8);
  assert.equal(baked.rotationInterpolation, 'quaternion');
  assert.deepEqual(baked.keyframes.find((frame) => frame.time === 3)?.scale, [2, 2, 2]);
  close(sampleObject(baked, 10).position[2], 20);
  assert.deepEqual(baked.keyframes.find((frame) => frame.id === 'outside')?.position, [2, 0, 0]);
  const trim = {
    id: 'clip',
    shotId: 'shot',
    sourceIn: 2,
    sourceOut: 10,
    retiming: {
      audio: 'mute' as const,
      segments: [{ duration: 32, fromSpeed: 0.25, toSpeed: 0.25, easing: 'constant' as const }],
    },
  };
  const positions = Array.from(
    { length: 768 },
    (_, frame) =>
      sampleObject(baked, sampleClipTime(trim, frame / 24).sourceTime, { render: true }).position[2],
  );
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]!));
  baked.locked = true;
  assert.throws(
    () => applyCommands(result, [{ type: 'motion.path.bake', payload: { id: baked.id } }]),
    /locked/,
  );
  assert.equal(project.objects[0]!.motion, undefined);
});

test('imports and direct object updates enforce path and mutually exclusive geometry invariants', () => {
  const project = createEmptyProject();
  const object = createObject('box');
  project.objects.push(object);
  object.motion = straight();
  object.motion.up = [0, 0, 0];
  assert.throws(() => validateProject(project), /up vector/);
  delete object.motion;
  const bad = straight();
  bad.points[1]!.position = [...bad.points[0]!.position];
  assert.throws(
    () =>
      applyCommands(project, [{ type: 'object.update', payload: { id: object.id, patch: { motion: bad } } }]),
    /distinct/,
  );
  object.vehicle = vehicleSchema.parse({ kind: 'car' });
  object.effect = { kind: 'impact', start: 0, duration: 1, radius: 1 };
  assert.throws(() => validateProject(project), /geometry/);
});

test('render sampling matches the copy-safe API over sparse tracks and preserves caller immutability', () => {
  const actor = createObject('actor');
  actor.rotationInterpolation = 'quaternion';
  actor.keyframes = Array.from({ length: 3000 }, (_, index) => ({
    id: `key-${index}`,
    time: index / 24,
    ...(index % 2
      ? { position: [index / 24, Math.sin(index / 240), 0] as [number, number, number] }
      : { rotation: [0, (index * 0.15) % 360, 0] as [number, number, number] }),
    ...(index % 7 === 0 ? { pose: { headYaw: index % 30 } } : {}),
  }));
  for (const time of [0, 0.001, 1.23, 25.333, 87.7, 160]) {
    const normal = sampleObject(actor, time);
    const fast = sampleObject(actor, time, { render: true });
    assert.deepEqual(fast, normal);
    assert.notEqual(fast.actor, actor.actor);
    assert.notEqual(fast.actor!.pose, actor.actor!.pose);
    assert.equal(fast.keyframes, actor.keyframes);
    assert.notEqual(normal.keyframes, actor.keyframes);
    fast.position[0] = -999;
    fast.actor!.pose.headYaw = -999;
    assert.notEqual(actor.position[0], -999);
    assert.notEqual(actor.actor!.pose.headYaw, -999);
  }
  actor.keyframes[0]!.rotation = [0, 44, 0];
  close(sampleObject(actor, 0).rotation[1], 44);
});

test('procedural vehicle wheels turn with distance and timed effect visibility follows source time', () => {
  const object = createObject('box');
  object.dimensions = [1.85, 1.45, 4.4];
  object.vehicle = vehicleSchema.parse({ kind: 'car' });
  const rig = new VehicleRig(object);
  const wheel = (rig.root.children[1] as Group).children[0]!;
  rig.update(object, 20, 0);
  close(wheel.rotation.x, 0);
  rig.update(object, 20, 4);
  close(wheel.rotation.x, 4 / object.vehicle.wheelRadius);
  const effectObject = createObject('box');
  effectObject.effect = { kind: 'explosion', start: 2, duration: 1, radius: 3 };
  const effect = new EffectRig(effectObject);
  effect.update(effectObject, 1.9);
  assert.equal(effect.root.visible, false);
  effect.update(effectObject, 2.5);
  assert.equal(effect.root.visible, true);
  assert.ok(effect.root.scale.x > 2);
  effect.update(effectObject, 3);
  assert.equal(effect.root.visible, false);
});
