import { z } from 'zod';
import type { CameraKeyframe, ShotCamera, Vec3 } from './types';

export type Aspect = '16:9' | '9:16' | '1:1';
export interface OpticsKeyframe {
  id: string;
  time: number;
  focusDistance?: number;
  focusTargetId?: string | null;
  fStop?: number;
  easing: 'linear' | 'smooth' | 'step';
}
export interface CameraOptics {
  enabled: boolean;
  focusDistance: number;
  focusTargetId: string | null;
  fStop: number;
  sensorWidthMm: number;
  keyframes: OpticsKeyframe[];
}
export interface CameraComposition {
  position: Vec3;
  target: Vec3;
  fov: number;
  keyframes: CameraKeyframe[];
}
export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
  thirds: boolean;
}

const finite = z.number().finite();
const identifier = z.string().min(1).max(160);
const easing = z.enum(['linear', 'smooth', 'step']);
const time = finite.min(0).max(86400);
const distance = finite.min(0.03).max(10000);
const fStop = finite.min(0.7).max(64);
const vec3 = z.tuple([finite, finite, finite]);

export const opticsKeyframeSchema = z
  .object({
    id: identifier,
    time,
    focusDistance: distance.optional(),
    focusTargetId: identifier.nullable().optional(),
    fStop: fStop.optional(),
    easing,
  })
  .strict();

export const cameraOpticsSchema = z
  .object({
    enabled: z.boolean(),
    focusDistance: distance,
    focusTargetId: identifier.nullable(),
    fStop,
    sensorWidthMm: finite.min(1).max(100),
    keyframes: z.array(opticsKeyframeSchema),
  })
  .strict();

export const cameraCompositionSchema = z
  .object({
    position: vec3,
    target: vec3,
    fov: finite.min(5).max(150),
    keyframes: z.array(
      z
        .object({ id: identifier, time, position: vec3, target: vec3, fov: finite.min(5).max(150), easing })
        .strict(),
    ),
  })
  .strict();

export const cameraCompositionsSchema = z
  .object({
    '16:9': cameraCompositionSchema.optional(),
    '9:16': cameraCompositionSchema.optional(),
    '1:1': cameraCompositionSchema.optional(),
  })
  .strict();

const inset = finite.min(0).max(0.45);
export const safeAreaSchema = z
  .object({ top: inset, right: inset, bottom: inset, left: inset, thirds: z.boolean() })
  .strict();

export function aspectComposition(
  camera: ShotCamera & { compositions?: Partial<Record<Aspect, CameraComposition>> },
  aspect?: Aspect,
): ShotCamera {
  const composition = aspect ? camera.compositions?.[aspect] : undefined;
  return composition ? { ...camera, ...composition } : camera;
}

export function sampleOptics(optics: CameraOptics | undefined, time: number): CameraOptics | undefined {
  if (!optics) return undefined;
  const result = { ...optics };
  const frames = [...optics.keyframes].sort((left, right) => left.time - right.time);
  const sampledTime = Number.isFinite(time) ? Math.max(0, time) : 0;
  for (const field of ['focusDistance', 'fStop'] as const) {
    let previous = { time: 0, value: optics[field] };
    result[field] = previous.value;
    for (const frame of frames) {
      const value = frame[field];
      if (value === undefined) continue;
      if (frame.time <= sampledTime) {
        previous = { time: frame.time, value };
        result[field] = value;
        continue;
      }
      const progress = Math.max(0, Math.min(1, (sampledTime - previous.time) / (frame.time - previous.time)));
      const weight =
        frame.easing === 'step'
          ? 0
          : frame.easing === 'smooth'
            ? progress * progress * (3 - 2 * progress)
            : progress;
      result[field] = previous.value + (value - previous.value) * weight;
      break;
    }
  }
  for (const frame of frames) {
    if (frame.time > sampledTime) break;
    if (frame.focusTargetId !== undefined) result.focusTargetId = frame.focusTargetId;
  }
  return result;
}
