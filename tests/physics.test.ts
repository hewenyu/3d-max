import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommands, validateProject } from '../shared/commands';
import { createEmptyProject, createObject } from '../shared/project';
import { rigidBodySchema } from '../shared/physics';
import { sampleObject } from '../shared/timeline';
import { bakePhysics } from '../server/simulation';
import { primitiveToMesh } from '../shared/modeling-geometry';

function fallingProject() {
  const project = createEmptyProject();
  const ground = createObject('plane');
  ground.id = 'ground';
  ground.dimensions = [20, 0.1, 20];
  ground.locked = true;
  ground.physics = rigidBodySchema.parse({ mode: 'static', restitution: 0 });
  const box = createObject('box');
  box.id = 'box';
  box.position = [0, 3, 0];
  box.physics = rigidBodySchema.parse({
    mode: 'dynamic',
    restitution: 0,
    linearDamping: 0,
    angularDamping: 0,
  });
  project.objects = [ground, box];
  return validateProject(project);
}

test('fixed-step Rapier fall lands on a locked static body and produces editable collision events', async () => {
  const project = fallingProject();
  const before = JSON.stringify(project);
  const baked = await bakePhysics(project, { duration: 2, fps: 24 });
  assert.equal(baked.frames, 49);
  assert.equal(baked.duration, 2);
  assert.equal(JSON.stringify(project), before);
  const result = applyCommands(project, baked.commands).project;
  const object = result.objects.find((item) => item.id === 'box')!;
  const end = sampleObject(object, 2);
  assert.ok(Math.abs(end.position[1] - 0.1) < 0.025, `Box bottom was ${end.position[1]}`);
  assert.ok(
    baked.events.some(
      (item) =>
        item.objectId === 'box' &&
        item.event.otherId === 'ground' &&
        item.event.time > 0.5 &&
        item.event.time < 1,
    ),
  );
  assert.ok(baked.events.some((item) => item.event.strength > 1));
  assert.ok(object.keyframes.every((frame) => frame.position && frame.rotation));
  assert.equal(object.rotationInterpolation, 'quaternion');
  assert.deepEqual(result.objects[0], project.objects[0]);
  const repeated = await bakePhysics(project, { duration: 2, fps: 24 });
  assert.deepEqual(repeated, baked);
});

test('zero-gravity collision transfers momentum and fixed-step output supports unrelated video frame rates', async () => {
  const project = createEmptyProject();
  const left = createObject('box');
  left.id = 'left';
  left.position = [-3, 0, 0];
  left.physics = rigidBodySchema.parse({
    mode: 'dynamic',
    linearVelocity: [4, 0, 0],
    restitution: 1,
    friction: 0,
    linearDamping: 0,
    angularDamping: 0,
    lockRotation: [true, true, true],
  });
  const right = createObject('box');
  right.id = 'right';
  right.physics = { ...left.physics, linearVelocity: [0, 0, 0] };
  project.objects = [left, right];
  const baked = await bakePhysics(project, { duration: 2.13, fps: 25, stepRate: 120, gravity: [0, 0, 0] });
  const result = applyCommands(project, baked.commands).project;
  assert.equal(baked.frames, Math.ceil(2.13 * 25) + 1);
  const a = sampleObject(result.objects[0]!, 2.13);
  const b = sampleObject(result.objects[1]!, 2.13);
  assert.ok(b.position[0] > 4, `Second body did not receive momentum: ${b.position[0]}`);
  assert.ok(a.position[0] < 0);
  assert.ok(Math.abs(a.position[1]) < 1e-7 && Math.abs(b.position[1]) < 1e-7);
  assert.equal(result.objects[0]!.keyframes.at(-1)!.time, 2.13);
  assert.ok(baked.events.length >= 2);
});

test('kinematic keyframe motion collides with dynamics and grouped transforms bake back to local space', async () => {
  const project = createEmptyProject();
  const parent = createObject('group');
  parent.id = 'group';
  parent.position = [10, 0, 0];
  parent.rotation = [0, 90, 0];
  const box = createObject('box');
  box.id = 'box';
  box.parentId = parent.id;
  box.position = [0, 0, 2];
  box.physics = rigidBodySchema.parse({
    mode: 'dynamic',
    friction: 0,
    restitution: 0,
    linearDamping: 0,
    angularDamping: 0,
    lockRotation: [true, true, true],
  });
  const pusher = createObject('box');
  pusher.id = 'pusher';
  pusher.parentId = parent.id;
  pusher.physics = rigidBodySchema.parse({ mode: 'kinematic', friction: 0, restitution: 0 });
  pusher.keyframes = [
    { id: 'in', time: 0, position: [0, 0, 0] },
    { id: 'out', time: 2, position: [0, 0, 4] },
  ];
  project.objects = [parent, box, pusher];
  const baked = await bakePhysics(project, { duration: 2, gravity: [0, 0, 0] });
  const result = applyCommands(project, baked.commands).project;
  const final = sampleObject(result.objects[1]!, 2);
  assert.ok(final.position[2] > 4.8, `Kinematic body did not push grouped box: ${final.position}`);
  assert.ok(Math.abs(final.position[0]) < 1e-4);
  assert.deepEqual(result.objects[2]!.keyframes, pusher.keyframes);
});

test('bake rejection preserves locks and prevents invalid mesh dynamics or animated rigid scale', async () => {
  const project = fallingProject();
  project.objects[1]!.locked = true;
  await assert.rejects(() => bakePhysics(project, { duration: 1 }), /locked/);
  project.objects[1]!.locked = false;
  project.objects[1]!.physics!.shape = 'mesh';
  await assert.rejects(() => bakePhysics(project, { duration: 1 }), /static/);
  project.objects[1]!.physics!.shape = 'box';
  project.objects[1]!.keyframes = [{ id: 'scale', time: 0.5, scale: [2, 2, 2] }];
  await assert.rejects(() => bakePhysics(project, { duration: 1 }), /scale/);
  project.objects[1]!.keyframes = [{ id: 'later-scale', time: 2, scale: [2, 2, 2] }];
  await assert.rejects(() => bakePhysics(project, { duration: 1 }), /scale/);
});

test('editable mesh offsets define the real primitive collider center and static meshes receive contacts', async () => {
  const project = fallingProject();
  const box = project.objects[1]!;
  box.modeling = primitiveToMesh(box);
  box.modeling.vertices = box.modeling.vertices.map(([x, y, z]) => [x + 5, y + 2, z]);
  project.objects[0]!.physics!.shape = 'mesh';
  const result = applyCommands(project, (await bakePhysics(project, { duration: 2.5 })).commands).project;
  const end = sampleObject(result.objects[1]!, 2.5);
  assert.ok(Math.abs(end.position[1] + 1.9) < 0.03, `Offset mesh collider ended at ${end.position[1]}`);
});
