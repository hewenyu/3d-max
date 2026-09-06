import type { AudioClip, Project, RenderOptions, SequenceClip } from '../shared/types.ts';
import type { Store } from './store.ts';
import { ApiError } from './errors.ts';

export interface AudioSegment {
  path: string;
  sourceStart: number;
  duration: number;
  start: number;
  volume: number;
}

export function audioSegments(
  project: Project,
  options: RenderOptions,
  duration: number,
  store: Pick<Store, 'assetByUrl'>,
): AudioSegment[] {
  if (!options.includeAudio) return [];
  const segments: AudioSegment[] = [];
  const clips: SequenceClip[] = options.shotId
    ? project.shots
        .filter((shot) => shot.id === options.shotId)
        .map((shot) => ({ id: shot.id, shotId: shot.id, sourceIn: shot.sourceIn, sourceOut: shot.sourceOut }))
    : project.sequences.find((sequence) => sequence.id === (options.sequenceId || project.activeSequenceId))
        ?.clips || [];
  const append = (audio: AudioClip, sourceStart: number, length: number, destination: number) => {
    if (length <= 0 || destination >= duration) return;
    const asset = store.assetByUrl(audio.url);
    if (!asset || !asset.mime.startsWith('audio/'))
      throw new ApiError('INVALID_AUDIO', `Audio asset is unavailable: ${audio.name}`);
    const safeLength = Math.min(length, duration - destination, (asset.duration ?? Infinity) - sourceStart);
    if (safeLength > 0)
      segments.push({
        path: asset.path,
        sourceStart,
        duration: safeLength,
        start: destination,
        volume: audio.volume,
      });
  };
  for (const audio of project.audio) {
    if (audio.muted || audio.volume === 0) continue;
    if (audio.sync === 'sequence') {
      if (!options.shotId) {
        const start = Math.max(0, audio.start);
        append(audio, audio.sourceIn + start - audio.start, audio.duration - (start - audio.start), start);
      }
      continue;
    }
    let destination = 0;
    for (const clip of clips) {
      const overlapStart = Math.max(clip.sourceIn, audio.start);
      const overlapEnd = Math.min(clip.sourceOut, audio.start + audio.duration);
      append(
        audio,
        audio.sourceIn + overlapStart - audio.start,
        overlapEnd - overlapStart,
        destination + overlapStart - clip.sourceIn,
      );
      destination += clip.sourceOut - clip.sourceIn;
    }
  }
  return segments;
}

export function audioArguments(segments: AudioSegment[], duration: number) {
  if (!segments.length) return { inputs: [] as string[], filters: [] as string[] };
  const inputs: string[] = [];
  const paths = [...new Set(segments.map((segment) => segment.path))];
  for (const path of paths) inputs.push('-i', path);
  const filters = segments.map((segment, index) => {
    const input = paths.indexOf(segment.path) + 1;
    return `[${input}:a:0]atrim=start=${segment.sourceStart}:duration=${segment.duration},asetpts=PTS-STARTPTS,volume=${segment.volume},adelay=${Math.round(segment.start * 1000)}:all=1[a${index}]`;
  });
  filters.push(
    `${segments.map((_, index) => `[a${index}]`).join('')}amix=inputs=${segments.length}:normalize=0:dropout_transition=0,apad=whole_dur=${duration},atrim=duration=${duration}[audio]`,
  );
  return { inputs, filters };
}
