import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import type { RenderJob } from '../../shared/types';
import { ProductionMcp } from './production-mcp';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4202' },
    web: { type: 'string', default: 'http://127.0.0.1:5202' },
    theme: { type: 'string', default: 'tourism' },
    job: { type: 'string' },
    diagnostic: { type: 'boolean', default: false },
    rate: { type: 'string', default: '1' },
    output: { type: 'string' },
  },
});
if (!values.job || !/^[a-z-]+$/.test(values.theme)) throw new Error('Provide --job <completed-job-id>');
const playbackRate = Number(values.rate);
if (!Number.isFinite(playbackRate) || playbackRate < 0.5 || playbackRate > 2)
  throw new Error('--rate must be between 0.5 and 2');
const film = new ProductionMcp(values.theme, values.api);
const prefix = values.diagnostic ? 'diagnostic-' : '';
const directory = values.output ? resolve(values.output) : resolve(film.directory, `${prefix}review`);
const exec = promisify(execFile);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch();
try {
  await film.connect();
  const job = await film.call<RenderJob>('render_status', { id: values.job });
  if (job.status !== 'completed') throw new Error(`Render is ${job.status}; wait for completion`);
  const response = await fetch(new URL(job.url ?? `/api/renders/${job.id}/file`, values.api));
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const videoPath = resolve(film.directory, `${values.theme}-${prefix}video.mp4`);
  await writeFile(videoPath, bytes);
  const probe = await exec(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,nb_read_frames',
      '-of',
      'json',
      videoPath,
    ],
    { timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  const media = JSON.parse(probe.stdout);
  const video = media.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  if (
    Number(media.format.duration) < 120 ||
    video.width < 1280 ||
    video.height < 720 ||
    video.avg_frame_rate !== '24/1' ||
    Number(video.nb_read_frames) !== job.totalFrames
  )
    throw new Error(`Media requirements failed: ${probe.stdout}`);
  const decode = await exec(
    'ffmpeg',
    [
      '-v',
      'info',
      '-i',
      videoPath,
      '-vf',
      'blackdetect=d=0.001:pix_th=0.04:pic_th=0.98,freezedetect=n=-60dB:d=1',
      '-an',
      '-f',
      'null',
      '-',
    ],
    { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
  );
  await writeFile(resolve(directory, 'full-decode.log'), decode.stderr);
  if (/black_start:|freeze_start:/.test(decode.stderr))
    throw new Error(
      `Full decode found black or frozen spans; inspect ${resolve(directory, 'full-decode.log')}`,
    );
  await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      videoPath,
      '-vf',
      'fps=1/2,scale=320:180,tile=4x4',
      '-frames:v',
      String(Math.ceil(Number(media.format.duration) / 32)),
      '-y',
      resolve(directory, 'frames-%02d.png'),
    ],
    { timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(values.web);
  await page.getByRole('button', { name: /^导出视频/ }).click();
  const record = page.locator('.render-job').filter({ has: page.locator(`a[href*="${job.id}"]`) });
  while (!(await record.count())) {
    const more = page.getByRole('button', { name: '更多导出记录', exact: true });
    if (!(await more.count())) throw new Error(`Completed job ${job.id} is absent from the video library`);
    await more.click();
  }
  await record.getByRole('button', { name: '播放视频', exact: true }).click();
  const player = page.getByLabel('已导出白模视频');
  await player.evaluate(async (element, rate) => {
    const video = element as HTMLVideoElement;
    video.pause();
    video.currentTime = 0;
    video.volume = 0.3;
    video.playbackRate = rate;
    await video.play();
  }, playbackRate);
  const watched: { time: number; decoded: number; dropped: number }[] = [];
  let screenshot = 0;
  for (;;) {
    await page.waitForTimeout(1000);
    const state = await player.evaluate((element) => {
      const video = element as HTMLVideoElement;
      const quality = video.getVideoPlaybackQuality();
      return {
        time: video.currentTime,
        ended: video.ended,
        error: video.error?.message,
        decoded: quality.totalVideoFrames,
        dropped: quality.droppedVideoFrames,
      };
    });
    if (state.error) throw new Error(state.error);
    watched.push({ time: state.time, decoded: state.decoded, dropped: state.dropped });
    if (state.time >= screenshot * 16) {
      await page.screenshot({
        path: resolve(directory, `playback-${String(screenshot++).padStart(2, '0')}.png`),
      });
      console.log(
        JSON.stringify({ jobId: job.id, reviewedSeconds: state.time, duration: media.format.duration }),
      );
    }
    if (state.ended) break;
    if (watched.length > Number(media.format.duration) / playbackRate + 60)
      throw new Error('Video did not finish during full playback review');
  }
  await player.evaluate((element) => {
    const video = element as HTMLVideoElement;
    video.currentTime = 64;
    video.pause();
  });
  await page.waitForTimeout(500);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(directory, 'playback-mobile.png') });
  const layout = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    appOffset: document.querySelector('.app')?.scrollLeft,
  }));
  if (layout.width !== 390 || layout.appOffset !== 0 || errors.length)
    throw new Error(JSON.stringify({ layout, errors }));
  let sourceChanges: string[] = [];
  if (values.diagnostic) {
    const manifest = JSON.parse(
      await readFile(resolve(film.directory, 'render-source-manifest.json'), 'utf8'),
    );
    for (const file of manifest.files) {
      const current = createHash('sha256')
        .update(await readFile(file.path))
        .digest('hex');
      if (current !== file.sha256) sourceChanges.push(file.path);
    }
  }
  const result = {
    jobId: job.id,
    revision: job.projectRevision,
    diagnostic: values.diagnostic,
    videoPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    media,
    fullDecode: { blackSpans: 0, frozenSpansOverOneSecond: 0, frames: Number(video.nb_read_frames) },
    fullInAppPlayback: { rate: playbackRate, watched, completed: true },
    layout,
    errors,
    sourceChanges,
    visualReview: 'Frame sheets and playback screenshots require director inspection.',
  };
  await writeFile(resolve(directory, 'review.json'), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      directory,
      jobId: job.id,
      frames: video.nb_read_frames,
      duration: media.format.duration,
      completed: true,
    }),
  );
} finally {
  await browser.close();
  await film.close();
}
