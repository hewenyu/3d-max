import { z } from 'zod';
import {
  cameraCompositionSchema,
  cameraOpticsSchema,
  opticsKeyframeSchema,
  type Aspect,
  type CameraComposition,
  type CameraOptics,
  type OpticsKeyframe,
} from './camera-optics';
import { DomainError } from './domain-error';
import type { Command, Project, ShotCamera } from './types';

const identifier = z.string().min(1).max(160);
export const aspectSchema = z.enum(['16:9', '9:16', '1:1']);
export const cameraSettingsCommandDefinitions = [
  {
    type: 'camera.composition.set',
    description:
      'Save independent position, target, field of view and animation for one output aspect. Other aspects and the shared base composition remain unchanged.',
    schema: z.object({ id: identifier, aspect: aspectSchema, composition: cameraCompositionSchema }).strict(),
  },
  {
    type: 'camera.composition.delete',
    description:
      'Remove one aspect-specific camera composition so that aspect uses the shared base composition.',
    schema: z.object({ id: identifier, aspect: aspectSchema }).strict(),
  },
  {
    type: 'camera.optics.set',
    description:
      'Set independent optical focus and visible depth of field. focusTargetId tracks a scene object without changing camera aim; null uses focusDistance in meters. fStop and sensorWidthMm control optical blur.',
    schema: z.object({ id: identifier, optics: cameraOpticsSchema }).strict(),
  },
  {
    type: 'camera.optics.keyframe.set',
    description:
      'Set an optical focus/rack-focus key in camera source time. Sparse focus distance and aperture interpolate independently; focusTargetId changes discretely.',
    schema: z
      .object({
        id: identifier,
        keyframe: opticsKeyframeSchema.extend({ id: identifier.optional() }).strict(),
      })
      .strict(),
  },
  {
    type: 'camera.optics.keyframe.delete',
    description: 'Delete one optical focus key by keyframeId.',
    schema: z.object({ id: identifier, keyframeId: identifier }).strict(),
  },
];

export function cameraTrack(camera: ShotCamera, aspect?: Aspect): ShotCamera | CameraComposition {
  if (!aspect) return camera;
  const track = camera.compositions?.[aspect];
  if (!track) throw new DomainError(`Create the ${aspect} composition before editing its keys`);
  return track;
}

export function applyCameraSettingsCommand(project: Project, command: Command): unknown {
  const p = command.payload;
  const camera = project.cameras.find((item) => item.id === p.id);
  if (!camera) throw new DomainError(`Camera not found: ${String(p.id)}`, 'NOT_FOUND', 404);
  const shot = project.shots.find((item) => item.cameraId === camera.id && item.locked);
  if (camera.locked || shot)
    throw new DomainError(`Camera or linked shot is locked: ${shot?.id ?? camera.id}`, 'LOCKED', 409);
  switch (command.type) {
    case 'camera.composition.set':
      (camera.compositions ??= {})[p.aspect as Aspect] = p.composition as CameraComposition;
      return camera.compositions[p.aspect as Aspect];
    case 'camera.composition.delete':
      delete camera.compositions?.[p.aspect as Aspect];
      return { id: camera.id, aspect: p.aspect, deleted: true };
    case 'camera.optics.set':
      camera.optics = p.optics as CameraOptics;
      return camera.optics;
    case 'camera.optics.keyframe.set': {
      if (!camera.optics) throw new DomainError('Configure optical focus before adding keys');
      const key = p.keyframe as OpticsKeyframe;
      const frames = camera.optics.keyframes;
      const byId = frames.findIndex((item) => item.id === key.id);
      const byTime = frames.findIndex((item) => item.time === key.time);
      if (byId >= 0 && byTime >= 0 && byId !== byTime)
        throw new DomainError('Another focus key exists at this time');
      const index = byId >= 0 ? byId : byTime;
      const value = { ...key, id: key.id ?? crypto.randomUUID() };
      if (index < 0) frames.push(value);
      else frames[index] = value;
      frames.sort((a, b) => a.time - b.time);
      return value;
    }
    case 'camera.optics.keyframe.delete': {
      const frames = camera.optics?.keyframes;
      const index = frames?.findIndex((item) => item.id === p.keyframeId) ?? -1;
      if (!frames || index < 0) throw new DomainError('Optical focus key not found', 'NOT_FOUND', 404);
      frames.splice(index, 1);
      return { id: p.keyframeId, deleted: true };
    }
    default:
      throw new DomainError(`Unknown camera settings command: ${command.type}`);
  }
}
