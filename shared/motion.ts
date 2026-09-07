import { CatmullRomCurve3, Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { z } from 'zod';
import { DomainError } from './domain-error';
import { rigidBodySchema, type RigidBodySettings } from './physics';
import { segmentSourceDuration, segmentSpeed } from './time-map';
import type { ObjectKeyframe, SceneObject, Vec3 } from './types';

const finite = z.number().finite();
const vector = z.tuple([finite, finite, finite]);
const identifier = z.string().min(1).max(160);
const time = finite.min(0).max(86400);
export const pathSpeedSchema = z
  .object({
    duration: finite.positive().max(3600),
    fromSpeed: finite.min(0).max(10000),
    toSpeed: finite.min(0).max(10000),
    easing: z.enum(['constant', 'linear', 'smooth']),
  })
  .strict();
export const motionPathSchema = z
  .object({
    points: z
      .array(z.object({ position: vector, roll: finite.min(-3600).max(3600).default(0) }).strict())
      .min(2)
      .max(512),
    closed: z.boolean().default(false),
    curve: z.enum(['centripetal', 'chordal', 'catmullrom']).default('centripetal'),
    tension: finite.min(0).max(1).default(0.5),
    start: time.default(0),
    speed: z.array(pathSpeedSchema).min(1).max(128),
    distanceOffset: finite.min(0).max(1e7).default(0),
    orientation: z.enum(['path', 'fixed']).default('path'),
    up: vector.default([0, 1, 0]),
    lookAhead: finite.min(0).max(1000).default(0.5),
    bankStrength: finite.min(-2).max(2).default(0),
  })
  .strict();
export type MotionPath = z.infer<typeof motionPathSchema>;

export const vehicleSchema = z
  .object({
    kind: z.enum(['car', 'spacecraft']),
    wheelRadius: finite.min(0.05).max(10).default(0.34),
    wheelBase: finite.min(0.2).max(50).default(2.6),
    trackWidth: finite.min(0.2).max(30).default(1.6),
    maxSteer: finite.min(0).max(80).default(35),
    bodyRoll: finite.min(0).max(2).default(0.15),
  })
  .strict();
export type VehicleSettings = z.infer<typeof vehicleSchema>;
export const motionEventSchema = z
  .object({
    id: identifier,
    time,
    kind: z.enum(['collision', 'impact', 'projectile', 'explosion']),
    otherId: identifier.optional(),
    position: vector,
    strength: finite.min(0).max(1e12).default(1),
    duration: finite.positive().max(60).default(0.5),
  })
  .strict();
export type MotionEvent = z.infer<typeof motionEventSchema>;
export const effectSchema = z
  .object({
    kind: z.enum(['projectile', 'impact', 'explosion']),
    start: time.default(0),
    duration: finite.positive().max(60).default(1),
    radius: finite.positive().max(1000).default(1),
  })
  .strict();
export type EffectSettings = z.infer<typeof effectSchema>;
export type MotionObject = SceneObject & {
  motion?: MotionPath;
  vehicle?: VehicleSettings;
  physics?: RigidBodySettings;
  motionEvents?: MotionEvent[];
  effect?: EffectSettings;
  rotationInterpolation?: 'linear' | 'quaternion';
};

const bakedFrameSchema = z.object({ id: identifier, time, position: vector, rotation: vector }).strict();
export const simulationApplySchema = z
  .object({
    start: time,
    end: time,
    tracks: z
      .array(z.object({ id: identifier, keyframes: z.array(bakedFrameSchema).min(1).max(36001) }).strict())
      .min(1)
      .max(64),
    events: z
      .array(z.object({ objectId: identifier, event: motionEventSchema }).strict())
      .max(10000)
      .default([]),
  })
  .strict();

export const motionCommandDefinitions: { type: string; description: string; schema: z.AnyZodObject }[] = [
  {
    type: 'motion.events.set',
    description:
      'Replace an object source-time collision, impact, projectile or explosion event track. Positions are world meters; strength and duration are event metadata. Events do not create effect geometry. Object/parent locks, related-object validation and synchronization timing apply. Unlink synchronized events before removing them.',
    schema: z.object({ id: identifier, events: z.array(motionEventSchema).max(10000) }).strict(),
  },
  {
    type: 'motion.path.set',
    description:
      'Set a reusable local-space 3D Catmull-Rom path. Points include bank roll degrees; speed segment durations are SOURCE seconds and speed is meters/second. Bake to ordinary editable keys with motion.path.bake.',
    schema: z.object({ id: identifier, path: motionPathSchema.nullable() }).strict(),
  },
  {
    type: 'motion.path.fit',
    description:
      'Scale path speeds to travel exactly the path length, optionally fit all segment durations to a source duration. Does not bake until motion.path.bake.',
    schema: z.object({ id: identifier, duration: finite.positive().max(3600).optional() }).strict(),
  },
  {
    type: 'motion.path.bake',
    description:
      'Bake path position, stable 3D orientation and banking into editable source-time keys. Replaces only position/rotation in the path interval; preserves other animation properties. Quaternion interpolation avoids Euler flips on vertical loops.',
    schema: z.object({ id: identifier, fps: finite.int().min(1).max(60).default(24) }).strict(),
  },
  {
    type: 'vehicle.create',
    description:
      'Create an editable white-model car or spacecraft. Cars face +Z and stand on Y=0; dimensions are width/height/length in meters.',
    schema: z
      .object({
        id: identifier.optional(),
        name: z.string().min(1).max(200).optional(),
        kind: z.enum(['car', 'spacecraft']),
        position: vector.optional(),
        rotation: vector.optional(),
        dimensions: z.tuple([finite.positive(), finite.positive(), finite.positive()]).optional(),
      })
      .strict(),
  },
  {
    type: 'vehicle.configure',
    description:
      'Configure procedural vehicle geometry, wheel size, wheelbase, steering range and suspension roll. Removing configuration restores the base mesh.',
    schema: z.object({ id: identifier, vehicle: vehicleSchema.nullable() }).strict(),
  },
  {
    type: 'physics.body.set',
    description:
      'Configure a static, dynamic or animated kinematic Rapier rigid body. Velocities are world meters/second and world radians/second. Collision geometry is a bounding box/sphere/capsule, or the actual mesh for static bodies. Invoke simulation bake to generate editable keys.',
    schema: z.object({ id: identifier, body: rigidBodySchema.nullable() }).strict(),
  },
  {
    type: 'simulation.apply',
    description:
      'Atomically apply baked rigid-body tracks and collision events to a source interval. Ordinary project revisions, scene/performance context and locks apply.',
    schema: simulationApplySchema,
  },
  {
    type: 'effect.create',
    description:
      'Create a timed editable white-model projectile, impact or expanding explosion placeholder. Object transforms and keys animate its trajectory in source time.',
    schema: z
      .object({
        id: identifier.optional(),
        name: z.string().min(1).max(200).optional(),
        position: vector.optional(),
        rotation: vector.optional(),
        effect: effectSchema,
      })
      .strict(),
  },
  {
    type: 'effect.configure',
    description: 'Edit a timed projectile/impact/explosion placeholder.',
    schema: z.object({ id: identifier, effect: effectSchema }).strict(),
  },
];

export function pathDuration(path: MotionPath): number {
  return path.speed.reduce((sum, segment) => sum + segment.duration, 0);
}
export function pathDistance(path: MotionPath): number {
  return path.speed.reduce((sum, segment) => sum + segmentSourceDuration(segment), 0);
}
export function pathClock(path: MotionPath, sourceTime: number) {
  let remaining = MathUtils.clamp(sourceTime - path.start, 0, pathDuration(path));
  let distance = path.distanceOffset;
  let speed = 0;
  for (const segment of path.speed) {
    const fraction = Math.min(1, remaining / segment.duration);
    distance += segmentSourceDuration(segment, fraction);
    speed = segmentSpeed(segment, fraction);
    if (remaining <= segment.duration) break;
    remaining -= segment.duration;
  }
  if (sourceTime < path.start || sourceTime > path.start + pathDuration(path)) speed = 0;
  return { distance, speed };
}

export interface CompiledPath {
  curve: CatmullRomCurve3;
  length: number;
  normals: Vector3[];
  resolution: number;
}
const compiledPaths = new WeakMap<MotionPath, CompiledPath>();
export function validateMotionObject(object: MotionObject): void {
  if (object.motion) {
    const path = object.motion;
    if (path.closed && path.points.length < 3)
      throw new DomainError('Closed paths need at least three distinct points');
    if (path.start + pathDuration(path) > 86400)
      throw new DomainError('Motion path extends beyond the supported source timeline');
    if (path.up.every((value) => Math.abs(value) < 1e-8))
      throw new DomainError('Path up vector cannot be zero');
    for (let index = 1; index < path.points.length; index++)
      if (
        Math.hypot(
          ...path.points[index]!.position.map(
            (value, axis) => value - path.points[index - 1]!.position[axis]!,
          ),
        ) < 1e-6
      )
        throw new DomainError('Adjacent path points must be distinct');
    if (
      path.closed &&
      Math.hypot(
        ...path.points[0]!.position.map((value, axis) => value - path.points.at(-1)!.position[axis]!),
      ) < 1e-6
    )
      throw new DomainError('Closed paths close automatically; omit the repeated final point');
    for (const segment of path.speed)
      if (segment.easing === 'constant' && segment.fromSpeed !== segment.toSpeed)
        throw new DomainError('Constant path speed must have equal endpoints');
  }
  if (
    (object.vehicle || object.effect) &&
    (object.type === 'actor' ||
      object.type === 'group' ||
      object.modeling ||
      object.assetUrl ||
      (object.vehicle && object.effect))
  )
    throw new DomainError('Vehicle and effect geometry cannot be combined with another geometry source');
  if (object.effect && object.effect.start + object.effect.duration > 86400)
    throw new DomainError('Effect extends beyond the supported source timeline');
  if (object.physics?.shape === 'mesh' && object.physics.mode !== 'static')
    throw new DomainError('Mesh collision shapes require a static rigid body');
}

export function compilePath(path: MotionPath): CompiledPath {
  const cached = compiledPaths.get(path);
  if (cached) return cached;
  if (path.up.every((value) => Math.abs(value) < 1e-8))
    throw new DomainError('Path up vector cannot be zero');
  for (let index = 1; index < path.points.length; index++)
    if (
      new Vector3(...path.points[index]!.position).distanceTo(
        new Vector3(...path.points[index - 1]!.position),
      ) < 1e-6
    )
      throw new DomainError('Adjacent path points must be distinct');
  for (const segment of path.speed)
    if (segment.easing === 'constant' && segment.fromSpeed !== segment.toSpeed)
      throw new DomainError('Constant path speed must have equal endpoints');
  const curve = new CatmullRomCurve3(
    path.points.map((point) => new Vector3(...point.position)),
    path.closed,
    path.curve,
    path.tension,
  );
  const resolution = Math.min(8192, Math.max(512, path.points.length * 32));
  curve.arcLengthDivisions = resolution;
  const length = curve.getLength();
  if (length < 1e-5) throw new DomainError('Path length must be positive');
  const frames = curve.computeFrenetFrames(resolution, path.closed);
  const tangent = frames.tangents[0]!;
  const up = new Vector3(...path.up).addScaledVector(tangent, -new Vector3(...path.up).dot(tangent));
  if (up.lengthSq() < 1e-8) up.copy(frames.normals[0]!);
  up.normalize();
  const angle = Math.atan2(
    new Vector3().crossVectors(frames.normals[0]!, up).dot(tangent),
    frames.normals[0]!.dot(up),
  );
  const normals = frames.normals.map((normal, index) =>
    normal.applyAxisAngle(frames.tangents[index]!, angle),
  );
  const result = { curve, length, normals, resolution };
  compiledPaths.set(path, result);
  return result;
}

export function quaternionFor(rotation: Vec3): Quaternion {
  return new Quaternion().setFromEuler(new Euler(...(rotation.map(MathUtils.degToRad) as Vec3), 'XYZ'));
}
export function rotationFor(quaternion: Quaternion): Vec3 {
  const rotation = new Euler().setFromQuaternion(quaternion, 'XYZ');
  return [rotation.x, rotation.y, rotation.z].map(MathUtils.radToDeg) as Vec3;
}
const rotationTracks = new WeakMap<
  SceneObject,
  { time: number; quaternion: Quaternion; easing?: ObjectKeyframe['easing'] }[]
>();
export function sampleQuaternionRotation(object: SceneObject, time: number, immutable = false): Vec3 {
  let frames = immutable ? rotationTracks.get(object) : undefined;
  if (!frames) {
    frames = [...object.keyframes]
      .filter((frame) => frame.rotation)
      .sort((left, right) => left.time - right.time)
      .map((frame) => ({
        time: frame.time,
        quaternion: quaternionFor(frame.rotation!),
        easing: frame.easing,
      }));
    if (immutable) rotationTracks.set(object, frames);
  }
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle]!.time <= time) low = middle + 1;
    else high = middle;
  }
  const before = low ? frames[low - 1]! : { time: 0, quaternion: quaternionFor(object.rotation) };
  const after = frames[low];
  if (!after) return rotationFor(before.quaternion);
  let fraction = MathUtils.clamp((time - before.time) / (after.time - before.time), 0, 1);
  if (after.easing === 'step') fraction = 0;
  else if (after.easing === 'smooth') fraction = fraction * fraction * (3 - 2 * fraction);
  return rotationFor(before.quaternion.clone().slerp(after.quaternion, fraction));
}

export function sampleMotionPath(path: MotionPath, time: number, fixedRotation: Vec3 = [0, 0, 0]) {
  const { curve, length, normals, resolution } = compilePath(path);
  const clock = pathClock(path, time);
  const distance = path.closed
    ? ((clock.distance % length) + length) % length
    : Math.min(length, clock.distance);
  const u = distance / length;
  const point = curve.getPointAt(u);
  const ahead = path.lookAhead / length;
  const nextU = path.closed ? (u + ahead) % 1 : Math.min(1, u + ahead);
  const tangent =
    ahead > 1e-8 && nextU !== u ? curve.getPointAt(nextU).sub(point).normalize() : curve.getTangentAt(u);
  if (tangent.lengthSq() < 1e-8) tangent.copy(curve.getTangentAt(u));
  const index = Math.min(resolution - 1, Math.floor(u * resolution));
  const normal = normals[index]!.clone()
    .lerp(normals[index + 1]!, u * resolution - index)
    .normalize();
  const right = new Vector3().crossVectors(normal, tangent).normalize();
  const up = new Vector3().crossVectors(tangent, right).normalize();
  const quaternion = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, tangent));
  const span = Math.min(0.005, 0.5 / length);
  const a = path.closed ? (u - span + 1) % 1 : Math.max(0, u - span);
  const b = path.closed ? (u + span) % 1 : Math.min(1, u + span);
  const curvature =
    curve.getTangentAt(b).sub(curve.getTangentAt(a)).dot(right) /
    Math.max(1e-6, (path.closed ? span * 2 : b - a) * length);
  const parameter = curve.getUtoTmapping(u, 0) * (path.closed ? path.points.length : path.points.length - 1);
  const pointIndex = Math.min(path.points.length - 1, Math.floor(parameter));
  const nextIndex = path.closed
    ? (pointIndex + 1) % path.points.length
    : Math.min(path.points.length - 1, pointIndex + 1);
  const roll = MathUtils.lerp(
    path.points[pointIndex]!.roll,
    path.points[nextIndex]!.roll,
    parameter - pointIndex,
  );
  const bank = MathUtils.clamp(
    -Math.atan((clock.speed ** 2 * curvature) / 9.81) * path.bankStrength,
    -Math.PI / 3,
    Math.PI / 3,
  );
  quaternion.multiply(
    new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), MathUtils.degToRad(roll) + bank),
  );
  const speed = !path.closed && clock.distance >= length ? 0 : clock.speed;
  return {
    position: point.toArray() as Vec3,
    rotation: path.orientation === 'fixed' ? fixedRotation : rotationFor(quaternion),
    distance: clock.distance,
    speed,
    curvature,
  };
}

export function bakeMotionPath(object: MotionObject, fps = 24): ObjectKeyframe[] {
  if (!object.motion) throw new DomainError('Object has no motion path');
  const path = object.motion;
  const duration = pathDuration(path);
  const count = Math.ceil(duration * fps);
  if (count > 36000) throw new DomainError('A path bake is limited to 36000 frames');
  return Array.from({ length: count + 1 }, (_, index) => {
    const time = path.start + Math.min(index / fps, duration);
    const { position, rotation } = sampleMotionPath(path, time, object.rotation);
    return { id: `motion-${crypto.randomUUID()}`, time, position, rotation, easing: 'linear' as const };
  });
}
