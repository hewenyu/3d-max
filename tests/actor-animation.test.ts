import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createObject } from '../shared/project';
import {
  ActorAnimationSampler,
  actorActionNames,
  actorAnimationSchema,
  actorIntervalWeight,
  actorJointNames,
  createActorActionClip,
  sampleActorAnimation,
  type ActorAnimation,
  type ActorConstraintTarget,
  type ActorEffector,
} from '../shared/actor-animation';
import { ActorRig } from '../shared/actor-rig';

function close(actual: number, expected: number, tolerance = 1e-5) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} differs from ${expected} by more than ${tolerance}`,
  );
}
function closeArray(actual: number[], expected: number[], tolerance = 1e-5) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => close(value, expected[index], tolerance));
}
function rotationDistance(a: number[], b: number[]) {
  return new THREE.Quaternion().fromArray(a).angleTo(new THREE.Quaternion().fromArray(b));
}
function animation(
  clips: unknown[] = [],
  constraints: unknown[] = [],
  jointKeys: unknown[] = [],
): ActorAnimation {
  return actorAnimationSchema.parse({ clips, constraints, jointKeys });
}
function rigFixture(effector: ActorEffector, position: [number, number, number], weight = 1) {
  const object = createObject('actor');
  object.actor!.animation = animation(
    [],
    [
      {
        id: 'contact',
        effector,
        start: 0,
        end: 5,
        weight,
        target: { kind: 'world', position },
        iterations: 96,
        tolerance: 0.02,
      },
    ],
  );
  const rig = new ActorRig('#d8d8d8');
  const parent = new THREE.Group();
  parent.add(rig.root);
  const resolve = (target: ActorConstraintTarget) =>
    target.kind === 'world' ? new THREE.Vector3(...target.position) : null;
  return { rig, object, parent, resolve };
}

test('rendered rig bounds include the actor while internal IK carriers stay outside scene traversal', () => {
  const rig = new ActorRig('#dddddd');
  try {
    rig.update(createObject('actor'), 0, 0);
    const size = new THREE.Box3().setFromObject(rig.root).getSize(new THREE.Vector3());
    assert.ok(size.y > 1.7 && size.y < 1.9);
    assert.ok(size.x > 0.4 && size.x < 0.8);
    assert.doesNotThrow(() => new THREE.BoxHelper(rig.root));
  } finally {
    rig.dispose();
  }
});

test('floor actions keep actual body geometry above the origin through dense samples and ignore attached props', () => {
  for (const action of ['fall', 'getup'] as const) {
    const object = createObject('actor');
    const duration = action === 'fall' ? 1.6 : 2.1;
    object.actor!.animation = animation([{ id: action, action, start: 0, end: duration + 1 }]);
    const rig = new ActorRig('#dddddd');
    const bodyParts: THREE.Mesh[] = [];
    rig.root.traverse((child) => {
      if (child instanceof THREE.Mesh) bodyParts.push(child);
    });
    const prop = new THREE.Mesh(new THREE.BoxGeometry(0.1, 8, 0.1), new THREE.MeshBasicMaterial());
    rig.rightHand.add(prop);
    try {
      for (let index = 0; index <= 120; index++) {
        rig.update(object, (duration * index) / 120, 0);
        const bounds = new THREE.Box3();
        for (const part of bodyParts) bounds.union(new THREE.Box3().setFromObject(part));
        assert.ok(bounds.min.y >= -1e-6, `${action} penetrates its support plane at sample ${index}`);
        assert.ok(bounds.min.y < 0.035, `${action} floats above its support plane at sample ${index}`);
      }
    } finally {
      prop.removeFromParent();
      prop.geometry.dispose();
      (prop.material as THREE.Material).dispose();
      rig.dispose();
    }
  }
});

test('all reusable action clips avoid negative penetration at their local support plane', () => {
  const rig = new ActorRig('#dddddd');
  const object = createObject('actor');
  try {
    for (const action of actorActionNames) {
      const duration = createActorActionClip(action).duration;
      object.actor!.animation = animation([{ id: action, action, start: 0, end: duration + 1 }]);
      for (let index = 0; index <= 80; index++) {
        rig.update(object, (duration * index) / 80, 0);
        assert.ok(
          new THREE.Box3().setFromObject(rig.root).min.y >= -1e-6,
          `${action} penetrates at ${index}`,
        );
      }
    }
  } finally {
    rig.dispose();
  }
});

test('action library builds real full-joint Three clips for every reusable action', () => {
  for (const action of actorActionNames) {
    const clip = createActorActionClip(action);
    assert.ok(clip instanceof THREE.AnimationClip);
    assert.ok(clip.duration > 0);
    for (const joint of actorJointNames)
      assert.ok(clip.tracks.some((track) => track.name === `${joint}.quaternion`));
    assert.ok(clip.tracks.some((track) => track.name === 'hips.position'));
    assert.ok(clip.validate(), `${action} must contain valid keyframes`);
    const sampler = new ActorAnimationSampler(
      animation([{ id: action, action, start: 0, end: clip.duration + 1 }]),
    );
    try {
      for (const at of [0, clip.duration * 0.25, clip.duration * 0.5, clip.duration]) {
        const sample = sampler.sample(at);
        assert.ok(sample.hipsOffset.every(Number.isFinite));
        for (const value of Object.values(sample.rotations)) {
          assert.ok(value.every(Number.isFinite));
          close(Math.hypot(...value), 1, 1e-5);
        }
      }
    } finally {
      sampler.dispose();
    }
  }
});

test('mixed action sampling is deterministic across random seeks and supports reverse clip time', () => {
  const data = animation([
    { id: 'walk', action: 'walk', start: 0, end: 4, loop: true, weight: 0.5, fadeIn: 0.3, fadeOut: 0.3 },
    { id: 'punch', action: 'punch', start: 1, end: 2, fadeIn: 0.15, fadeOut: 0.15 },
  ]);
  const sampler = new ActorAnimationSampler(data);
  try {
    const expected = sampler.sample(1.33);
    for (const at of [3.9, 0, 2, 1.1, 4, 0.3]) sampler.sample(at);
    const actual = sampler.sample(1.33);
    closeArray(actual.hipsOffset, expected.hipsOffset, 1e-12);
    for (const joint of actorJointNames)
      closeArray(actual.rotations[joint], expected.rotations[joint], 1e-12);
  } finally {
    sampler.dispose();
  }
  const forward = sampleActorAnimation(animation([{ id: 'a', action: 'punch', start: 0, end: 1 }]), 0.2);
  const reverse = sampleActorAnimation(
    animation([{ id: 'a', action: 'punch', start: 0, end: 1, sourceOffset: 0.7, speed: -1 }]),
    0.5,
  );
  closeArray(reverse.hipsOffset, forward.hipsOffset);
  for (const joint of actorJointNames) closeArray(reverse.rotations[joint], forward.rotations[joint]);
});

test('clip fade boundaries and sit-to-stand body-height blends remain continuous', () => {
  const data = animation([
    { id: 'sit', action: 'sit', start: 0, end: 2, fadeOut: 0.4 },
    { id: 'stand', action: 'stand', start: 1.6, end: 3.2, fadeIn: 0.4, fadeOut: 0.2 },
  ]);
  for (const boundary of [1.6, 2, 3, 3.2]) {
    const before = sampleActorAnimation(data, boundary - 1e-6);
    const after = sampleActorAnimation(data, boundary + 1e-6);
    assert.ok(Math.abs(before.hipsOffset[1] - after.hipsOffset[1]) < 0.001);
    for (const joint of actorJointNames)
      assert.ok(rotationDistance(before.rotations[joint], after.rotations[joint]) < 0.002);
  }
  assert.ok(sampleActorAnimation(data, 1.3).hipsOffset[1] < -0.4);
  assert.ok(sampleActorAnimation(data, 2.9).hipsOffset[1] > -0.05);
  close(actorIntervalWeight(data.clips[1], 1.6), 0);
  close(actorIntervalWeight(data.clips[1], 3.2), 0);
});

test('mirroring swaps attack limbs and lateral root displacement while custom keys preserve legacy pose', () => {
  const normal = sampleActorAnimation(animation([{ id: 'p', action: 'punch', start: 0, end: 1 }]), 0.33);
  const mirror = sampleActorAnimation(
    animation([{ id: 'p', action: 'punch', start: 0, end: 1, mirror: true }]),
    0.33,
  );
  const right = normal.rotations.rightArm;
  closeArray(mirror.rotations.leftArm, [right[0], -right[1], -right[2], right[3]]);
  const dodge = (mirror: boolean) =>
    sampleActorAnimation(animation([{ id: 'd', action: 'dodge', start: 0, end: 2, mirror }]), 0.3);
  close(dodge(false).hipsOffset[0], -dodge(true).hipsOffset[0]);
  const keys = animation(
    [],
    [],
    [
      { id: 'elbow0', time: 0, joint: 'rightElbow', rotation: [0, 0, 0] },
      { id: 'elbow1', time: 1, joint: 'rightElbow', rotation: [-70, 0, 0], easing: 'smooth' },
      { id: 'hips0', time: 0, joint: 'hips', rotation: [0, 0, 0], hipsOffset: [0, 0, 0] },
      { id: 'hips1', time: 1, joint: 'hips', rotation: [0, 0, 0], hipsOffset: [0, -0.2, 0] },
    ],
  );
  const sample = sampleActorAnimation(keys, 1, {
    pose: { headPitch: 0, headYaw: 30, leftArm: 0, rightArm: 0, leftLeg: 0, rightLeg: 0 },
  });
  const elbow = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...sample.rotations.rightElbow));
  close(THREE.MathUtils.radToDeg(elbow.x), -76, 0.001);
  const head = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...sample.rotations.head));
  close(THREE.MathUtils.radToDeg(head.y), 30, 0.001);
  close(sample.hipsOffset[1], -0.196, 0.001);
});

test('real CCD hand and foot constraints reach world targets and remain deterministic under seeking', () => {
  for (const [effector, point] of [
    ['leftHand', [0.4, 1.15, 0.32]],
    ['rightHand', [-0.4, 1.15, 0.32]],
    ['leftFoot', [0.095, 0.2, 0.25]],
    ['rightFoot', [-0.095, 0.2, 0.25]],
  ] as [ActorEffector, [number, number, number]][]) {
    const { rig, object, parent, resolve } = rigFixture(effector, point);
    try {
      const snapshots: number[][] = [];
      for (const at of [1, 3.5, 0.1, 1]) {
        parent.position.set(0, 0, 0);
        rig.update(object, at, 0);
        const result = rig.applyConstraints(object, at, resolve)[0];
        assert.equal(result.reachable, true, `${effector} target should be in reach`);
        assert.equal(result.reached, true, `${effector}: ${JSON.stringify(result)}`);
        assert.ok(result.error! < 0.02);
        if (at === 1) snapshots.push(result.position);
      }
      closeArray(snapshots[0], snapshots[1], 1e-10);
    } finally {
      rig.dispose();
    }
  }
});

test('IK resolves moving targets in rotated parent space for resized actors', () => {
  const { rig, object, parent } = rigFixture('leftHand', [0, 0, 0]);
  rig.root.scale.set(1.2, 1.35, 1.1);
  parent.position.set(3, 0.4, -2);
  parent.rotation.set(0.1, 0.7, -0.05);
  const targetObject = new THREE.Group();
  targetObject.position.set(0.4, 1.15, 0.3);
  rig.root.add(targetObject);
  object.actor!.animation!.constraints[0].target = {
    kind: 'object',
    objectId: 'target',
    bone: 'root',
    offset: [0.015, 0, 0],
  };
  try {
    for (const at of [0.2, 1.2, 2.2, 0.2]) {
      targetObject.position.z = 0.3 + Math.sin(at) * 0.04;
      rig.update(object, at, 0);
      const expected = targetObject.localToWorld(new THREE.Vector3(0.015, 0, 0));
      const result = rig.applyConstraints(object, at, () => expected.clone())[0];
      assert.equal(result.reachable, true);
      assert.equal(result.reached, true, JSON.stringify(result));
      assert.ok(result.error! < 0.02);
    }
  } finally {
    rig.dispose();
  }
});

test('IK weights fade continuously and report unreachable, missing and inactive targets', () => {
  const full = rigFixture('leftHand', [0.4, 1.15, 0.32]);
  try {
    full.rig.update(full.object, 1, 0);
    const base = full.rig.leftHand.getWorldPosition(new THREE.Vector3());
    const target = new THREE.Vector3(0.4, 1.15, 0.32);
    const constraint = full.object.actor!.animation!.constraints[0];
    constraint.weight = 0.5;
    const blended = full.rig.applyConstraints(full.object, 1, full.resolve)[0];
    assert.ok(blended.error! < base.distanceTo(target));
    assert.ok(blended.error! > 0.02);
    constraint.weight = 1;
    constraint.fadeIn = 1;
    const positions: number[][] = [];
    for (const at of [0, 0.00001]) {
      full.rig.update(full.object, at, 0);
      positions.push(full.rig.applyConstraints(full.object, at, full.resolve)[0].position);
    }
    closeArray(positions[0], positions[1], 0.0001);
    constraint.target = { kind: 'world', position: [20, 2, 0] };
    full.rig.update(full.object, 2, 0);
    const unreachable = full.rig.applyConstraints(full.object, 2, full.resolve)[0];
    assert.equal(unreachable.status, 'unreachable');
    assert.equal(unreachable.reachable, false);
    assert.ok(Number.isFinite(unreachable.error));
    assert.ok(unreachable.error! > 10);
    assert.equal(full.rig.applyConstraints(full.object, 2, () => null)[0].status, 'missing-target');
    assert.equal(full.rig.applyConstraints(full.object, 6, full.resolve)[0].status, 'inactive');
  } finally {
    full.rig.dispose();
  }
});

test('actor animation schema rejects ambiguous keys, invalid intervals and impossible fades', () => {
  assert.throws(() => animation([{ id: 'bad', action: 'punch', start: 1, end: 0 }]));
  assert.throws(() => animation([{ id: 'bad', action: 'punch', start: 0, end: 1, fadeIn: 1, fadeOut: 1 }]));
  assert.throws(() => animation([{ id: 'bad', action: 'punch', start: 0, end: 1, speed: 0 }]));
  assert.throws(() =>
    animation(
      [],
      [],
      [
        { id: 'one', time: 0, joint: 'head', rotation: [0, 0, 0] },
        { id: 'two', time: 0, joint: 'head', rotation: [0, 1, 0] },
      ],
    ),
  );
});
