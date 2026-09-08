import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, expect, type Page } from '@playwright/test';
import type { Project, RenderJob } from '../../shared/types';
import { ProductionMcp } from './production-mcp';
import { verifyTimeline } from './film-ui-timeline';
import { fileHash, verifyFrozenManifest } from './verify-frozen-manifest';

const { values } = parseArgs({
  options: {
    api: { type: 'string' },
    manifest: { type: 'string' },
    source: { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.api || !values.manifest || !values.source || !values.output)
  throw new Error(
    'Provide --api --manifest --source <accepted productions> --output <new evidence directory>',
  );
const api = values.api;
const source = resolve(values.source);
const output = resolve(values.output);
await mkdir(output, { recursive: false });
process.env.WHITEFRAME_PRODUCTIONS_DIR = resolve(output, 'productions');
const sourceVerification = await verifyFrozenManifest(values.manifest, api);
await writeFile(resolve(output, 'source-verification.json'), JSON.stringify(sourceVerification, null, 2));
const records: unknown[] = [];
const previewChecks: unknown[] = [];
const failures: unknown[] = [];
const report = {
  sourceHash: sourceVerification.sourceHash,
  api,
  acceptedRoot: source,
  startedAt: new Date().toISOString(),
  finishedAt: undefined as string | undefined,
  sourceVerification: 'source-verification.json',
  scope:
    'Four exact accepted project snapshots, four official time-zero PNG comparisons and eight desktop/mobile checks of views, focus, timeline seeking, native MP4 short playback and downloads.',
  playbackScope:
    'Each viewport plays approximately three seconds. This is not a full-film review or isolated performance benchmark.',
  completed: false,
  records,
  previewChecks,
  failures,
};
const saveReport = () => writeFile(resolve(output, 'film-ui-report.json'), JSON.stringify(report, null, 2));
const browser = await chromium.launch();

async function focus(page: Page, width: number) {
  if (width <= 520) {
    await page.getByRole('button', { name: '更多视口工具', exact: true }).click();
    await page.getByRole('menuitem', { name: '聚焦选中对象', exact: true }).click();
  } else await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
  await page.waitForTimeout(1200);
}

async function comparePreview(current: Buffer, accepted: Buffer) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ({ left, right }) => {
        const [a, b] = await Promise.all(
          [left, right].map(async (base64) => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(image, 0, 0);
            return {
              width: image.width,
              height: image.height,
              bytes: context.getImageData(0, 0, image.width, image.height).data,
            };
          }),
        );
        let changedPixels = 0,
          maximumChannelDifference = 0;
        if (a.width !== b.width || a.height !== b.height) throw new Error('Preview dimensions differ');
        for (let i = 0; i < a.bytes.length; i += 4) {
          let changed = false;
          for (let channel = 0; channel < 4; channel++) {
            const difference = Math.abs(a.bytes[i + channel] - b.bytes[i + channel]);
            changed ||= difference !== 0;
            maximumChannelDifference = Math.max(maximumChannelDifference, difference);
          }
          if (changed) changedPixels++;
        }
        return { width: a.width, height: a.height, changedPixels, maximumChannelDifference };
      },
      { left: current.toString('base64'), right: accepted.toString('base64') },
    );
  } finally {
    await page.close();
  }
}

try {
  await saveReport();
  for (const [theme, startTime] of [
    ['martial', 64],
    ['racing', 30],
    ['space', 64],
    ['tourism', 104],
  ] as const) {
    const film = new ProductionMcp(theme, api);
    const input = resolve(source, theme);
    const directory = resolve(film.directory, 'ui');
    await mkdir(directory, { recursive: true });
    const acceptedBytes = await readFile(resolve(input, 'export-project.json'));
    const accepted = JSON.parse(acceptedBytes.toString()) as Project;
    const job = JSON.parse(await readFile(resolve(input, 'export-job.json'), 'utf8')) as RenderJob;
    const probe = JSON.parse(await readFile(resolve(input, 'ffprobe.json'), 'utf8')) as { sha256: string };
    const referenceReport = JSON.parse(
      await readFile(resolve(input, 'runtime-review/runtime-verification.json'), 'utf8'),
    ) as { sourceHash: string; completed: boolean };
    assert.equal(referenceReport.completed, true);
    try {
      await film.connect();
      assert.deepEqual(await film.call<Project>('project_open', { id: accepted.id }), accepted);
      const currentJob = await film.call<RenderJob>('render_status', { id: job.id });
      assert.equal(currentJob.status, 'completed');
      assert.equal(currentJob.projectRevision, job.projectRevision);
      assert.ok(currentJob.projectRevision <= accepted.revision);
      assert.equal(currentJob.totalFrames, job.totalFrames);
      const fps = job.options.fps!;
      assert.ok(fps > 0);
      const duration = job.totalFrames / fps;
      await film.preview(0, 'preview-00000');
      const current = await readFile(resolve(film.directory, 'preview-00000.png'));
      const referencePath = resolve(input, 'runtime-review/preview-00000.png');
      const reference = await readFile(referencePath);
      const pixels = await comparePreview(current, reference);
      assert.equal(pixels.width, 1280);
      assert.equal(pixels.height, 720);
      assert.equal(pixels.changedPixels, 0);
      assert.equal(pixels.maximumChannelDifference, 0);
      previewChecks.push({
        theme,
        projectId: accepted.id,
        revision: accepted.revision,
        officialTool: 'preview_capture',
        time: 0,
        currentSha256: fileHash(current),
        referenceSha256: fileHash(reference),
        byteIdentical: current.equals(reference),
        referencePath,
        pixels,
        referenceSourceHash: referenceReport.sourceHash,
      });
      await saveReport();
      console.log(
        JSON.stringify({ theme, timeZeroPreviewPassed: true, byteIdentical: current.equals(reference) }),
      );
      for (const [viewport, width, height] of [
        ['desktop', 1440, 1000],
        ['mobile', 390, 844],
      ] as const) {
        const page = await browser.newPage({ viewport: { width, height } });
        page.setDefaultTimeout(30000);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        try {
          await page.goto(api);
          await expect(page.locator('.project-name')).toHaveText(accepted.name);
          await page.getByRole('button', { name: '摄影机', exact: true }).click();
          const canvas = page.locator('[data-testid="stage"] canvas');
          const capture = () => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
          const colors = () =>
            canvas.evaluate((element: HTMLCanvasElement) => {
              const copy = document.createElement('canvas');
              copy.width = element.width;
              copy.height = element.height;
              const context = copy.getContext('2d')!;
              context.drawImage(element, 0, 0);
              const bytes = context.getImageData(0, 0, copy.width, copy.height).data;
              const result = new Set<number>();
              for (let i = 0; i < bytes.length; i += 4)
                result.add((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
              return result.size;
            });
          await expect.poll(colors, { timeout: 60000 }).toBeGreaterThan(30);
          await page.waitForTimeout(500);
          const shotBefore = await capture(),
            shotColors = await colors();
          await page.screenshot({ path: resolve(directory, `${viewport}-shot-before.png`) });
          await page.getByRole('button', { name: '自由视角', exact: true }).click();
          await focus(page, width);
          await expect.poll(colors).toBeGreaterThan(30);
          const freeFocused = await capture(),
            freeColors = await colors();
          assert.notEqual(freeFocused, shotBefore);
          await page.screenshot({ path: resolve(directory, `${viewport}-free-focused.png`) });
          await page.getByRole('button', { name: '俯视调度', exact: true }).click();
          await focus(page, width);
          await expect.poll(colors).toBeGreaterThan(20);
          const topFocused = await capture(),
            topColors = await colors();
          await page.screenshot({ path: resolve(directory, `${viewport}-top-focused.png`) });
          await page.getByRole('button', { name: '摄影机', exact: true }).click();
          await expect.poll(capture).toBe(shotBefore);
          assert.deepEqual(await film.call<Project>('project_get'), accepted);
          const timeline = await verifyTimeline(
            page,
            duration,
            accepted.settings.fps,
            width,
            directory,
            viewport,
          );
          await expect.poll(capture).toBe(shotBefore);
          assert.deepEqual(await film.call<Project>('project_get'), accepted);
          await page.getByRole('button', { name: /^导出视频/ }).click();
          const row = page.locator('.render-job').filter({ has: page.locator(`a[href*="${job.id}"]`) });
          for (let attempts = 0; !(await row.count()) && attempts < 20; attempts++)
            await page.getByRole('button', { name: '更多导出记录', exact: true }).click();
          await expect(row).toHaveCount(1);
          await row.getByRole('button', { name: '播放视频', exact: true }).click();
          const player = page.getByLabel('已导出白模视频');
          await expect
            .poll(() => player.evaluate((element: HTMLVideoElement) => element.readyState))
            .toBeGreaterThanOrEqual(2);
          await player.evaluate((element: HTMLVideoElement, time: number) => {
            element.pause();
            element.currentTime = time;
            element.playbackRate = 1;
            element.muted = true;
          }, startTime);
          await expect
            .poll(() =>
              player.evaluate((element: HTMLVideoElement) => !element.seeking && element.readyState >= 2),
            )
            .toBe(true);
          const quality = () =>
            player.evaluate((element: HTMLVideoElement) => {
              const q = element.getVideoPlaybackQuality();
              return {
                currentTime: element.currentTime,
                totalVideoFrames: q.totalVideoFrames,
                droppedVideoFrames: q.droppedVideoFrames,
                duration: element.duration,
                width: element.videoWidth,
                height: element.videoHeight,
                rate: element.playbackRate,
                error: element.error?.message ?? null,
                source: element.currentSrc,
              };
            });
          const before = await quality();
          await player.evaluate((element: HTMLVideoElement) => element.play());
          await page.waitForTimeout(3000);
          await player.evaluate((element: HTMLVideoElement) => element.pause());
          const after = await quality();
          assert.ok(after.currentTime - before.currentTime >= 2.5);
          assert.ok(after.totalVideoFrames > before.totalVideoFrames);
          assert.equal(after.rate, 1);
          assert.equal(after.error, null);
          assert.equal(after.width, 1280);
          assert.equal(after.height, 720);
          assert.ok(after.source.includes(job.id));
          assert.equal(after.duration, duration);
          await page.screenshot({ path: resolve(directory, `${viewport}-playback.png`) });
          const pendingDownload = page.waitForEvent('download');
          await page.getByRole('link', { name: '下载 MP4', exact: true }).click();
          const download = await pendingDownload;
          const downloadPath = resolve(directory, `${viewport}-download.mp4`);
          await download.saveAs(downloadPath);
          const downloadSha256 = fileHash(await readFile(downloadPath));
          assert.equal(downloadSha256, probe.sha256);
          const layout = await page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
          }));
          assert.equal(layout.width, width);
          assert.deepEqual(await film.call<Project>('project_get'), accepted);
          assert.deepEqual(errors, []);
          const totalVideoFrameDelta = after.totalVideoFrames - before.totalVideoFrames;
          const droppedDisplayFrameDelta = after.droppedVideoFrames - before.droppedVideoFrames;
          records.push({
            theme,
            projectId: accepted.id,
            revision: accepted.revision,
            acceptedProjectFileSha256: fileHash(acceptedBytes),
            jobId: job.id,
            viewport: { name: viewport, width, height },
            canvasSampling: 'native',
            canvasColorCounts: { shot: shotColors, free: freeColors, top: topColors },
            shotBeforeAndAfterSha256: fileHash(shotBefore),
            freeFocusedSha256: fileHash(freeFocused),
            topFocusedSha256: fileHash(topFocused),
            savedProjectUnchanged: true,
            timeline,
            playback: {
              before,
              after,
              totalVideoFrameDelta,
              displayedFrameDelta: totalVideoFrameDelta - droppedDisplayFrameDelta,
              droppedDisplayFrameDelta,
            },
            downloadPath,
            downloadSha256,
            layout,
            errors,
          });
          await saveReport();
          console.log(
            JSON.stringify({
              theme,
              viewport,
              seeks: timeline.seeks.length,
              playedSeconds: after.currentTime - before.currentTime,
              passed: true,
            }),
          );
        } catch (error) {
          const screenshot = resolve(directory, `${viewport}-failure.png`);
          await page.screenshot({ path: screenshot }).catch(() => {});
          failures.push({
            theme,
            viewport,
            message: error instanceof Error ? error.stack : String(error),
            screenshot,
            pageErrors: errors,
          });
          await saveReport();
          throw error;
        } finally {
          await page.close();
        }
      }
    } finally {
      await film.close();
    }
  }
  assert.equal(records.length, 8);
  assert.equal(previewChecks.length, 4);
  await verifyFrozenManifest(values.manifest, api);
  report.completed = true;
  report.finishedAt = new Date().toISOString();
  await saveReport();
} catch (error) {
  failures.push({
    message: error instanceof Error ? error.stack : String(error),
    at: new Date().toISOString(),
  });
  await saveReport();
  throw error;
} finally {
  await browser.close();
}
