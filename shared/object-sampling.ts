import { sampleQuaternionRotation } from './motion';
import type { Action, ActorPose, Attachment, ObjectKeyframe, SceneObject, Vec3 } from './types';

type Key<T> = { time: number; easing?: ObjectKeyframe['easing']; value: T };
interface Tracks {
  position: Key<Vec3>[];
  rotation: Key<Vec3>[];
  scale: Key<Vec3>[];
  pose: Map<keyof ActorPose, Key<number>[]>;
  action: Key<Action>[];
  lookAt: Key<string | null>[];
  attachment: Key<Attachment | null>[];
}
const tracksByObject = new WeakMap<SceneObject, Tracks>();
function tracksFor(object: SceneObject, immutable: boolean): Tracks {
  const cached = immutable ? tracksByObject.get(object) : undefined;
  if (cached) return cached;
  const frames = [...object.keyframes].sort((left, right) => left.time - right.time);
  const channel = <T>(read: (frame: ObjectKeyframe) => T | undefined): Key<T>[] =>
    frames.flatMap((frame) => {
      const value = read(frame);
      return value === undefined ? [] : [{ time: frame.time, easing: frame.easing, value }];
    });
  const tracks: Tracks = {
    position: channel((frame) => frame.position),
    rotation: channel((frame) => frame.rotation),
    scale: channel((frame) => frame.scale),
    pose: new Map(
      (Object.keys(object.actor?.pose ?? {}) as (keyof ActorPose)[]).map((key) => [
        key,
        channel((frame) => frame.pose?.[key]),
      ]),
    ),
    action: channel((frame) => frame.action),
    lookAt: channel((frame) => frame.lookAtId),
    attachment: channel((frame) => frame.attachment),
  };
  if (immutable) tracksByObject.set(object, tracks);
  return tracks;
}
function upperBound<T>(keys: Key<T>[], time: number): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (keys[middle]!.time <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}
function hold<T>(keys: Key<T>[], base: T, time: number): T {
  const index = upperBound(keys, time);
  return index ? keys[index - 1]!.value : base;
}
function sample<T>(
  keys: Key<T>[],
  base: T,
  time: number,
  mix: (left: T, right: T, fraction: number) => T,
): T {
  const index = upperBound(keys, time);
  const before = index ? keys[index - 1]! : { time: 0, value: base };
  const after = keys[index];
  if (!after) return before.value;
  let fraction = Math.max(0, Math.min(1, (time - before.time) / (after.time - before.time)));
  if (after.easing === 'step') fraction = 0;
  else if (after.easing === 'smooth') fraction = fraction * fraction * (3 - 2 * fraction);
  return mix(before.value, after.value, fraction);
}
const scalar = (left: number, right: number, fraction: number) => left + (right - left) * fraction;
const vector = (left: Vec3, right: Vec3, fraction: number) =>
  left.map((value, index) => scalar(value, right[index]!, fraction)) as Vec3;

/** render mode requires immutable input; returned track/geometry metadata remains read-only and shared. */
export function sampleObject(
  object: SceneObject,
  time: number,
  options: { render?: boolean } = {},
): SceneObject {
  const result = options.render
    ? { ...object, ...(object.actor ? { actor: { ...object.actor, pose: { ...object.actor.pose } } } : {}) }
    : structuredClone(object);
  const t = Number.isFinite(time) ? Math.max(0, time) : 0;
  const tracks = tracksFor(object, Boolean(options.render));
  for (const key of ['position', 'rotation', 'scale'] as const)
    result[key] = [...sample(tracks[key], object[key], t, vector)];
  if (object.rotationInterpolation === 'quaternion')
    result.rotation = [...sampleQuaternionRotation(object, t, Boolean(options.render))];
  if (object.actor && result.actor) {
    for (const [key, channel] of tracks.pose)
      result.actor.pose[key] = sample(channel, object.actor.pose[key], t, scalar);
    result.actor.action = hold(tracks.action, object.actor.action, t);
    result.actor.lookAtId = hold(tracks.lookAt, object.actor.lookAtId, t);
  }
  const attachment = hold(tracks.attachment, object.attachment, t);
  if (attachment !== undefined) result.attachment = structuredClone(attachment);
  return result;
}
