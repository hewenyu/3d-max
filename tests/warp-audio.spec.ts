import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { AudioPlacement } from '../shared/audio-plan';
import type { ClipRetiming, Project, SequenceClip } from '../shared/types';
import {
  clipDuration,
  retimingSourceDuration,
  sampleClipTime,
  sourceToClipTime,
  trimClip,
} from '../shared/time-map';

const retiming: ClipRetiming = {
  audio: 'warp',
  segments: [
    { duration: 0.5, fromSpeed: 1, toSpeed: 1, easing: 'constant' },
    { duration: 0.5, fromSpeed: 1, toSpeed: 0.25, easing: 'smooth' },
    { duration: 1, fromSpeed: 0.25, toSpeed: 0.25, easing: 'constant' },
    { duration: 0.5, fromSpeed: 0.25, toSpeed: 1, easing: 'smooth' },
    { duration: 0.5, fromSpeed: 1, toSpeed: 1, easing: 'constant' },
  ],
};
const clip: SequenceClip = {
  id: 'clip',
  shotId: 'shot',
  sourceIn: 0,
  sourceOut: retimingSourceDuration(retiming),
  retiming,
};
const impulseSourceTime = 0.95;

test('warped audio fades use source-clock envelope phase and preserve it after a playback seek', async ({
  page,
}) => {
  await page.goto('/?render=1');
  const plain = placement(`data:audio/wav;base64,${waveform().toString('base64')}`);
  const faded = {
    ...plain,
    audio: { ...plain.audio, volume: 1.6, fadeIn: 0.8, fadeOut: 0.6, fadeCurve: 'equalPower' as const },
  };
  const result = await page.evaluate(
    async ({ plain, faded, clip }) => {
      const audioPath = '/src/audio/warp-audio.ts';
      const envelopePath = '/shared/audio-envelope.ts';
      const timePath = '/shared/time-map.ts';
      const audio = (await import(audioPath)) as typeof import('../src/audio/warp-audio');
      const { audioGain } = (await import(envelopePath)) as typeof import('../shared/audio-envelope');
      const { sampleClipTime } = (await import(timePath)) as typeof import('../shared/time-map');
      const baseline = await audio.renderWarpAudio([plain], 3);
      const output = await audio.renderWarpAudio([faded], 3);
      const reference = baseline.getChannelData(0);
      const samples = output.getChannelData(0);
      let maxError = 0;
      for (let index = 32; index < samples.length - 64; index += 17) {
        const expected =
          reference[index]! * audioGain(faded.audio, sampleClipTime(clip, index / 48000).sourceTime);
        maxError = Math.max(maxError, Math.abs(samples[index]! - expected));
      }
      const context = new OfflineAudioContext(2, 48000, 48000);
      const decoded = await audio.decodeWarpAudio(context, [faded]);
      audio.scheduleWarpAudio(context, decoded, [faded], 1.1);
      const resumed = await context.startRendering();
      const resumedSamples = resumed.getChannelData(0);
      let rms = 0;
      let expectedRms = 0;
      for (let index = 1000; index < 40000; index++) {
        rms += resumedSamples[index]! ** 2;
        expectedRms += samples[index + 52800]! ** 2;
      }
      return { maxError, seekEnergyRatio: rms / expectedRms };
    },
    { plain, faded, clip },
  );
  expect(result.maxError).toBeLessThan(0.002);
  expect(Math.abs(result.seekEnergyRatio - 1)).toBeLessThan(0.025);
});

function waveform(): Buffer {
  const frames = 48000 * 2;
  const data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(48000, 24);
  data.writeUInt32LE(48000 * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame++) {
    data.writeInt16LE(Math.round(Math.sin((frame / 48000) * 440 * Math.PI * 2) * 16000), 44 + frame * 4);
    const distance = (frame / 48000 - impulseSourceTime) / 0.001;
    data.writeInt16LE(Math.round(Math.exp(-distance * distance) * 30000), 46 + frame * 4);
  }
  return data;
}

function placement(url: string, selection: SequenceClip = clip): AudioPlacement {
  return {
    audio: {
      id: 'audio',
      name: 'Timing tone',
      url,
      start: 0,
      sourceIn: 0,
      duration: 2,
      volume: 1,
      muted: false,
      locked: false,
      sync: 'source',
    },
    start: 0,
    duration: clipDuration(selection),
    sourceStart: selection.sourceIn,
    sourceDuration: selection.sourceOut - selection.sourceIn,
    rate: sampleClipTime(selection, 0).playbackRate,
    warp: true,
    segments: selection.retiming!.segments,
  };
}

test('native audio resampling follows ramps with exact duration, changing pitch and synchronized source events', async ({
  page,
}) => {
  await page.goto('/?render=1');
  const audio = placement(`data:audio/wav;base64,${waveform().toString('base64')}`);
  const result = await page.evaluate(async (input) => {
    const path = '/src/audio/warp-audio.ts';
    const module = (await import(path)) as typeof import('../src/audio/warp-audio');
    const buffer = await module.renderWarpAudio([input], 3);
    const tone = buffer.getChannelData(0);
    const marker = buffer.getChannelData(1);
    const frequency = (start: number, end: number) => {
      let count = 0;
      for (let sample = Math.ceil(start * buffer.sampleRate); sample < end * buffer.sampleRate; sample++)
        if (tone[sample - 1]! <= 0 && tone[sample]! > 0) count++;
      return count / (end - start);
    };
    let peak = 0;
    for (let frame = 1; frame < marker.length; frame++) if (marker[frame]! > marker[peak]!) peak = frame;
    return {
      frames: buffer.length,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      normal: frequency(0.1, 0.4),
      slow: frequency(1.15, 1.85),
      restored: frequency(2.6, 2.9),
      peak: peak / buffer.sampleRate,
      chunkSize: atob(module.audioBufferChunk(buffer, 0, 48000)).length,
    };
  }, audio);
  expect(result.frames).toBe(144000);
  expect(result.sampleRate).toBe(48000);
  expect(result.channels).toBe(2);
  expect(Math.abs(result.normal - 440)).toBeLessThan(5);
  expect(Math.abs(result.slow - 110)).toBeLessThan(5);
  expect(Math.abs(result.restored - 440)).toBeLessThan(5);
  expect(Math.abs(result.peak - sourceToClipTime(clip, impulseSourceTime))).toBeLessThan(0.008);
  expect(result.chunkSize).toBe(48000 * 2 * 4);
});

test('native audio trim and playback seek preserve the source marker inside a smooth ramp', async ({
  page,
}) => {
  await page.goto('/?render=1');
  const audio = placement(`data:audio/wav;base64,${waveform().toString('base64')}`);
  const trimStart = 0.7;
  const selected = trimClip(
    clip,
    sampleClipTime(clip, trimStart).sourceTime,
    sampleClipTime(clip, 2.35).sourceTime,
  );
  const trimmed = placement(audio.audio.url, selected);
  const result = await page.evaluate(
    async ({ audio, trimmed, trimStart }) => {
      const path = '/src/audio/warp-audio.ts';
      const module = (await import(path)) as typeof import('../src/audio/warp-audio');
      const peak = (buffer: AudioBuffer) => {
        const samples = buffer.getChannelData(1);
        let index = 0;
        for (let frame = 1; frame < samples.length; frame++)
          if (samples[frame]! > samples[index]!) index = frame;
        return index / buffer.sampleRate;
      };
      const output = await module.renderWarpAudio([trimmed], trimmed.duration);
      const context = new OfflineAudioContext(2, Math.ceil(trimmed.duration * 48000), 48000);
      const decoded = await module.decodeWarpAudio(context, [audio]);
      module.scheduleWarpAudio(context, decoded, [audio], trimStart);
      const resumed = await context.startRendering();
      return { trimmed: peak(output), resumed: peak(resumed), frames: output.length };
    },
    { audio, trimmed, trimStart },
  );
  const expected = sourceToClipTime(clip, impulseSourceTime) - trimStart;
  expect(Math.abs(result.trimmed - expected)).toBeLessThan(0.008);
  expect(Math.abs(result.resumed - expected)).toBeLessThan(0.008);
  expect(result.frames).toBe(Math.ceil(trimmed.duration * 48000));
});

test('retiming UI edits the shared command state and the MP4 export carries the actual warped waveform', async ({
  page,
  request,
}, testInfo) => {
  await page.addInitScript(() => {
    const stats = { starts: 0, stops: 0, htmlPlays: 0 };
    Object.assign(window, { audioVerification: stats });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      stats.starts++;
      return start.apply(this, args);
    };
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (...args) {
      stats.stops++;
      return stop.apply(this, args);
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      stats.htmlPlays++;
      return play.call(this);
    };
  });
  const created = await request.post('/api/project/new', {
    data: { name: 'Warp audio verification', template: 'empty' },
  });
  const project = (await created.json()) as Project;
  const upload = await request.post('/api/assets', {
    multipart: { file: { name: 'timing.wav', mimeType: 'audio/wav', buffer: waveform() } },
  });
  expect(upload.ok()).toBe(true);
  const asset = (await upload.json()) as { url: string };
  const response = await request.post('/api/commands', {
    data: {
      projectId: project.id,
      expectedRevision: project.revision,
      commands: [
        { type: 'project.settings', payload: { fps: 24, aspect: '16:9' } },
        {
          type: 'object.create',
          payload: {
            id: 'box',
            type: 'box',
            position: [-1, 0.5, 0],
            keyframes: [
              { id: 'start', time: 0, position: [-1, 0.5, 0] },
              { id: 'end', time: clip.sourceOut, position: [1, 0.5, 0] },
            ],
          },
        },
        { type: 'object.create', payload: { id: 'floor', type: 'plane', position: [0, -0.1, 0] } },
        { type: 'camera.create', payload: { id: 'camera', position: [0, 2, 5], target: [0, 0.5, 0] } },
        {
          type: 'shot.create',
          payload: {
            id: 'shot',
            cameraId: 'camera',
            sourceIn: 0,
            sourceOut: clip.sourceOut,
            subjectIds: ['box'],
          },
        },
        { type: 'sequence.update', payload: { id: project.activeSequenceId, patch: { clips: [clip] } } },
        { type: 'audio.create', payload: placement(asset.url).audio },
      ],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto('/');
  await page.locator('.shot-card').first().click();
  await page.getByRole('button', { name: '片段速度与时间', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '片段速度与时间', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '变速音频策略', exact: true })).toHaveValue('warp');
  await page.getByRole('combobox', { name: '摄影机时间基准', exact: true }).selectOption('independent');
  await page.screenshot({ path: testInfo.outputPath('retiming-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('retiming-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: '应用速度曲线', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const edited = (await (await request.get('/api/project')).json()) as Project;
  expect(edited.sequences[0]!.clips[0]!.cameraTiming?.mode).toBe('independent');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { audioVerification: { starts: number } }).audioVerification.starts,
      ),
    )
    .toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const beforePause = await page.evaluate(
    () =>
      (window as unknown as { audioVerification: { stops: number; htmlPlays: number } }).audioVerification,
  );
  expect(beforePause.htmlPlays).toBe(0);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { audioVerification: { stops: number } }).audioVerification.stops,
      ),
    )
    .toBeGreaterThan(beforePause.stops);
  const started = await request.post('/api/renders', {
    data: { fps: 24, aspect: '16:9', resolution: 720, includeAudio: true },
  });
  const job = (await started.json()) as { id: string };
  expect(started.ok(), JSON.stringify(job)).toBe(true);
  await expect
    .poll(
      async () => {
        const value = await (await request.get(`/api/renders/${job.id}`)).json();
        if (value.status === 'failed') throw new Error(value.error);
        return value.status;
      },
      { timeout: 180000 },
    )
    .toBe('completed');
  const video = await request.get(`/api/renders/${job.id}/file`);
  const path = testInfo.outputPath('warped-audio.mp4');
  await writeFile(path, await video.body());
  const info = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type,width,height,avg_frame_rate,nb_frames',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' },
    ),
  );
  expect(info.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video')).toMatchObject({
    width: 1280,
    height: 720,
    avg_frame_rate: '24/1',
    nb_frames: '72',
  });
  expect(info.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio')).toBe(true);
  expect(Number(info.format.duration)).toBeCloseTo(3, 2);
  const pcm = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  let peak = 0;
  for (let frame = 1; frame < pcm.length / 8; frame++)
    if (pcm.readFloatLE(frame * 8 + 4) > pcm.readFloatLE(peak * 8 + 4)) peak = frame;
  expect(Math.abs(peak / 48000 - sourceToClipTime(clip, impulseSourceTime))).toBeLessThan(0.008);
});
