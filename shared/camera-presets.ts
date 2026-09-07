import { Box3, MathUtils, Vector3 } from 'three';
import { z } from 'zod';
import { aspectComposition } from './camera-optics';
import { ContinuityScene } from './continuity-scene';
import { DomainError } from './domain-error';
import { resolveShotProject } from './production';
import { sampleCamera } from './timeline';
import type { Command, Project, Vec3 } from './types';

export const cameraPresetKinds = [
  'extreme_wide',
  'wide',
  'medium',
  'close',
  'detail',
  'high',
  'low',
  'two_shot',
  'over_shoulder',
] as const;
export type CameraPresetKind = (typeof cameraPresetKinds)[number];
export const cameraPresetSchema = z
  .object({
    id: z.string().min(1).max(160),
    preset: z.enum(cameraPresetKinds),
    shotId: z.string().min(1).max(160).optional(),
    subjectIds: z.array(z.string().min(1).max(160)).min(1).max(100).optional(),
    sourceTime: z.number().finite().min(0).max(86400).default(0),
    cameraTime: z.number().finite().min(0).max(86400).optional(),
    mode: z.enum(['base', 'keyframe']).default('base'),
    aspect: z.enum(['16:9', '9:16', '1:1']).optional(),
    side: z.enum(['left', 'right']).default('right'),
  })
  .strict();
export const cameraPresetCommandDefinitions = [
  {
    type: 'camera.preset',
    description:
      'Generate editable camera parameters fitted to sampled subject bounds in the shot-bound scene/performance. Supports scale-aware extreme_wide, wide, medium, close, detail, high, low, two_shot and over_shoulder. subjectIds defaults to shot subjects or visible scene objects. Two-shot/over-shoulder require exactly two subjects; over-shoulder order is foreground then background. sourceTime samples acting; cameraTime writes independent camera keys. aspect writes an independent output composition. Result reports conservative geometry approximations.',
    schema: cameraPresetSchema,
  },
];

function corners(box: Box3) {
  return [box.min.x, box.max.x].flatMap((x) =>
    [box.min.y, box.max.y].flatMap((y) => [box.min.z, box.max.z].map((z) => new Vector3(x, y, z))),
  );
}
function croppedBounds(box: Box3, preset: CameraPresetKind, actor: boolean) {
  const bounds = box.clone();
  if (!actor || !['medium', 'close', 'detail', 'over_shoulder'].includes(preset)) return bounds;
  const size = bounds.getSize(new Vector3());
  const lower = preset === 'medium' || preset === 'over_shoulder' ? 0.48 : preset === 'close' ? 0.7 : 0.86;
  bounds.min.y += size.y * lower;
  if (preset === 'detail') {
    const center = bounds.getCenter(new Vector3());
    bounds.min.x = center.x - size.x * 0.22;
    bounds.max.x = center.x + size.x * 0.22;
  }
  return bounds;
}

export function applyCameraPreset(project: Project, command: Command) {
  const input = cameraPresetSchema.parse(command.payload);
  const camera = project.cameras.find((item) => item.id === input.id);
  if (!camera) throw new DomainError('Camera not found', 'NOT_FOUND', 404);
  const linked = project.shots.filter((item) => item.cameraId === camera.id);
  if (camera.locked || linked.some((shot) => shot.locked))
    throw new DomainError('Camera or linked shot is locked', 'LOCKED', 409);
  const shot = input.shotId ? project.shots.find((item) => item.id === input.shotId) : linked[0];
  if (input.shotId && (!shot || shot.cameraId !== camera.id))
    throw new DomainError('Shot does not use this camera');
  if (!input.shotId && new Set(linked.map((item) => `${item.sceneId}:${item.performanceId}`)).size > 1)
    throw new DomainError('Specify shotId for a camera shared across scenes or performances');
  const context = resolveShotProject(project, shot ?? null);
  const aspect = input.aspect ?? project.settings.aspect;
  const ratio = aspect === '16:9' ? 16 / 9 : aspect === '9:16' ? 9 / 16 : 1;
  const subjectIds =
    input.subjectIds ??
    (shot?.subjectIds.length
      ? shot.subjectIds
      : context.objects
          .filter(
            (object) =>
              object.visible &&
              !['plane', 'group'].includes(object.type) &&
              !object.effect &&
              !shot?.hiddenIds.includes(object.id),
          )
          .map((object) => object.id));
  const ids = [...new Set(subjectIds)];
  if (!ids.length) throw new DomainError('Select at least one visible subject');
  if (['two_shot', 'over_shoulder'].includes(input.preset) && ids.length !== 2)
    throw new DomainError('Two-shot and over-shoulder presets require exactly two subjects');
  const scene = new ContinuityScene(context, shot?.sceneId ?? 'active');
  try {
    const frame = scene.sample({
      shot: shot ?? null,
      camera: null,
      sourceTime: input.sourceTime,
      cameraTime: input.cameraTime ?? input.sourceTime,
      clip: null,
      clipTime: 0,
      playbackRate: 1,
      audioMuted: false,
      sequenceTime: 0,
      duration: 0,
      clipStart: 0,
    });
    const subjects = ids.map((id) => {
      const state = frame.objects.get(id);
      if (!state || !state.visible || state.bounds.isEmpty())
        throw new DomainError(`Subject is absent, hidden or empty: ${id}`);
      return state;
    });
    const boxes = subjects.map((subject) =>
      croppedBounds(subject.bounds, input.preset, subject.object.type === 'actor'),
    );
    // Non-human close/detail crops use a centered fraction of the object's geometry bounds.
    if (['medium', 'close', 'detail'].includes(input.preset))
      subjects.forEach((subject, index) => {
        if (subject.object.type === 'actor') return;
        const fraction = input.preset === 'medium' ? 0.7 : input.preset === 'close' ? 0.4 : 0.18;
        const center = boxes[index].getCenter(new Vector3());
        const half = boxes[index].getSize(new Vector3()).multiplyScalar(fraction / 2);
        boxes[index].set(center.clone().sub(half), center.clone().add(half));
      });
    const bounds = boxes.reduce((union, box) => union.union(box), new Box3());
    const target = bounds.getCenter(new Vector3());
    const current = sampleCamera(camera, input.cameraTime ?? input.sourceTime, aspect);
    let direction = new Vector3(...current.position).sub(new Vector3(...current.target));
    direction.y = 0;
    if (direction.lengthSq() < 0.00001) direction.set(0.25, 0, 1);
    direction.normalize();
    if (input.preset === 'two_shot') {
      const axis = subjects[1].center.clone().sub(subjects[0].center);
      axis.y = 0;
      if (axis.lengthSq() > 0.00001) {
        const perpendicular = new Vector3(-axis.z, 0, axis.x).normalize();
        if (perpendicular.dot(direction) < 0) perpendicular.negate();
        direction = perpendicular;
      }
    }
    if (input.preset === 'high') direction.y = Math.tan(MathUtils.degToRad(48));
    if (input.preset === 'low') direction.y = -Math.tan(MathUtils.degToRad(18));
    if (input.preset === 'over_shoulder') {
      const foreground = boxes[0].getCenter(new Vector3());
      target.copy(boxes[1].getCenter(new Vector3()));
      direction.copy(foreground).sub(target);
      direction.y = 0;
      if (direction.lengthSq() < 0.01)
        throw new DomainError('Over-shoulder subjects need distinct positions');
      const distance = direction.length();
      direction.normalize();
      const shoulder = new Vector3(-direction.z, 0, direction.x).multiplyScalar(
        Math.max(boxes[0].getSize(new Vector3()).x * 0.8, distance * 0.18) *
          (input.side === 'right' ? 1 : -1),
      );
      direction.multiplyScalar(distance * 1.35).add(shoulder);
    }
    direction.normalize();
    const right = new Vector3(0, 1, 0).cross(direction).normalize();
    const up = direction.clone().cross(right).normalize();
    const fov = ['extreme_wide', 'wide', 'high', 'low'].includes(input.preset)
      ? 50
      : input.preset === 'detail'
        ? 32
        : 40;
    const margin = input.preset === 'extreme_wide' ? 1.85 : input.preset === 'wide' ? 1.2 : 1.12;
    const tanY = Math.tan(MathUtils.degToRad(fov / 2));
    const tanX = tanY * ratio;
    let distance = 0.05;
    for (const point of boxes.flatMap(corners)) {
      const delta = point.clone().sub(target);
      distance = Math.max(
        distance,
        delta.dot(direction) +
          Math.max((Math.abs(delta.dot(right)) * margin) / tanX, (Math.abs(delta.dot(up)) * margin) / tanY) +
          0.03,
      );
    }
    const value = {
      position: target.clone().addScaledVector(direction, distance).toArray() as Vec3,
      target: target.toArray() as Vec3,
      fov,
    };
    if (input.preset === 'low')
      value.position[1] = Math.max(
        value.position[1],
        bounds.min.y + Math.max(0.03, bounds.getSize(new Vector3()).y * 0.05),
      );
    const initial = aspectComposition(camera, input.aspect);
    const track = input.aspect
      ? ((camera.compositions ??= {})[input.aspect] ??= {
          position: [...initial.position],
          target: [...initial.target],
          fov: initial.fov,
          keyframes: structuredClone(initial.keyframes),
        })
      : camera;
    if (input.mode === 'base') Object.assign(track, value);
    else {
      const time = input.cameraTime ?? input.sourceTime;
      const existing = track.keyframes.find((key) => Math.abs(key.time - time) < 0.5 / project.settings.fps);
      const key = {
        id: existing?.id ?? crypto.randomUUID(),
        time,
        ...value,
        easing: existing?.easing ?? ('smooth' as const),
      };
      if (existing) Object.assign(existing, key);
      else track.keyframes.push(key);
      track.keyframes.sort((left, right) => left.time - right.time);
    }
    return {
      ...value,
      preset: input.preset,
      subjectIds: ids,
      sourceTime: input.sourceTime,
      cameraTime: input.cameraTime ?? input.sourceTime,
      aspect,
      mode: input.mode,
      bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
      approximateSubjectIds: subjects
        .filter((subject) => subject.approximation)
        .map((subject) => subject.object.id),
    };
  } finally {
    scene.dispose();
  }
}
