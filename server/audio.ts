import type { Project, RenderOptions } from '../shared/types.ts';
import type { Store } from './store.ts';
import { ApiError } from './errors.ts';
import { audioPlacements } from '../shared/audio-plan.ts';

export interface AudioSegment {
  fade?: {
    sourceIn: number;
    clipDuration: number;
    fadeIn: number;
    fadeOut: number;
    curve: 'linear' | 'equalPower';
  };
  path: string;
  sourceStart: number;
  duration: number;
  start: number;
  volume: number;
  rate?: number;
}

export function audioSegments(
  project: Project,
  options: RenderOptions,
  duration: number,
  store: Pick<Store, 'assetByUrl'>,
): AudioSegment[] {
  const segments: AudioSegment[] = [];
  for (const placement of audioPlacements(project, options, duration)) {
    const asset = store.assetByUrl(placement.audio.url);
    if (!asset || !asset.mime.startsWith('audio/'))
      throw new ApiError('INVALID_AUDIO', 'Audio asset is unavailable: ' + placement.audio.name);
    if (placement.warp) continue;
    const length = Math.min(
      placement.sourceDuration,
      (duration - placement.start) * placement.rate,
      (asset.duration ?? Infinity) - placement.sourceStart,
    );
    if (length > 0)
      segments.push({
        path: asset.path,
        sourceStart: placement.sourceStart,
        duration: length,
        start: placement.start,
        volume: placement.audio.volume,
        rate: placement.rate,
        ...(placement.audio.fadeIn || placement.audio.fadeOut
          ? {
              fade: {
                sourceIn: placement.audio.sourceIn,
                clipDuration: placement.audio.duration,
                fadeIn: placement.audio.fadeIn ?? 0,
                fadeOut: placement.audio.fadeOut ?? 0,
                curve: placement.audio.fadeCurve ?? 'linear',
              },
            }
          : {}),
      });
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
    const rate = segment.rate ?? 1;
    let remaining = rate;
    const tempo: string[] = [];
    while (remaining < 0.5 - 1e-9) {
      tempo.push('atempo=0.5');
      remaining /= 0.5;
    }
    while (remaining > 2 + 1e-9) {
      tempo.push('atempo=2');
      remaining /= 2;
    }
    if (Math.abs(remaining - 1) > 1e-9) tempo.push(`atempo=${remaining}`);
    const speed = tempo.length
      ? `${tempo.join(',')},apad=whole_dur=${segment.duration / rate},atrim=duration=${segment.duration / rate},`
      : '';
    const fade = segment.fade;
    const curve = fade?.curve === 'equalPower' ? 'qsin' : 'tri';
    const incoming = fade?.fadeIn ? `afade=t=in:st=${fade.sourceIn}:d=${fade.fadeIn}:curve=${curve},` : '';
    const outgoing = fade?.fadeOut
      ? `afade=t=out:st=${fade.sourceIn + fade.clipDuration - fade.fadeOut}:d=${fade.fadeOut}:curve=${curve},`
      : '';
    return `[${input}:a:0]${incoming}${outgoing}atrim=start=${segment.sourceStart}:duration=${segment.duration},asetpts=PTS-STARTPTS,${speed}volume=${segment.volume},adelay=${Math.round(segment.start * 1000)}:all=1[a${index}]`;
  });
  filters.push(
    `${segments.map((_, index) => `[a${index}]`).join('')}amix=inputs=${segments.length}:normalize=0:dropout_transition=0,apad=whole_dur=${duration},atrim=duration=${duration}[audio]`,
  );
  return { inputs, filters };
}
