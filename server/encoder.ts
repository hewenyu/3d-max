import type { RenderJob } from '../shared/types.ts';
import { audioArguments, type AudioSegment } from './audio.ts';

export function encoderArguments(job: RenderJob, segments: AudioSegment[], output: string) {
  const duration = job.totalFrames / job.options.fps!;
  const audio = audioArguments(segments, duration);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'image2pipe',
    '-framerate',
    String(job.options.fps),
    '-i',
    'pipe:0',
    ...audio.inputs,
  ];
  if (audio.filters.length)
    args.push(
      '-filter_complex',
      audio.filters.join(';'),
      '-map',
      '0:v:0',
      '-map',
      '[audio]',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
    );
  else args.push('-an');
  // Input EOF fixes the video frame count; -frames:v would truncate the final audio packet.
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-t',
    String(duration),
    output,
  );
  return args;
}
