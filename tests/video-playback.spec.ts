import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { createApp } from '../server/app';
import type { RenderJob } from '../shared/types';

const run = promisify(execFile);
let directory: string;
let service: ReturnType<typeof createApp>;
let listener: ReturnType<ReturnType<typeof createApp>['app']['listen']>;
let base: string;
let duration = 3;
let job: RenderJob;

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), '.whiteframe-playback-'));
  const config = {
    port: 0,
    dataDir: directory,
    distDir: join(directory, 'dist'),
    appUrl: 'http://127.0.0.1:5180',
    apiUrl: 'http://127.0.0.1:4173',
    token: 'playback-test',
  };
  service = createApp(config);
  listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => listener.once('listening', done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  config.apiUrl = base;
  const file = join(directory, 'renders', 'playback-test.mp4');
  if (process.env.WHITEFRAME_PLAYBACK_FIXTURE)
    await copyFile(resolve(process.env.WHITEFRAME_PLAYBACK_FIXTURE), file);
  else
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      file,
    ]);
  const result = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height,avg_frame_rate,nb_frames',
    '-of',
    'json',
    file,
  ]);
  const metadata = JSON.parse(result.stdout);
  const video = metadata.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  duration = Number(metadata.format.duration);
  const fps = Number(video.avg_frame_rate.split('/')[0]) / Number(video.avg_frame_rate.split('/')[1]);
  const project = service.store.project();
  job = {
    id: 'playback-test',
    name: '白模审片 / 导演剪辑',
    status: 'completed',
    progress: 1,
    frame: Number(video.nb_frames),
    totalFrames: Number(video.nb_frames),
    projectRevision: project.revision,
    createdAt: new Date().toISOString(),
    options: {
      projectId: project.id,
      fps,
      resolution: 720,
      aspect: video.width > video.height ? '16:9' : '9:16',
    },
    url: `${base}/api/renders/playback-test/file`,
  };
  service.store.addJob(job, project);
});

test.afterAll(async () => {
  await service?.close();
  listener?.closeAllConnections();
  if (listener) await new Promise<void>((done) => listener.close(() => done()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `event: project\ndata: ${JSON.stringify(service.store.project())}\n\n`,
      });
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`exported MP4 plays, seeks, adjusts volume and returns to exports at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: '导出视频', exact: true }).click();
    await expect(page.locator('.render-job-name')).toHaveText(job.name!);
    await page.getByRole('button', { name: '播放视频', exact: true }).click();
    const video = page.getByLabel('已导出白模视频', { exact: true });
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByRole('dialog', { name: '已导出视频', exact: true })).toBeVisible();
    await expect(page.locator('.video-review-details')).toContainText(job.name!);
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
      .toBeGreaterThanOrEqual(3);
    const attributes = await video.evaluate((element: HTMLVideoElement) => ({
      controls: element.controls,
      inline: element.playsInline,
      duration: element.duration,
      width: element.videoWidth,
      height: element.videoHeight,
    }));
    expect(attributes.controls).toBe(true);
    expect(attributes.inline).toBe(true);
    expect(attributes.duration).toBeCloseTo(duration, 1);
    expect(attributes.width * attributes.height).toBeGreaterThan(0);
    await video.evaluate((element: HTMLVideoElement) => element.play());
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeGreaterThan(0.25);
    await video.evaluate((element: HTMLVideoElement) => {
      element.pause();
      element.currentTime = element.duration * 0.65;
      element.volume = 0.3;
    });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.seeking)).toBe(false);
    const state = await video.evaluate((element: HTMLVideoElement) => ({
      paused: element.paused,
      time: element.currentTime,
      volume: element.volume,
    }));
    expect(state.paused).toBe(true);
    expect(state.time).toBeCloseTo(duration * 0.65, 1);
    expect(state.volume).toBe(0.3);
    const colors = await video.evaluate((element: HTMLVideoElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = 80;
      canvas.height = 80;
      const context = canvas.getContext('2d')!;
      context.drawImage(element, 0, 0, 80, 80);
      const data = context.getImageData(0, 0, 80, 80).data;
      const values = new Set<string>();
      for (let index = 0; index < data.length; index += 4)
        values.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
      return values.size;
    });
    expect(colors).toBeGreaterThan(25);
    await video.evaluate((element: HTMLVideoElement) => element.requestFullscreen());
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('VIDEO');
    await page.evaluate(() => document.exitFullscreen());
    await page.screenshot({ path: testInfo.outputPath(`video-review-${viewport.width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.getByRole('button', { name: '返回导出记录', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '导出白模视频', exact: true })).toBeVisible();
    await expect(video).toHaveCount(0);
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载 MP4', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.mp4$/);
  });
}

test('playback exposes loading and recoverable error states without opening another modal', async ({
  page,
}) => {
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((done) => {
    unblock = done;
  });
  let fail = true;
  await page.route('**/api/renders/playback-test/stream**', async (route) => {
    if (fail) {
      await blocked;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":{"message":"Unavailable"}}',
      });
    }
    const response = await route.fetch({ url: `${base}/api/renders/playback-test/stream` });
    await route.fulfill({ response });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '导出视频', exact: true }).click();
  await page.getByRole('button', { name: '播放视频', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('正在载入视频');
  unblock!();
  await expect(page.getByRole('alert')).toContainText('视频');
  await expect(page.getByRole('button', { name: '重试播放', exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: '重试播放', exact: true }).click();
  const video = page.getByLabel('已导出白模视频', { exact: true });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(3);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByRole('button', { name: '返回导出记录', exact: true }).click();
  await expect(video).toHaveCount(0);
});
