import type { AudioPlacement } from '../../shared/audio-plan';
import { clipDuration, sampleClipTime, segmentSpeed, trimClip } from '../../shared/time-map';
import type { SequenceClip } from '../../shared/types';
import { audioGain } from '../../shared/audio-envelope';

export async function decodeWarpAudio(
  context: BaseAudioContext,
  placements: AudioPlacement[],
  cache = new Map<string, Promise<AudioBuffer>>(),
): Promise<Map<string, AudioBuffer>> {
  const decoded = new Map<string, AudioBuffer>();
  await Promise.all(
    [...new Set(placements.map((placement) => placement.audio.url))].map(async (url) => {
      let pending = cache.get(url);
      if (!pending) {
        pending = fetch(url).then(async (response) => {
          if (!response.ok) throw new Error(`Audio asset unavailable: HTTP ${response.status}`);
          return context.decodeAudioData(await response.arrayBuffer());
        });
        cache.set(url, pending);
        pending.catch(() => cache.delete(url));
      }
      decoded.set(url, await pending);
    }),
  );
  return decoded;
}

export function scheduleWarpAudio(
  context: BaseAudioContext,
  decoded: Map<string, AudioBuffer>,
  placements: AudioPlacement[],
  editStart = 0,
  contextStart = 0,
): AudioBufferSourceNode[] {
  const nodes: AudioBufferSourceNode[] = [];
  for (const placement of placements) {
    const skip = Math.max(0, editStart - placement.start);
    if (skip >= placement.duration) continue;
    const buffer = decoded.get(placement.audio.url);
    if (!buffer) throw new Error('Audio buffer was not decoded');
    const timing: SequenceClip = {
      id: 'audio',
      shotId: 'audio',
      sourceIn: 0,
      sourceOut: placement.sourceDuration,
      retiming: { audio: 'warp', segments: placement.segments! },
    };
    const skippedSource = sampleClipTime(timing, skip).sourceTime;
    const remaining = skip ? trimClip(timing, skippedSource, timing.sourceOut) : timing;
    const sourceStart = placement.sourceStart + skippedSource;
    if (sourceStart >= buffer.duration) continue;
    const node = context.createBufferSource();
    node.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = placement.audio.volume;
    node.connect(gain).connect(context.destination);
    node.onended = () => {
      node.disconnect();
      gain.disconnect();
    };
    const start = contextStart + Math.max(0, placement.start - editStart);
    if (placement.audio.fadeIn || placement.audio.fadeOut) {
      const duration = clipDuration(remaining);
      const count = Math.max(33, Math.min(65537, Math.ceil(duration * 1000) + 1));
      const envelope = Float32Array.from({ length: count }, (_, index) =>
        audioGain(
          placement.audio,
          sourceStart -
            placement.audio.sourceIn +
            sampleClipTime(remaining, (duration * index) / (count - 1)).sourceTime -
            remaining.sourceIn,
        ),
      );
      gain.gain.setValueCurveAtTime(envelope, start, duration);
    }
    let offset = start;
    for (const segment of remaining.retiming!.segments) {
      if (segment.easing === 'constant' || segment.fromSpeed === segment.toSpeed)
        node.playbackRate.setValueAtTime(segment.fromSpeed, offset);
      else {
        // The native audio engine interpolates automation and resamples the decoded waveform.
        const count = Math.max(33, Math.min(65537, Math.ceil(segment.duration * 1000) + 1));
        const values = Float32Array.from({ length: count }, (_, index) =>
          segmentSpeed(segment, index / (count - 1)),
        );
        node.playbackRate.setValueCurveAtTime(values, offset, segment.duration);
      }
      offset += segment.duration;
    }
    node.start(start, sourceStart);
    node.stop(start + clipDuration(remaining));
    nodes.push(node);
  }
  return nodes;
}

export async function renderWarpAudio(placements: AudioPlacement[], duration: number): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, Math.ceil(duration * 48000), 48000);
  const decoded = await decodeWarpAudio(context, placements);
  scheduleWarpAudio(context, decoded, placements);
  return context.startRendering();
}

export function audioBufferChunk(buffer: AudioBuffer, start: number, count: number): string {
  const length = Math.min(count, buffer.length - start);
  if (length <= 0 || start < 0) return '';
  const bytes = new Uint8Array(length * buffer.numberOfChannels * 4);
  const view = new DataView(bytes.buffer);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let frame = 0; frame < length; frame++)
      view.setFloat32((frame * buffer.numberOfChannels + channel) * 4, samples[start + frame]!, true);
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
