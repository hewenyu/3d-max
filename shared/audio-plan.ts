import { clipDuration, sampleClipTime, sourceToClipTime, trimClip } from './time-map';
import { resolveShotProject } from './production';
import type { AudioClip, Project, RenderOptions, SequenceClip, SpeedSegment } from './types';

export interface AudioPlacement {
  audio: AudioClip;
  start: number;
  duration: number;
  sourceStart: number;
  sourceDuration: number;
  rate: number;
  warp: boolean;
  segments?: SpeedSegment[];
}

/** Bind audio to each shot's performance before mapping source intervals into edit time. */
export function audioPlacements(
  project: Project,
  options: RenderOptions,
  duration: number,
): AudioPlacement[] {
  if (!options.includeAudio) return [];
  const clips: SequenceClip[] = options.shotId
    ? project.shots
        .filter((shot) => shot.id === options.shotId)
        .map((shot) => ({ id: shot.id, shotId: shot.id, sourceIn: shot.sourceIn, sourceOut: shot.sourceOut }))
    : (project.sequences.find((sequence) => sequence.id === (options.sequenceId ?? project.activeSequenceId))
        ?.clips ?? []);
  let position = 0;
  const scoped = clips.map((clip) => {
    const start = position;
    position += clipDuration(clip);
    const shot = project.shots.find((item) => item.id === clip.shotId) ?? null;
    return { clip, start, audio: resolveShotProject(project, shot).audio };
  });
  const tracks = new Map<string, AudioClip>();
  for (const scope of scoped) for (const audio of scope.audio) tracks.set(JSON.stringify(audio), audio);
  const result: AudioPlacement[] = [];
  for (const [key, audio] of tracks) {
    if (audio.muted || audio.volume === 0) continue;
    for (const scope of scoped) {
      if (!scope.audio.some((item) => JSON.stringify(item) === key)) continue;
      const { clip, start } = scope;
      if (audio.sync === 'sequence') {
        if (options.shotId) continue;
        const from = Math.max(start, audio.start, 0);
        const to = Math.min(start + clipDuration(clip), audio.start + audio.duration, duration);
        if (to <= from) continue;
        const previous = result.at(-1);
        if (
          previous &&
          previous.audio === audio &&
          previous.rate === 1 &&
          !previous.warp &&
          Math.abs(previous.start + previous.duration - from) < 1e-8 &&
          Math.abs(previous.sourceStart + previous.sourceDuration - (audio.sourceIn + from - audio.start)) <
            1e-8
        ) {
          previous.duration += to - from;
          previous.sourceDuration += to - from;
        } else
          result.push({
            audio,
            start: from,
            duration: to - from,
            sourceStart: audio.sourceIn + from - audio.start,
            sourceDuration: to - from,
            rate: 1,
            warp: false,
          });
        continue;
      }
      if (clip.retiming?.audio === 'mute') continue;
      const sourceFrom = Math.max(clip.sourceIn, audio.start);
      const sourceTo = Math.min(clip.sourceOut, audio.start + audio.duration);
      if (sourceTo <= sourceFrom) continue;
      const editFrom = sourceToClipTime(clip, sourceFrom);
      const editTo = Math.min(sourceToClipTime(clip, sourceTo), duration - start);
      if (editTo <= editFrom) continue;
      const selected = trimClip(clip, sourceFrom, sampleClipTime(clip, editTo).sourceTime);
      if (clip.retiming?.audio === 'warp') {
        result.push({
          audio,
          start: start + editFrom,
          duration: editTo - editFrom,
          sourceStart: audio.sourceIn + sourceFrom - audio.start,
          sourceDuration: selected.sourceOut - selected.sourceIn,
          rate: sampleClipTime(selected, 0).playbackRate,
          warp: true,
          segments: selected.retiming!.segments,
        });
      } else if (selected.retiming) {
        let destination = start + editFrom;
        let source = audio.sourceIn + sourceFrom - audio.start;
        for (const segment of selected.retiming.segments) {
          if (Math.abs(segment.fromSpeed - segment.toSpeed) > 1e-8)
            throw new Error('Continuous speed ramps require warp or mute source-audio policy');
          result.push({
            audio,
            start: destination,
            duration: segment.duration,
            sourceStart: source,
            sourceDuration: segment.duration * segment.fromSpeed,
            rate: segment.fromSpeed,
            warp: false,
          });
          destination += segment.duration;
          source += segment.duration * segment.fromSpeed;
        }
      } else
        result.push({
          audio,
          start: start + editFrom,
          duration: editTo - editFrom,
          sourceStart: audio.sourceIn + sourceFrom - audio.start,
          sourceDuration: selected.sourceOut - selected.sourceIn,
          rate: 1,
          warp: false,
        });
    }
  }
  return result;
}
