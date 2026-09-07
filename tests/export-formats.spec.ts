import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import type { Project, RenderJob, RenderOptions } from '../shared/types';

const run = promisify(execFile);
const formats = [
  { name: 'portrait-review', aspect: '9:16', resolution: 1080, fps: 30, burnIn: true, includeAudio: true },
  { name: 'square-clean-shot', aspect: '1:1', resolution: 720, fps: 25, burnIn: false, includeAudio: false },
] as const;

for (const format of formats) {
  test(`real ${format.name} MP4 preserves selected dimensions, frame rate, audio and source range`, async ({
    page,
    request,
  }, testInfo) => {
    const created = await request.post('/api/project/new', {
      data: { name: format.name, template: 'empty' },
    });
    expect(created.ok()).toBe(true);
    const project = (await created.json()) as Project;
    const audioPath = testInfo.outputPath('dialogue.wav');
    await run('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:sample_rate=48000',
      '-t',
      '4',
      audioPath,
    ]);
    const uploaded = await request.post('/api/assets', {
      multipart: { file: { name: 'dialogue.wav', mimeType: 'audio/wav', buffer: await readFile(audioPath) } },
    });
    expect(uploaded.ok()).toBe(true);
    const asset = (await uploaded.json()) as { url: string };
    const edited = await request.post('/api/commands', {
      data: {
        projectId: project.id,
        expectedRevision: project.revision,
        commands: [
          {
            type: 'object.create',
            payload: {
              id: 'subject',
              type: 'box',
              position: [-1, 0.5, 0],
              keyframes: [
                { id: 'begin', time: 0, position: [-1, 0.5, 0] },
                { id: 'end', time: 4, position: [1, 0.5, 0], rotation: [0, 1.2, 0] },
              ],
            },
          },
          { type: 'camera.create', payload: { id: 'camera', position: [0, 2, 6], target: [0, 0.5, 0] } },
          { type: 'shot.create', payload: { id: 'wide', cameraId: 'camera', sourceIn: 0, sourceOut: 4 } },
          {
            type: 'shot.create',
            payload: { id: 'trimmed', cameraId: 'camera', sourceIn: 1.5, sourceOut: 2.5 },
          },
          {
            type: 'sequence.update',
            payload: {
              id: project.activeSequenceId,
              patch: {
                clips: [
                  { id: 'opening', shotId: 'wide', sourceIn: 0, sourceOut: 1 },
                  { id: 'ending', shotId: 'wide', sourceIn: 3, sourceOut: 4 },
                ],
              },
            },
          },
          { type: 'audio.create', payload: { url: asset.url, duration: 4, sync: 'source' } },
        ],
      },
    });
    expect(edited.ok(), await edited.text()).toBe(true);
    const snapshot = (await (await request.get('/api/project')).json()) as Project;
    const shot =
      format.name === 'square-clean-shot' ? snapshot.shots.find((item) => item.id === 'trimmed') : undefined;
    const options: RenderOptions = {
      projectId: snapshot.id,
      expectedRevision: snapshot.revision,
      aspect: format.aspect,
      fps: format.fps,
      resolution: format.resolution,
      includeAudio: format.includeAudio,
      burnIn: format.burnIn,
      ...(shot ? { shotId: shot.id } : { sequenceId: snapshot.activeSequenceId }),
    };
    const started = await request.post('/api/renders', { data: options });
    expect(started.ok(), await started.text()).toBe(true);
    const job = (await started.json()) as RenderJob;
    await expect
      .poll(
        async () => {
          const current = (await (await request.get(`/api/renders/${job.id}`)).json()) as RenderJob;
          if (current.status === 'failed') throw new Error(current.error);
          return current.status;
        },
        { timeout: 180000 },
      )
      .toBe('completed');
    const download = await request.get(`/api/renders/${job.id}/file`);
    expect(download.ok()).toBe(true);
    const videoPath = testInfo.outputPath(`${format.name}.mp4`);
    await writeFile(videoPath, await download.body());
    const probe = JSON.parse(
      (
        await run('ffprobe', [
          '-v',
          'error',
          '-count_frames',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          videoPath,
        ])
      ).stdout,
    ) as { streams: Record<string, string | number>[]; format: { duration: string } };
    const video = probe.streams.find((stream) => stream.codec_type === 'video')!;
    const width = format.resolution;
    const height = format.aspect === '9:16' ? 1920 : 720;
    const duration = shot ? 1 : 2;
    expect(video).toMatchObject({ codec_name: 'h264', width, height, avg_frame_rate: `${format.fps}/1` });
    expect(Number(video.nb_read_frames)).toBe(duration * format.fps);
    expect(Number(probe.format.duration)).toBeCloseTo(duration, 2);
    const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
    if (format.includeAudio) {
      expect(audio).toMatchObject({ codec_name: 'aac' });
      const volume = await run('ffmpeg', [
        '-v',
        'info',
        '-i',
        videoPath,
        '-vn',
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ]);
      expect(Number(/mean_volume: (-?[\d.]+) dB/.exec(volume.stderr)?.[1])).toBeGreaterThan(-40);
    } else expect(audio).toBeUndefined();

    const frame = Math.floor(format.fps / 2);
    const time = frame / format.fps;
    const decodedPath = testInfo.outputPath('decoded-frame.png');
    await run('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-i',
      videoPath,
      '-vf',
      `select=eq(n\\,${frame})`,
      '-frames:v',
      '1',
      decodedPath,
    ]);
    await page.goto('/?render=1');
    await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
    const expected = await page.evaluate(
      async ({ snapshot, width, height, format, time, shot }) => {
        snapshot.settings = {
          ...snapshot.settings,
          aspect: format.aspect,
          fps: format.fps,
          resolution: format.resolution,
        };
        const bridge = window.__WHITEFRAME_RENDER__!;
        await bridge.load(snapshot, width, height);
        return bridge.frame(time, {
          burnIn: format.burnIn,
          ...(shot
            ? { shotId: shot.id, sourceTime: shot.sourceIn + time }
            : { sequenceId: snapshot.activeSequenceId }),
        });
      },
      { snapshot, width, height, format, time, shot },
    );
    const expectedPath = testInfo.outputPath('expected-frame.png');
    await writeFile(expectedPath, Buffer.from(expected.slice(expected.indexOf(',') + 1), 'base64'));
    const compared = await run('ffmpeg', [
      '-v',
      'info',
      '-i',
      expectedPath,
      '-i',
      decodedPath,
      '-lavfi',
      'ssim',
      '-f',
      'null',
      '-',
    ]);
    const ssim = Number(/All:([\d.]+)/.exec(compared.stderr)?.[1]);
    expect(ssim).toBeGreaterThan(0.98);
    await writeFile(
      testInfo.outputPath('verification.json'),
      JSON.stringify(
        { job, probe, ssim, sampledFrame: frame, expectedSourceTime: shot ? shot.sourceIn + time : time },
        null,
        2,
      ),
    );
  });
}
