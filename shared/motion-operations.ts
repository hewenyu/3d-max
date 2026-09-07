import { DomainError } from './domain-error';
import { createObject, id } from './project';
import type { Command, ObjectKeyframe, Project } from './types';
import { rigidBodySchema } from './physics';
import {
  bakeMotionPath,
  compilePath,
  effectSchema,
  motionPathSchema,
  pathDistance,
  pathDuration,
  simulationApplySchema,
  vehicleSchema,
  motionEventSchema,
  type MotionObject,
} from './motion';

function editable(project: Project, objectId: unknown): MotionObject {
  const object = project.objects.find((item) => item.id === objectId);
  if (!object) throw new DomainError(`Object not found: ${String(objectId)}`, 'NOT_FOUND', 404);
  let current = object;
  while (current) {
    if (current.locked) throw new DomainError(`Object or parent is locked: ${current.id}`, 'LOCKED', 409);
    const parent = project.objects.find((item) => item.id === current.parentId);
    if (!parent) break;
    current = parent;
  }
  return object;
}

export function replaceTransformKeys(
  object: MotionObject,
  start: number,
  end: number,
  keyframes: ObjectKeyframe[],
) {
  if (object.attachment || object.keyframes.some((frame) => frame.time <= end && frame.attachment))
    throw new DomainError('Detach objects from bones before baking world motion');
  const preserved = object.keyframes.flatMap((frame) => {
    if (frame.time < start - 1e-8 || frame.time > end + 1e-8) return [frame];
    const { position: _position, rotation: _rotation, ...rest } = frame;
    return Object.keys(rest).some((key) => !['id', 'time', 'easing'].includes(key)) ? [rest] : [];
  });
  for (const frame of keyframes) {
    const existing = preserved.find((item) => Math.abs(item.time - frame.time) < 1e-8);
    if (existing) Object.assign(existing, frame, { id: existing.id });
    else preserved.push(frame);
  }
  object.keyframes = preserved.sort((left, right) => left.time - right.time);
  object.rotationInterpolation = 'quaternion';
}

export function applyMotionCommand(project: Project, command: Command): unknown | undefined {
  const { type, payload } = command;
  if (type === 'vehicle.create' || type === 'effect.create') {
    const object: MotionObject = createObject(
      'box',
      String(
        payload.name ?? (type === 'vehicle.create' ? (payload.kind === 'car' ? '汽车' : '飞行器') : '效果'),
      ),
    );
    object.id = String(payload.id ?? id(type === 'vehicle.create' ? 'vehicle' : 'effect'));
    if (project.objects.some((item) => item.id === object.id))
      throw new DomainError('Object ID already exists');
    if (payload.position) object.position = payload.position as MotionObject['position'];
    if (payload.rotation) object.rotation = payload.rotation as MotionObject['rotation'];
    if (type === 'vehicle.create') {
      object.vehicle = vehicleSchema.parse({ kind: payload.kind });
      object.dimensions =
        (payload.dimensions as MotionObject['dimensions']) ??
        (payload.kind === 'car' ? [1.85, 1.45, 4.4] : [5, 1.4, 6]);
    } else object.effect = effectSchema.parse(payload.effect);
    project.objects.push(object);
    return object;
  }
  if (type === 'simulation.apply') {
    const input = simulationApplySchema.parse(payload);
    if (
      input.end <= input.start ||
      new Set(input.tracks.map((track) => track.id)).size !== input.tracks.length
    )
      throw new DomainError('Simulation range or tracks are invalid');
    if (input.tracks.reduce((sum, track) => sum + track.keyframes.length, 0) > 200000)
      throw new DomainError('Simulation bake is limited to 200000 total keys');
    for (const track of input.tracks) {
      const object = editable(project, track.id);
      if (track.keyframes.some((frame) => frame.time < input.start - 1e-8 || frame.time > input.end + 1e-8))
        throw new DomainError('Simulation keyframe is outside its interval');
      replaceTransformKeys(object, input.start, input.end, track.keyframes);
      object.motionEvents = (object.motionEvents ?? []).filter(
        (event) => event.time < input.start || event.time > input.end,
      );
    }
    for (const item of input.events) {
      if (item.event.time < input.start || item.event.time > input.end)
        throw new DomainError('Simulation event is outside its interval');
      const object = editable(project, item.objectId);
      (object.motionEvents ??= []).push(item.event);
    }
    return {
      objectIds: input.tracks.map((track) => track.id),
      keyframes: input.tracks.reduce((sum, track) => sum + track.keyframes.length, 0),
      events: input.events.length,
    };
  }
  if (
    ![
      'motion.path.set',
      'motion.events.set',
      'motion.path.fit',
      'motion.path.bake',
      'vehicle.configure',
      'physics.body.set',
      'effect.configure',
    ].includes(type)
  )
    return undefined;
  const object = editable(project, payload.id);
  if (type === 'motion.events.set') {
    object.motionEvents = motionEventSchema
      .array()
      .max(10000)
      .parse(payload.events)
      .sort((left, right) => left.time - right.time);
  } else if (type === 'motion.path.set') {
    if (payload.path === null) delete object.motion;
    else {
      object.motion = motionPathSchema.parse(payload.path);
      compilePath(object.motion);
    }
  } else if (type === 'motion.path.fit') {
    if (!object.motion) throw new DomainError('Object has no motion path');
    const path = structuredClone(object.motion);
    const { length } = compilePath(path);
    if (payload.duration) {
      const ratio = Number(payload.duration) / pathDuration(path);
      path.speed.forEach((segment) => {
        segment.duration *= ratio;
      });
    }
    const distance = pathDistance(path);
    if (distance <= 0) throw new DomainError('A stationary speed curve cannot be fit to a path');
    const factor = Math.max(0, length - path.distanceOffset) / distance;
    path.speed.forEach((segment) => {
      segment.fromSpeed *= factor;
      segment.toSpeed *= factor;
    });
    object.motion = motionPathSchema.parse(path);
  } else if (type === 'motion.path.bake') {
    const keys = bakeMotionPath(object, Number(payload.fps ?? 24));
    replaceTransformKeys(
      object,
      object.motion!.start,
      object.motion!.start + pathDuration(object.motion!),
      keys,
    );
    return {
      id: object.id,
      keyframes: keys.length,
      duration: pathDuration(object.motion!),
      distance: pathDistance(object.motion!),
    };
  } else if (type === 'vehicle.configure') {
    if (object.type === 'actor' || object.type === 'group')
      throw new DomainError('Choose a mesh object for vehicle geometry');
    if (payload.vehicle === null) delete object.vehicle;
    else {
      object.vehicle = vehicleSchema.parse(payload.vehicle);
      delete object.modeling;
      delete object.assetUrl;
      delete object.animationName;
    }
  } else if (type === 'physics.body.set') {
    if (payload.body === null) delete object.physics;
    else {
      object.physics = rigidBodySchema.parse(payload.body);
      if (object.physics.shape === 'mesh' && object.physics.mode !== 'static')
        throw new DomainError('Mesh collision shapes require a static rigid body');
    }
  } else object.effect = effectSchema.parse(payload.effect);
  return { id: object.id };
}
