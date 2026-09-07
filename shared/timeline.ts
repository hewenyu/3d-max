import type { CameraKeyframe, Project, ShotCamera, TimelineSample, Vec3 } from './types';
import { clipDuration, sampleClipTime } from './time-map';
export { sampleObject } from './object-sampling';
import { aspectComposition, sampleOptics, type Aspect } from './camera-optics';

type Frame = { time: number; easing?: 'linear' | 'smooth' | 'step' };

function interpolate<T>(
  base: T,
  frames: Frame[],
  time: number,
  read: (frame: Frame) => T | undefined,
  mix: (a: T, b: T, t: number) => T,
): T {
  let previous = { time: 0, value: base };
  for (const frame of frames) {
    const value = read(frame);
    if (value === undefined) continue;
    if (frame.time <= time) {
      previous = { time: frame.time, value };
      continue;
    }
    const progress = Math.max(0, Math.min(1, (time - previous.time) / (frame.time - previous.time)));
    const eased =
      frame.easing === 'step'
        ? 0
        : frame.easing === 'smooth'
          ? progress * progress * (3 - 2 * progress)
          : progress;
    return mix(previous.value, value, eased);
  }
  return previous.value;
}

const scalar = (a: number, b: number, t: number) => a + (b - a) * t;
const vector = (a: Vec3, b: Vec3, t: number): Vec3 => [
  scalar(a[0], b[0], t),
  scalar(a[1], b[1], t),
  scalar(a[2], b[2], t),
];

export function sampleCamera(input: ShotCamera, time: number, aspect?: Aspect): ShotCamera {
  const camera = aspectComposition(input, aspect);
  const result = structuredClone(camera);
  const t = Number.isFinite(time) ? Math.max(0, time) : 0;
  const frames = [...camera.keyframes].sort((a, b) => a.time - b.time);
  result.position = interpolate(
    camera.position,
    frames,
    t,
    (frame) => (frame as CameraKeyframe).position,
    vector,
  );
  result.target = interpolate(camera.target, frames, t, (frame) => (frame as CameraKeyframe).target, vector);
  result.fov = interpolate(camera.fov, frames, t, (frame) => (frame as CameraKeyframe).fov, scalar);
  if (camera.optics) result.optics = sampleOptics(camera.optics, t);
  return result;
}

export function sequenceDuration(project: Project, sequenceId = project.activeSequenceId): number {
  const sequence = project.sequences.find((item) => item.id === sequenceId);
  return sequence?.clips.reduce((sum, clip) => sum + clipDuration(clip), 0) ?? 0;
}

export function sampleTimeline(
  project: Project,
  time: number,
  sequenceId = project.activeSequenceId,
): TimelineSample {
  const sequence = project.sequences.find((item) => item.id === sequenceId);
  const duration = sequenceDuration(project, sequenceId);
  const sequenceTime = Math.max(0, Math.min(duration, Number.isFinite(time) ? time : 0));
  let clipStart = 0;
  for (const [index, clip] of (sequence?.clips ?? []).entries()) {
    const end = clipStart + clipDuration(clip);
    if (sequenceTime < end || index === sequence!.clips.length - 1) {
      const shot = project.shots.find((item) => item.id === clip.shotId) ?? null;
      const timing = sampleClipTime(clip, sequenceTime - clipStart);
      const camera = project.cameras.find((item) => item.id === shot?.cameraId);
      return {
        clip,
        shot,
        camera: camera ? sampleCamera(camera, timing.cameraTime, project.settings.aspect) : null,
        ...timing,
        sequenceTime,
        duration,
        clipStart,
      };
    }
    clipStart = end;
  }
  return {
    clip: null,
    shot: null,
    camera: project.cameras[0] ? sampleCamera(project.cameras[0], 0, project.settings.aspect) : null,
    sourceTime: 0,
    cameraTime: 0,
    clipTime: 0,
    playbackRate: 1,
    audioMuted: false,
    sequenceTime,
    duration,
    clipStart: 0,
  };
}
