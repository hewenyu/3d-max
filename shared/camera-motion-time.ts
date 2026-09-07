import { DomainError } from './domain-error';
import { resolveShotProject } from './production';
import { cameraToClipTime, clipDuration, sampleClipTime, sourceToClipTime } from './time-map';
import type { Project, ShotCamera } from './types';
import type { CameraMotion } from './camera-motion';

export function cameraMotionTiming(project: Project, camera: ShotCamera, input: CameraMotion) {
  if (Boolean(input.sequenceId) !== Boolean(input.clipId))
    throw new DomainError('Camera motion requires sequenceId and clipId together');
  const sequence = input.sequenceId ? project.sequences.find((item) => item.id === input.sequenceId) : null;
  const clip = input.clipId ? sequence?.clips.find((item) => item.id === input.clipId) : null;
  if (input.clipId && !clip) throw new DomainError('Camera motion clip not found', 'NOT_FOUND', 404);
  if (input.shotId && clip && input.shotId !== clip.shotId)
    throw new DomainError('Camera motion clip does not use the specified shot');
  const shotId = input.shotId ?? clip?.shotId;
  const shot = shotId ? project.shots.find((item) => item.id === shotId) : null;
  if (shotId && (!shot || shot.cameraId !== camera.id))
    throw new DomainError('Camera motion shot does not use this camera');
  const context = shot ? resolveShotProject(project, shot) : project;
  if (!clip)
    return {
      project: context,
      reverse: false,
      initialTime: input.start,
      duration: input.end - input.start,
      fraction: (time: number) => (time - input.start) / (input.end - input.start),
      sampleTime: (fraction: number) => input.start + fraction * (input.end - input.start),
      sourceTime: (time: number) => time,
      cameraTime: (time: number) => time,
    };
  const first = sampleClipTime(clip, 0).cameraTime;
  const last = sampleClipTime(clip, clipDuration(clip)).cameraTime;
  if (first === last)
    throw new DomainError(
      'A frozen camera clock cannot store a moving camera path; use a nonzero camera rate',
    );
  if (input.start < Math.min(first, last) - 1e-8 || input.end > Math.max(first, last) + 1e-8)
    throw new DomainError('Camera motion interval must lie inside the specified clip camera-time range');
  const reverse = last < first;
  const start = cameraToClipTime(clip, reverse ? input.end : input.start);
  const end = cameraToClipTime(clip, reverse ? input.start : input.end);
  return {
    project: context,
    reverse,
    initialTime: reverse ? input.end : input.start,
    duration: end - start,
    fraction: (time: number) => (cameraToClipTime(clip, time) - start) / (end - start),
    sampleTime: (fraction: number) => sampleClipTime(clip, start + fraction * (end - start)).cameraTime,
    sourceTime: (time: number) => sampleClipTime(clip, cameraToClipTime(clip, time)).sourceTime,
    cameraTime: (time: number) =>
      time >= clip.sourceIn && time <= clip.sourceOut
        ? sampleClipTime(clip, sourceToClipTime(clip, time)).cameraTime
        : Number.NaN,
  };
}
