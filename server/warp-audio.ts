import { open } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { audioPlacements } from '../shared/audio-plan';
import type { Project, RenderOptions } from '../shared/types';
import type { AudioSegment } from './audio';

interface AudioBridge {
  audioPrepare(
    options: RenderOptions,
    duration: number,
  ): Promise<{ frames: number; channels: number; sampleRate: number }>;
  audioChunk(start: number, count: number): string;
  audioRelease(): void;
}

export async function prepareWarpAudio(
  page: Page,
  project: Project,
  options: RenderOptions,
  duration: number,
  path: string,
): Promise<AudioSegment | null> {
  if (!audioPlacements(project, options, duration).some((placement) => placement.warp)) return null;
  const meta = await page.evaluate(
    async ({ options, duration }) =>
      (window as unknown as { __WHITEFRAME_RENDER__: AudioBridge }).__WHITEFRAME_RENDER__.audioPrepare(
        options,
        duration,
      ),
    { options, duration },
  );
  if (meta.channels !== 2 || meta.sampleRate !== 48000 || meta.frames !== Math.ceil(duration * 48000))
    throw new Error('Offline audio returned invalid sample dimensions');
  const file = await open(path, 'w');
  try {
    const size = meta.frames * meta.channels * 4;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + size, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(3, 20);
    header.writeUInt16LE(meta.channels, 22);
    header.writeUInt32LE(meta.sampleRate, 24);
    header.writeUInt32LE(meta.sampleRate * meta.channels * 4, 28);
    header.writeUInt16LE(meta.channels * 4, 32);
    header.writeUInt16LE(32, 34);
    header.write('data', 36);
    header.writeUInt32LE(size, 40);
    await file.write(header);
    for (let offset = 0; offset < meta.frames; offset += 48000) {
      const count = Math.min(48000, meta.frames - offset);
      const encoded = await page.evaluate(
        ({ offset, count }) =>
          (window as unknown as { __WHITEFRAME_RENDER__: AudioBridge }).__WHITEFRAME_RENDER__.audioChunk(
            offset,
            count,
          ),
        { offset, count },
      );
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length !== count * meta.channels * 4)
        throw new Error('Offline audio chunk has invalid length');
      await file.write(bytes);
    }
  } finally {
    await file.close();
    await page
      .evaluate(() =>
        (window as unknown as { __WHITEFRAME_RENDER__: AudioBridge }).__WHITEFRAME_RENDER__.audioRelease(),
      )
      .catch(() => undefined);
  }
  return { path, sourceStart: 0, duration, start: 0, volume: 1 };
}
