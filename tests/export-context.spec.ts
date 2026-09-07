import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import type { Project, RenderJob } from '../shared/types';

const run = promisify(execFile);

test('export includes a bound inactive scene audio track and retains film ownership after project switching', async ({
  page,
  request,
}, testInfo) => {
  const created = await request.post('/api/project/new', {
    data: { name: '场景音轨验收', template: 'empty' },
  });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as Project;
  const waveform = testInfo.outputPath('scene-audio.wav');
  await run('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:sample_rate=48000',
    '-t',
    '1',
    waveform,
  ]);
  const upload = await request.post('/api/assets', {
    multipart: { file: { name: 'scene-audio.wav', mimeType: 'audio/wav', buffer: await readFile(waveform) } },
  });
  expect(upload.ok()).toBe(true);
  const asset = (await upload.json()) as { url: string };
  const configured = await request.post('/api/commands', {
    data: {
      projectId: project.id,
      expectedRevision: project.revision,
      commands: [
        { type: 'project.settings', payload: { aspect: '16:9', fps: 24 } },
        { type: 'object.create', payload: { id: 'subject', type: 'sphere', position: [0, 1, 0] } },
        { type: 'camera.create', payload: { id: 'camera', position: [0, 2, 5], target: [0, 1, 0] } },
        { type: 'shot.create', payload: { id: 'shot', cameraId: 'camera', sourceIn: 0, sourceOut: 1 } },
        {
          type: 'sequence.update',
          payload: {
            id: project.activeSequenceId,
            patch: { name: '原始剪辑', clips: [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 1 }] },
          },
        },
        { type: 'audio.create', payload: { url: asset.url, duration: 1, sync: 'source' } },
        { type: 'production.initialize', payload: {} },
        {
          type: 'scene.create',
          payload: { name: '无音轨布景', id: 'silent-scene', performanceId: 'silent-take' },
        },
      ],
    },
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  const before = (await (await request.get('/api/project')).json()) as Project;
  expect(before.audio).toHaveLength(0);
  expect(before.production?.activeSceneId).toBe('silent-scene');
  await page.goto('/');
  await page.getByRole('button', { name: '导出视频', exact: true }).click();
  const audioToggle = page.getByRole('checkbox', { name: '导出包含音轨', exact: true });
  await expect(audioToggle).toBeEnabled();
  await audioToggle.check();
  const startedResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/renders') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /开始导出/ }).click();
  const started = await startedResponse;
  expect(started.ok()).toBe(true);
  const job = (await started.json()) as RenderJob;
  expect(job).toMatchObject({
    name: '场景音轨验收 / 原始剪辑',
    projectRevision: before.revision,
    totalFrames: 24,
    options: { projectId: before.id, includeAudio: true },
  });
  const next = await request.post('/api/project/new', { data: { name: '后续项目', template: 'empty' } });
  expect(next.ok()).toBe(true);
  await expect
    .poll(
      async () => {
        const current = (await (await request.get(`/api/renders/${job.id}`)).json()) as RenderJob;
        if (current.status === 'failed') throw new Error(current.error);
        return current.status;
      },
      { timeout: 120000 },
    )
    .toBe('completed');
  await page.reload();
  await page.getByRole('button', { name: '导出视频', exact: true }).click();
  const record = page.locator('.render-job').filter({ has: page.locator(`a[href*="${job.id}"]`) });
  await expect(record.locator('.render-job-name')).toHaveText(job.name!);
  await record.getByRole('button', { name: '播放视频', exact: true }).click();
  const player = page.getByLabel('已导出白模视频', { exact: true });
  await expect
    .poll(() => player.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(3);
  await expect(page.locator('.video-review-details')).toContainText(job.name!);
  const download = await request.get(`/api/renders/${job.id}/file`);
  expect(download.ok()).toBe(true);
  const path = testInfo.outputPath('inactive-scene-audio.mp4');
  await writeFile(path, await download.body());
  const measured = await run('ffmpeg', [
    '-v',
    'info',
    '-i',
    path,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const volume = Number(/mean_volume: (-?[\d.]+) dB/.exec(measured.stderr)?.[1]);
  expect(Number.isFinite(volume)).toBe(true);
  expect(volume).toBeGreaterThan(-40);
  await page.screenshot({ path: testInfo.outputPath('export-context-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('export-context-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
