import type { AudioClip } from './types';

export function audioEnvelope(
  clip: Pick<AudioClip, 'duration' | 'fadeIn' | 'fadeOut' | 'fadeCurve'>,
  localTime: number,
): number {
  if (localTime < 0 || localTime >= clip.duration) return 0;
  const incoming = clip.fadeIn ? Math.min(1, localTime / clip.fadeIn) : 1;
  const outgoing = clip.fadeOut ? Math.min(1, (clip.duration - localTime) / clip.fadeOut) : 1;
  const shape = (value: number) =>
    clip.fadeCurve === 'equalPower' ? Math.sin((value * Math.PI) / 2) : value;
  return shape(incoming) * shape(outgoing);
}

export function audioGain(clip: AudioClip, localTime: number): number {
  return clip.muted ? 0 : clip.volume * audioEnvelope(clip, localTime);
}
