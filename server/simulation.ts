import RAPIER from '@dimforge/rapier3d-compat';
import { createHash } from 'node:crypto';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { DomainError } from '../shared/domain-error';
import { meshToGeometry, modelingToMesh, primitiveToMesh } from '../shared/modeling-geometry';
import { quaternionFor, rotationFor, type MotionEvent, type MotionObject } from '../shared/motion';
import {
  physicsBakeSchema,
  rigidBodySchema,
  type PhysicsBakeOptions,
  type RigidBodySettings,
} from '../shared/physics';
import { sampleObject } from '../shared/timeline';
import type { Command, ObjectKeyframe, Project, Vec3 } from '../shared/types';

let ready: Promise<void> | undefined;
type Pose = { position: Vector3; rotation: Quaternion };
type BodyEntry = {
  object: MotionObject;
  settings: RigidBodySettings;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  scale: Vector3;
};
const eventId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 28);
export interface PhysicsBakeResult {
  commands: Command[];
  events: { objectId: string; event: MotionEvent }[];
  frames: number;
  duration: number;
}

function poseOf(body: RAPIER.RigidBody): Pose {
  const p = body.translation();
  const q = body.rotation();
  return { position: new Vector3(p.x, p.y, p.z), rotation: new Quaternion(q.x, q.y, q.z, q.w) };
}

function matrixAt(
  project: Project,
  object: MotionObject,
  time: number,
  poses?: Map<string, Pose>,
  seen = new Set<string>(),
): Matrix4 {
  if (seen.has(object.id)) throw new DomainError('Physics object hierarchy has a cycle');
  seen.add(object.id);
  const sampled = sampleObject(object, time, { render: true });
  if (sampled.attachment) throw new DomainError('Detach bone-bound bodies before physics baking');
  const local = new Matrix4().compose(
    new Vector3(...sampled.position),
    quaternionFor(sampled.rotation),
    new Vector3(...sampled.scale),
  );
  const parent = project.objects.find((item) => item.id === sampled.parentId);
  const world = parent ? matrixAt(project, parent, time, poses, seen).multiply(local) : local;
  const pose = poses?.get(object.id);
  if (!pose) return world;
  const scale = new Vector3();
  world.decompose(new Vector3(), new Quaternion(), scale);
  return new Matrix4().compose(pose.position, pose.rotation, scale);
}

function assertRigidTransform(project: Project, object: MotionObject, options: PhysicsBakeOptions) {
  let current: MotionObject | undefined = object;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) throw new DomainError('Physics object hierarchy has a cycle');
    visited.add(current.id);
    if (
      current.attachment ||
      current.keyframes.some((frame) => frame.time <= options.start + options.duration && frame.attachment)
    )
      throw new DomainError('Detach bone-bound bodies before physics baking');
    const initialScale = sampleObject(current, options.start, { render: true }).scale;
    const scaleTimes = [
      options.start + options.duration,
      ...current.keyframes
        .filter(
          (frame) =>
            frame.scale && frame.time > options.start && frame.time <= options.start + options.duration,
        )
        .map((frame) => frame.time),
    ];
    if (
      scaleTimes.some((time) =>
        sampleObject(current!, time, { render: true }).scale.some(
          (value, axis) => Math.abs(value - initialScale[axis]!) > 1e-8,
        ),
      )
    )
      throw new DomainError('Rigid-body scale must remain constant during a physics bake');
    current = project.objects.find((item) => item.id === current!.parentId);
  }
  const matrix = matrixAt(project, object, options.start);
  const x = new Vector3().setFromMatrixColumn(matrix, 0).normalize();
  const y = new Vector3().setFromMatrixColumn(matrix, 1).normalize();
  const z = new Vector3().setFromMatrixColumn(matrix, 2).normalize();
  if (Math.max(Math.abs(x.dot(y)), Math.abs(x.dot(z)), Math.abs(y.dot(z))) > 1e-5)
    throw new DomainError('Rigid-body parents cannot produce a sheared transform');
}

function colliderFor(object: MotionObject, settings: RigidBodySettings, scale: Vector3): RAPIER.ColliderDesc {
  if (settings.shape === 'mesh') {
    if (settings.mode !== 'static') throw new DomainError('Triangle mesh colliders must be static');
    if (object.assetUrl)
      throw new DomainError(
        'Imported GLB bodies use primitive collision shapes; mesh colliders require an editable local mesh',
      );
    const geometry = meshToGeometry(
      object.modeling ? modelingToMesh(object.modeling) : primitiveToMesh(object),
    );
    try {
      const position = geometry.getAttribute('position');
      const vertices = new Float32Array(position.count * 3);
      for (let index = 0; index < position.count; index++) {
        vertices[index * 3] = position.getX(index) * scale.x;
        vertices[index * 3 + 1] = position.getY(index) * scale.y;
        vertices[index * 3 + 2] = position.getZ(index) * scale.z;
      }
      const indices = geometry.index
        ? Uint32Array.from(geometry.index.array)
        : Uint32Array.from({ length: position.count }, (_, index) => index);
      if (indices.length > 300000)
        throw new DomainError('Static collision meshes are limited to 100000 triangles');
      return RAPIER.ColliderDesc.trimesh(vertices, indices);
    } finally {
      geometry.dispose();
    }
  }
  let dimensions = object.dimensions;
  const center = new Vector3(0, object.type === 'phone' ? 0 : object.dimensions[1] / 2, 0);
  if (object.modeling) {
    const geometry = meshToGeometry(modelingToMesh(object.modeling));
    try {
      geometry.boundingBox!.getCenter(center);
      dimensions = geometry.boundingBox!.getSize(new Vector3()).toArray() as Vec3;
    } finally {
      geometry.dispose();
    }
  }
  center.multiply(scale);
  const [width, height, depth] = dimensions.map((dimension, axis) => dimension * scale.getComponent(axis));
  let shape: RAPIER.ColliderDesc;
  if (settings.shape === 'sphere') shape = RAPIER.ColliderDesc.ball(Math.max(width, height, depth) / 2);
  else if (settings.shape === 'capsule') {
    const radius = Math.min(width, depth, height) / 2;
    shape = RAPIER.ColliderDesc.capsule(Math.max(0, height / 2 - radius), radius);
  } else shape = RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2);
  return shape.setTranslation(center.x, center.y, center.z);
}

function addBody(
  world: RAPIER.World,
  project: Project,
  object: MotionObject,
  options: PhysicsBakeOptions,
): BodyEntry {
  const settings = rigidBodySchema.parse(object.physics);
  assertRigidTransform(project, object, options);
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  matrixAt(project, object, options.start).decompose(position, rotation, scale);
  if (
    position.toArray().some((value) => !Number.isFinite(value) || Math.abs(value) > 1e7) ||
    object.dimensions.some(
      (dimension, axis) =>
        dimension * scale.getComponent(axis) < 0.00001 || dimension * scale.getComponent(axis) > 1e6,
    )
  )
    throw new DomainError('Physics body coordinates or dimensions exceed the supported simulation scale');
  const desc =
    settings.mode === 'static'
      ? RAPIER.RigidBodyDesc.fixed()
      : settings.mode === 'kinematic'
        ? RAPIER.RigidBodyDesc.kinematicPositionBased()
        : RAPIER.RigidBodyDesc.dynamic();
  desc
    .setTranslation(position.x, position.y, position.z)
    .setRotation(rotation)
    .setLinvel(...settings.linearVelocity)
    .setAngvel({
      x: settings.angularVelocity[0],
      y: settings.angularVelocity[1],
      z: settings.angularVelocity[2],
    })
    .setGravityScale(settings.gravityScale)
    .setLinearDamping(settings.linearDamping)
    .setAngularDamping(settings.angularDamping)
    .setCcdEnabled(settings.ccd)
    .setCanSleep(false);
  const body = world.createRigidBody(desc);
  body.setEnabledRotations(
    !settings.lockRotation[0],
    !settings.lockRotation[1],
    !settings.lockRotation[2],
    true,
  );
  const collider = world.createCollider(
    colliderFor(object, settings, scale)
      .setMass(settings.mass)
      .setFriction(settings.friction)
      .setRestitution(settings.restitution)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(0.01),
    body,
  );
  return { object, settings, body, collider, scale };
}

function localKeyframe(
  project: Project,
  entry: BodyEntry,
  poses: Map<string, Pose>,
  time: number,
): ObjectKeyframe {
  const pose = poses.get(entry.object.id)!;
  const world = new Matrix4().compose(pose.position, pose.rotation, entry.scale);
  const parent = project.objects.find((object) => object.id === entry.object.parentId);
  if (parent) world.premultiply(matrixAt(project, parent, time, poses).invert());
  const position = new Vector3();
  const rotation = new Quaternion();
  world.decompose(position, rotation, new Vector3());
  return {
    id: `physics-${eventId(`${entry.object.id}:${time}`)}`,
    time,
    position: position.toArray() as Vec3,
    rotation: rotationFor(rotation),
  };
}

/** Fixed-step Rapier simulation is sampled at output times; snapshots and generated keys stay separate. */
export async function bakePhysics(inputProject: Project, input: unknown): Promise<PhysicsBakeResult> {
  const project = structuredClone(inputProject);
  const options = physicsBakeSchema.parse(input);
  if (options.start + options.duration > 86400)
    throw new DomainError('Physics bake extends beyond the source timeline');
  const requested = options.ids ? new Set(options.ids) : null;
  if (
    requested &&
    (requested.size !== options.ids!.length ||
      [...requested].some((id) => !project.objects.some((object) => object.id === id && object.physics)))
  )
    throw new DomainError('Every selected physics ID must name a configured body exactly once');
  const candidates = (project.objects as MotionObject[]).filter(
    (object) =>
      object.physics && (!requested || requested.has(object.id) || object.physics.mode !== 'dynamic'),
  );
  const dynamic = candidates.filter((object) => object.physics!.mode === 'dynamic');
  if (!dynamic.length) throw new DomainError('Configure at least one dynamic body before baking');
  if (candidates.length > 128 || dynamic.length > 64)
    throw new DomainError('A simulation supports 64 dynamic and 128 total bodies');
  const frameCount = Math.ceil(options.duration * options.fps) + 1;
  if (frameCount * dynamic.length > 200000)
    throw new DomainError('Simulation bake is limited to 200000 total keys');
  for (const object of dynamic) {
    let current: MotionObject | undefined = object;
    while (current) {
      if (current.locked) throw new DomainError(`Object or parent is locked: ${current.id}`, 'LOCKED', 409);
      current = project.objects.find((item) => item.id === current!.parentId);
    }
  }
  await (ready ??= RAPIER.init());
  const world = new RAPIER.World({ x: options.gravity[0], y: options.gravity[1], z: options.gravity[2] });
  const queue = new RAPIER.EventQueue(true);
  world.timestep = 1 / options.stepRate;
  const events: PhysicsBakeResult['events'] = [];
  try {
    const bodies = candidates.map((object) => addBody(world, project, object, options));
    const outputs = bodies.filter((entry) => entry.settings.mode === 'dynamic');
    const byCollider = new Map(bodies.map((entry) => [entry.collider.handle, entry]));
    const tracks = outputs.map((entry) => ({ id: entry.object.id, keyframes: [] as ObjectKeyframe[] }));
    let previous = new Map(outputs.map((entry) => [entry.object.id, poseOf(entry.body)]));
    tracks.forEach((track, index) =>
      track.keyframes.push(localKeyframe(project, outputs[index]!, previous, options.start)),
    );
    let outputIndex = 1;
    const steps = Math.ceil(options.duration * options.stepRate);
    for (let step = 1; step <= steps; step++) {
      const relativeTime = step / options.stepRate;
      const sourceTime = options.start + relativeTime;
      for (const entry of bodies) {
        if (entry.settings.mode !== 'kinematic') continue;
        const position = new Vector3();
        const rotation = new Quaternion();
        matrixAt(project, entry.object, sourceTime).decompose(position, rotation, new Vector3());
        entry.body.setNextKinematicTranslation(position);
        entry.body.setNextKinematicRotation(rotation);
      }
      world.step(queue);
      const contacts = new Map<string, PhysicsBakeResult['events']>();
      queue.drainCollisionEvents((leftHandle, rightHandle, started) => {
        if (!started || relativeTime > options.duration) return;
        const left = byCollider.get(leftHandle);
        const right = byCollider.get(rightHandle);
        if (!left || !right) return;
        const location = new Vector3()
          .addVectors(
            new Vector3(left.body.translation().x, left.body.translation().y, left.body.translation().z),
            new Vector3(right.body.translation().x, right.body.translation().y, right.body.translation().z),
          )
          .multiplyScalar(0.5);
        world.contactPair(left.collider, right.collider, (manifold) => {
          const point = manifold.numSolverContacts() ? manifold.solverContactPoint(0) : null;
          if (point) location.set(point.x, point.y, point.z);
        });
        const pairEvents: PhysicsBakeResult['events'] = [];
        for (const [body, other] of [
          [left, right],
          [right, left],
        ])
          if (body!.settings.mode === 'dynamic') {
            const event: MotionEvent = {
              id: `collision-${eventId(`${sourceTime}:${body!.object.id}:${other!.object.id}`)}`,
              time: sourceTime,
              kind: 'collision',
              otherId: other!.object.id,
              position: location.toArray() as Vec3,
              strength: 0,
              duration: 0.25,
            };
            const item = { objectId: body!.object.id, event };
            events.push(item);
            pairEvents.push(item);
          }
        contacts.set([leftHandle, rightHandle].sort((a, b) => a - b).join(':'), pairEvents);
      });
      queue.drainContactForceEvents((event) => {
        const items = contacts.get([event.collider1(), event.collider2()].sort((a, b) => a - b).join(':'));
        if (items) for (const item of items) item.event.strength = event.totalForceMagnitude();
      });
      if (events.length > 10000)
        throw new DomainError('Simulation produced more than 10000 contact events; bake a shorter interval');
      const current = new Map(outputs.map((entry) => [entry.object.id, poseOf(entry.body)]));
      while (
        outputIndex < frameCount &&
        Math.min(outputIndex / options.fps, options.duration) <= relativeTime + 1e-9
      ) {
        const frameTime = Math.min(outputIndex / options.fps, options.duration);
        const fraction = Math.max(
          0,
          Math.min(1, (frameTime - (step - 1) / options.stepRate) * options.stepRate),
        );
        const poses = new Map(
          outputs.map((entry) => {
            const a = previous.get(entry.object.id)!;
            const b = current.get(entry.object.id)!;
            return [
              entry.object.id,
              {
                position: a.position.clone().lerp(b.position, fraction),
                rotation: a.rotation.clone().slerp(b.rotation, fraction),
              },
            ];
          }),
        );
        tracks.forEach((track, index) =>
          track.keyframes.push(localKeyframe(project, outputs[index]!, poses, options.start + frameTime)),
        );
        outputIndex++;
      }
      previous = current;
      if (step % 240 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return {
      commands: [
        {
          type: 'simulation.apply',
          payload: { start: options.start, end: options.start + options.duration, tracks, events },
        },
      ],
      events,
      frames: frameCount,
      duration: options.duration,
    };
  } finally {
    queue.free();
    world.free();
  }
}
