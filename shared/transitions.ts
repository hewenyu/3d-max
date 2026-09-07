import type { Project, Sequence, SequenceClip, Shot, TimelineSample } from './types';
import { clipDuration, sampleClipTime } from './time-map';
import { sampleCamera, sampleTimeline, sequenceDuration } from './timeline';

export interface DissolveTransition {
  type: 'dissolve';
  duration: number;
}

/** Outside a trimmed interval, real source handles advance at the endpoint speed. */
export function sampleClipHandle(clip: SequenceClip, localTime: number) {
  const edge = Math.max(0, Math.min(clipDuration(clip), localTime));
  const sample = sampleClipTime(clip, edge);
  const extra = localTime - edge;
  return {
    ...sample,
    clipTime: localTime,
    sourceTime: sample.sourceTime + extra * sample.playbackRate,
    cameraTime:
      sample.cameraTime +
      extra *
        (clip.cameraTiming?.mode === 'independent' ? (clip.cameraTiming.rate ?? 1) : sample.playbackRate),
  };
}

function clipSample(
  project: Project,
  clip: SequenceClip,
  start: number,
  time: number,
  duration: number,
): TimelineSample {
  const shot = project.shots.find((item) => item.id === clip.shotId) ?? null;
  const timing = sampleClipHandle(clip, time - start);
  const camera = project.cameras.find((item) => item.id === shot?.cameraId);
  return {
    clip,
    shot,
    camera: camera ? sampleCamera(camera, timing.cameraTime, project.settings.aspect) : null,
    ...timing,
    sequenceTime: time,
    duration,
    clipStart: start,
  };
}

export function sampleSequenceTransition(
  project: Project,
  time: number,
  sequenceId = project.activeSequenceId,
) {
  const sequence = project.sequences.find((item) => item.id === sequenceId);
  const duration = sequenceDuration(project, sequenceId);
  let start = 0;
  let previousStart = 0;
  for (const [index, clip] of (sequence?.clips ?? []).entries()) {
    const transition = clip.transitionIn;
    if (transition && index > 0) {
      const half = transition.duration / 2;
      if (time >= start - half && time < start + half) {
        const outgoing = clipSample(project, sequence!.clips[index - 1], previousStart, time, duration);
        const incoming = clipSample(project, clip, start, time, duration);
        return { outgoing, incoming, progress: (time - start + half) / transition.duration };
      }
    }
    previousStart = start;
    start += clipDuration(clip);
  }
  return null;
}

export function sampleSequenceOpacity(project: Project, time: number, sequenceId = project.activeSequenceId) {
  const sample = sampleTimeline(project, time, sequenceId);
  if (!sample.clip) return 1;
  const incoming = sample.clip.fadeIn ? sample.clipTime / sample.clip.fadeIn : 1;
  const outgoing = sample.clip.fadeOut
    ? (clipDuration(sample.clip) - sample.clipTime) / sample.clip.fadeOut
    : 1;
  return Math.max(0, Math.min(1, incoming, outgoing));
}

export function transitionIssues(sequence: Sequence, shots: Map<string, Shot>): string[] {
  const issues: string[] = [];
  for (const [index, clip] of sequence.clips.entries()) {
    const previous = sequence.clips[index - 1];
    const next = sequence.clips[index + 1];
    const duration = clipDuration(clip);
    const incoming = clip.transitionIn?.duration ?? 0;
    const outgoing = next?.transitionIn?.duration ?? 0;
    if ((clip.fadeIn ?? 0) + (clip.fadeOut ?? 0) + (incoming + outgoing) / 2 > duration + 1e-8)
      issues.push(`Clip ${clip.id} transition windows overlap or exceed its edit duration`);
    if (incoming && clip.fadeIn) issues.push(`Clip ${clip.id} cannot fade in during an incoming dissolve`);
    if (outgoing && clip.fadeOut) issues.push(`Clip ${clip.id} cannot fade out during an outgoing dissolve`);
    if (!incoming) continue;
    if (!previous) {
      issues.push(`First clip ${clip.id} cannot dissolve from a preceding shot`);
      continue;
    }
    const before = sampleClipHandle(previous, clipDuration(previous) + incoming / 2);
    const after = sampleClipHandle(clip, -incoming / 2);
    const beforeShot = shots.get(previous.shotId);
    const afterShot = shots.get(clip.shotId);
    if (beforeShot && before.sourceTime > beforeShot.sourceOut + 1e-8)
      issues.push(
        `Dissolve into ${clip.id} needs outgoing source handles through ${before.sourceTime.toFixed(3)}s`,
      );
    if (afterShot && after.sourceTime < afterShot.sourceIn - 1e-8)
      issues.push(
        `Dissolve into ${clip.id} needs incoming source handles from ${after.sourceTime.toFixed(3)}s`,
      );
    if ([before.cameraTime, after.cameraTime].some((time) => time < 0 || time > 86400))
      issues.push(`Dissolve into ${clip.id} extends camera time outside 0..86400 seconds`);
  }
  return issues;
}
