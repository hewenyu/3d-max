import type { CameraTiming, ClipRetiming, SequenceClip, SpeedSegment } from './types';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const curve = (easing: SpeedSegment['easing'], u: number) =>
  easing === 'constant' ? 0 : easing === 'linear' ? u : u * u * (3 - 2 * u);
const primitive = (easing: SpeedSegment['easing'], u: number) =>
  easing === 'constant' ? 0 : easing === 'linear' ? (u * u) / 2 : u ** 3 - u ** 4 / 2;

export function segmentSpeed(segment: SpeedSegment, fraction: number): number {
  const start = segment.curveIn ?? 0;
  const end = segment.curveOut ?? 1;
  return (
    segment.fromSpeed +
    (segment.toSpeed - segment.fromSpeed) *
      curve(segment.easing, start + clamp(fraction, 0, 1) * (end - start))
  );
}

/** Analytic integration avoids frame quantization and preserves ramps when clips are trimmed. */
export function segmentSourceDuration(segment: SpeedSegment, fraction = 1): number {
  const start = segment.curveIn ?? 0;
  const end = segment.curveOut ?? 1;
  const u = clamp(fraction, 0, 1);
  const area =
    (primitive(segment.easing, start + u * (end - start)) - primitive(segment.easing, start)) / (end - start);
  return segment.duration * (segment.fromSpeed * u + (segment.toSpeed - segment.fromSpeed) * area);
}

export function retimingSourceDuration(retiming: ClipRetiming): number {
  return retiming.segments.reduce((sum, segment) => sum + segmentSourceDuration(segment), 0);
}

export function clipDuration(clip: SequenceClip): number {
  return (
    clip.retiming?.segments.reduce((sum, segment) => sum + segment.duration, 0) ??
    clip.sourceOut - clip.sourceIn
  );
}

export function clipSpeedSegments(clip: SequenceClip): SpeedSegment[] {
  return (
    clip.retiming?.segments ?? [
      { duration: clip.sourceOut - clip.sourceIn, fromSpeed: 1, toSpeed: 1, easing: 'constant' },
    ]
  );
}

export function hasSpeedRamp(retiming: ClipRetiming): boolean {
  return retiming.segments.some(
    (segment) => segment.easing !== 'constant' && Math.abs(segment.fromSpeed - segment.toSpeed) > 1e-9,
  );
}

export function fitRetiming(retiming: ClipRetiming, sourceDuration: number): ClipRetiming {
  const factor = sourceDuration / retimingSourceDuration(retiming);
  return {
    ...structuredClone(retiming),
    segments: retiming.segments.map((segment) => ({ ...segment, duration: segment.duration * factor })),
  };
}

export function sampleClipTime(clip: SequenceClip, time: number) {
  const clipTime = clamp(Number.isFinite(time) ? time : 0, 0, clipDuration(clip));
  let sourceTime = clip.sourceIn;
  let remaining = clipTime;
  let playbackRate = 1;
  const segments = clipSpeedSegments(clip);
  for (const [index, segment] of segments.entries()) {
    if (remaining < segment.duration || index === segments.length - 1) {
      const fraction = clamp(remaining / segment.duration, 0, 1);
      sourceTime += segmentSourceDuration(segment, fraction);
      playbackRate = segmentSpeed(segment, fraction);
      break;
    }
    sourceTime += segmentSourceDuration(segment);
    remaining -= segment.duration;
  }
  sourceTime = clamp(sourceTime, clip.sourceIn, clip.sourceOut);
  const cameraTime =
    clip.cameraTiming?.mode === 'independent'
      ? (clip.cameraTiming.sourceIn ?? clip.sourceIn) + clipTime * (clip.cameraTiming.rate ?? 1)
      : sourceTime;
  return { clipTime, sourceTime, cameraTime, playbackRate, audioMuted: clip.retiming?.audio === 'mute' };
}

export function sourceToClipTime(clip: SequenceClip, sourceTime: number): number {
  const target = clamp(sourceTime, clip.sourceIn, clip.sourceOut);
  if (!clip.retiming) return target - clip.sourceIn;
  let low = 0;
  let high = clipDuration(clip);
  for (let iteration = 0; iteration < 54; iteration++) {
    const mid = (low + high) / 2;
    if (sampleClipTime(clip, mid).sourceTime < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export function cameraToClipTime(clip: SequenceClip, cameraTime: number): number {
  if (clip.cameraTiming?.mode !== 'independent') return sourceToClipTime(clip, cameraTime);
  const rate = clip.cameraTiming.rate ?? 1;
  return rate === 0
    ? 0
    : clamp((cameraTime - (clip.cameraTiming.sourceIn ?? clip.sourceIn)) / rate, 0, clipDuration(clip));
}

function sliceSegments(clip: SequenceClip, start: number, end: number): SpeedSegment[] {
  const result: SpeedSegment[] = [];
  let offset = 0;
  for (const segment of clipSpeedSegments(clip)) {
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + segment.duration);
    if (to - from > 1e-10) {
      const curveIn = segment.curveIn ?? 0;
      const span = (segment.curveOut ?? 1) - curveIn;
      result.push({
        ...segment,
        duration: to - from,
        curveIn: curveIn + ((from - offset) / segment.duration) * span,
        curveOut: curveIn + ((to - offset) / segment.duration) * span,
      });
    }
    offset += segment.duration;
  }
  return result;
}

export function trimClip(clip: SequenceClip, sourceIn: number, sourceOut: number): SequenceClip {
  if (sourceOut <= sourceIn || sourceIn < clip.sourceIn - 1e-8 || sourceOut > clip.sourceOut + 1e-8)
    throw new Error('Trim range must lie inside the current clip source interval');
  const start = sourceToClipTime(clip, sourceIn);
  const end = sourceToClipTime(clip, sourceOut);
  const result = { ...structuredClone(clip), sourceIn, sourceOut };
  if (clip.retiming) result.retiming = { ...clip.retiming, segments: sliceSegments(clip, start, end) };
  if (clip.cameraTiming?.mode === 'independent')
    result.cameraTiming = { ...clip.cameraTiming, sourceIn: sampleClipTime(clip, start).cameraTime };
  return result;
}

export function splitClip(clip: SequenceClip, time: number, rightId: string): [SequenceClip, SequenceClip] {
  if (time <= 1e-8 || time >= clipDuration(clip) - 1e-8)
    throw new Error('Split point must be inside the clip');
  const source = sampleClipTime(clip, time).sourceTime;
  const left = trimClip(clip, clip.sourceIn, source);
  const right = { ...trimClip(clip, source, clip.sourceOut), id: rightId };
  delete left.fadeOut;
  delete right.fadeIn;
  delete right.transitionIn;
  return [left, right];
}

export function retimeClip(
  clip: SequenceClip,
  retiming: ClipRetiming | null,
  fitSourceRange = true,
  cameraTiming?: CameraTiming,
): SequenceClip {
  const result = structuredClone(clip);
  if (retiming === null) delete result.retiming;
  else {
    result.retiming = fitSourceRange
      ? fitRetiming(retiming, clip.sourceOut - clip.sourceIn)
      : structuredClone(retiming);
    if (!fitSourceRange) result.sourceOut = result.sourceIn + retimingSourceDuration(result.retiming);
  }
  if (cameraTiming) result.cameraTiming = structuredClone(cameraTiming);
  return result;
}
