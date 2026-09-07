import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { arch, cpus, freemem, hostname, loadavg, platform, release, totalmem } from 'node:os';
import { performance as hostPerformance } from 'node:perf_hooks';
import { chromium, expect, type Page } from '@playwright/test';
import { z } from 'zod';
import type { Project, RenderJob } from '../../shared/types';
import { sequenceDuration } from '../../shared/timeline';

const filmSchema = z.object({
  theme: z.string().regex(/^[a-z-]+$/),
  projectId: z.string().min(1),
  jobId: z.string().min(1),
  sequenceId: z.string().optional(),
});
const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4210' },
    web: { type: 'string', default: 'http://127.0.0.1:4210' },
    theme: { type: 'string', default: 'all' },
    manifest: { type: 'string' },
    output: { type: 'string', default: '.data/full-delivery/performance' },
    conditions: {
      type: 'string',
      default: 'External concurrent workloads were not controlled by this script.',
    },
  },
});
const names = values.theme === 'all' ? ['martial', 'racing', 'space', 'tourism'] : values.theme.split(',');
if (names.some((name) => !/^[a-z-]+$/.test(name))) throw new Error('Invalid --theme');
const films = values.manifest
  ? z
      .object({ productions: z.array(filmSchema) })
      .passthrough()
      .parse(JSON.parse(await readFile(resolve(values.manifest), 'utf8')))
      .productions.filter((film) => names.includes(film.theme))
  : await Promise.all(
      names.map(async (theme) => {
        const job: RenderJob = JSON.parse(
          await readFile(resolve(`.data/full-delivery/productions/${theme}/export-job.json`), 'utf8'),
        );
        return filmSchema.parse({
          theme,
          projectId: job.options.projectId,
          jobId: job.id,
          sequenceId: job.options.sequenceId,
        });
      }),
    );
if (films.length !== names.length) throw new Error('Manifest does not contain every selected theme');
const output = resolve(values.output);
await mkdir(output, { recursive: true });

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    new URL(`/api${path}`, values.api),
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
function summary(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    min: sorted[0],
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)],
    max: sorted.at(-1),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}
function host() {
  return {
    time: new Date().toISOString(),
    hostname: hostname(),
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    loadAverage: loadavg(),
  };
}
async function pixels(page: Page) {
  return page.locator('[data-testid="stage"] canvas').evaluate((element: HTMLCanvasElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    const context = canvas.getContext('2d')!;
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<number>();
    let checksum = 2166136261;
    for (let index = 0; index < data.length; index += 4) {
      const color = (data[index] << 16) | (data[index + 1] << 8) | data[index + 2];
      colors.add(color);
      checksum = Math.imul(checksum ^ color, 16777619) >>> 0;
    }
    return { distinctColors: colors.size, checksum, width: element.width, height: element.height };
  });
}
async function painted(page: Page) {
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}
async function mediaState(page: Page) {
  return page.getByLabel('已导出白模视频', { exact: true }).evaluate((element: HTMLVideoElement) => {
    const quality = element.getVideoPlaybackQuality();
    return {
      time: element.currentTime,
      readyState: element.readyState,
      ended: element.ended,
      error: element.error?.message,
      decoded: quality.totalVideoFrames,
      dropped: quality.droppedVideoFrames,
      at: performance.now(),
    };
  });
}

const original = await api<Project>('/project');
const browser = await chromium.launch();
const results: unknown[] = [];
let completed = false;
let failure: string | undefined;
const started = host();
const resourceEvidence = {
  tests: ['tests/scene-resources.test.ts', 'tests/scene-environment.spec.ts'],
  coverage:
    'Existing tests cover reuse across takes/revisions, cancellation/disposal and repeated scene rendering. This script does not claim measured GPU-resource stability; it reports observed JS heap before/after actual seeks.',
};
try {
  for (const film of films) {
    const hostBefore = host();
    const activeJobs = (await api<RenderJob[]>('/renders'))
      .filter((job) => ['queued', 'rendering', 'encoding'].includes(job.status))
      .map((job) => ({ id: job.id, status: job.status }));
    const openStarted = hostPerformance.now();
    const project = await api<Project>(`/projects/${encodeURIComponent(film.projectId)}/open`, {});
    const projectOpenMs = hostPerformance.now() - openStarted;
    const job = await api<RenderJob>(`/renders/${encodeURIComponent(film.jobId)}`);
    if (job.status !== 'completed' || job.options.projectId !== project.id)
      throw new Error(`Wrong or unfinished video for ${film.theme}`);
    const sequenceId = film.sequenceId ?? project.activeSequenceId;
    const sequence = project.sequences.find((item) => item.id === sequenceId);
    if (!sequence?.clips.length) throw new Error(`No playable sequence for ${film.theme}`);
    const duration = sequenceDuration(project, sequenceId);
    if (duration < 22)
      throw new Error('Performance playback measurement requires a sequence of at least 22 seconds');
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Performance.enable');
    await page.addInitScript(() => {
      const entries: { startTime: number; duration: number }[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          entries.push({ startTime: entry.startTime, duration: entry.duration });
      });
      observer.observe({ type: 'longtask', buffered: true });
      Object.defineProperty(window, '__performanceEvidence', { value: entries });
    });
    try {
      const navigationStarted = hostPerformance.now();
      await page.goto(values.web, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.project-name')).toContainText(project.name, { timeout: 120000 });
      const selector = page.getByRole('combobox', { name: '剪辑方案', exact: true });
      if ((await selector.inputValue()) !== sequenceId)
        throw new Error('Manifest sequence must already be active; measurement does not edit project state');
      await page.getByRole('button', { name: '摄影机', exact: true }).click();
      await page.waitForFunction(() => {
        const thumbnails = document.querySelectorAll<HTMLCanvasElement | HTMLImageElement>(
          '.shot-thumbnail canvas, .shot-thumbnail img',
        );
        return [...thumbnails].some((thumbnail) => {
          if (thumbnail instanceof HTMLImageElement && (!thumbnail.complete || !thumbnail.naturalWidth))
            return false;
          if (!thumbnail.width || !thumbnail.height) return false;
          const sample = document.createElement('canvas');
          sample.width = 32;
          sample.height = 18;
          const context = sample.getContext('2d')!;
          context.drawImage(thumbnail, 0, 0, sample.width, sample.height);
          const data = context.getImageData(0, 0, sample.width, sample.height).data;
          const colors = new Set<number>();
          for (let index = 0; index < data.length; index += 4) {
            if (data[index + 3]) colors.add((data[index] << 16) | (data[index + 1] << 8) | data[index + 2]);
          }
          return colors.size > 1;
        });
      });
      await painted(page);
      const coldPixels = await pixels(page);
      if (coldPixels.distinctColors < 2) throw new Error(`${film.theme} editor camera is blank`);
      const coldEditorMs = hostPerformance.now() - navigationStarted;
      const navigation = await page.evaluate(() => {
        const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        return {
          responseEnd: entry.responseEnd,
          domContentLoaded: entry.domContentLoadedEventEnd,
          loadEventEnd: entry.loadEventEnd,
          encodedBodySize: entry.encodedBodySize,
        };
      });
      const beforeSeeks = await cdp.send('Performance.getMetrics');
      const seeks: {
        index: number;
        targetTime: number;
        displayedTime: number;
        milliseconds: number;
        colors: number;
        checksum: number;
      }[] = [];
      const ruler = page.locator('.timeline-ruler');
      await ruler.scrollIntoViewIfNeeded();
      const box = await ruler.boundingBox();
      if (!box) throw new Error('Timeline ruler is not visible');
      const canvasSize = await pixels(page);
      for (let index = 0; index < 50; index++) {
        const fraction = 0.015 + (((index * 17) % 50) / 50) * 0.97;
        const target = duration * fraction;
        const seekStarted = hostPerformance.now();
        await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
        await page.waitForFunction(
          ({ target, fps }) => {
            const text = document.querySelector('.transport-time')?.firstChild?.textContent?.trim();
            const parts = text?.split(':').map(Number);
            if (!parts || parts.length !== 3) return false;
            const current = parts[0] * 60 + parts[1] + parts[2] / fps;
            return Math.abs(current - target) <= 2 / fps;
          },
          { target, fps: project.settings.fps },
        );
        await painted(page);
        const seekMs = hostPerformance.now() - seekStarted;
        const state = await pixels(page);
        const text = (
          await page.locator('.transport-time').evaluate((element) => element.firstChild?.textContent ?? '')
        ).trim();
        const parts = text.split(':').map(Number);
        seeks.push({
          index,
          targetTime: target,
          displayedTime: parts[0] * 60 + parts[1] + parts[2] / project.settings.fps,
          milliseconds: seekMs,
          colors: state.distinctColors,
          checksum: state.checksum,
        });
        if (state.distinctColors < 2) throw new Error(`${film.theme} seek ${index} produced a blank stage`);
        if ((index + 1) % 10 === 0)
          console.log(JSON.stringify({ theme: film.theme, seeks: index + 1, lastMs: seekMs }));
      }
      const afterSeeks = await cdp.send('Performance.getMetrics');
      await page.getByRole('button', { name: '导出视频', exact: true }).click();
      const record = page.locator('.render-job').filter({ has: page.locator(`a[href*="${job.id}"]`) });
      while (!(await record.count())) {
        const more = page.getByRole('button', { name: '更多导出记录', exact: true });
        if (!(await more.count())) throw new Error('Completed video is missing from the library');
        await more.click();
      }
      await record.getByRole('button', { name: '播放视频', exact: true }).click();
      const player = page.getByLabel('已导出白模视频', { exact: true });
      await expect.poll(() => mediaState(page), { timeout: 30000 }).toMatchObject({ error: undefined });
      await expect
        .poll(async () => (await mediaState(page)).readyState, { timeout: 30000 })
        .toBeGreaterThanOrEqual(3);
      await player.evaluate(async (element: HTMLVideoElement) => {
        element.pause();
        element.currentTime = 0;
        element.muted = true;
        element.playbackRate = 1;
        await element.play();
      });
      await expect
        .poll(async () => (await mediaState(page)).time, { timeout: 30000 })
        .toBeGreaterThanOrEqual(1);
      const initialPlayback = await mediaState(page);
      await page.waitForTimeout(20000);
      const finalPlayback = await mediaState(page);
      await player.evaluate((element: HTMLVideoElement) => element.pause());
      const decodedDelta = finalPlayback.decoded - initialPlayback.decoded;
      const droppedDelta = finalPlayback.dropped - initialPlayback.dropped;
      const playback = {
        initial: initialPlayback,
        final: finalPlayback,
        wallMilliseconds: finalPlayback.at - initialPlayback.at,
        advancedSeconds: finalPlayback.time - initialPlayback.time,
        decodedFrames: decodedDelta,
        droppedFrames: droppedDelta,
        droppedFraction: decodedDelta > 0 ? droppedDelta / decodedDelta : null,
        muted: true,
        rate: 1,
        screenshotsDuringMeasurement: 0,
      };
      const longTasks = await page.evaluate(
        () =>
          (window as unknown as { __performanceEvidence: { startTime: number; duration: number }[] })
            .__performanceEvidence,
      );
      const metric = (data: { metrics: { name: string; value: number }[] }) =>
        Object.fromEntries(data.metrics.map((item) => [item.name, item.value]));
      const result = {
        theme: film.theme,
        projectId: project.id,
        revision: project.revision,
        jobId: job.id,
        jobRevision: job.projectRevision,
        sequenceId,
        duration,
        objects: project.objects.length,
        scenes: project.production?.scenes.length ?? 1,
        cameraKeys: project.cameras.reduce((sum, camera) => sum + camera.keyframes.length, 0),
        objectKeys: project.objects.reduce((sum, object) => sum + object.keyframes.length, 0),
        projectBytes: Buffer.byteLength(JSON.stringify(project)),
        hostBefore,
        hostAfter: host(),
        activeRenderJobs: activeJobs,
        projectOpenMs,
        coldEditorMs,
        navigation,
        coldPixels,
        canvasSize,
        seekSummaryMs: summary(seeks.map((seek) => seek.milliseconds)),
        seeks,
        playback,
        cdpMetrics: { beforeSeeks: metric(beforeSeeks), afterSeeks: metric(afterSeeks) },
        longTasks,
        errors,
      };
      results.push(result);
      await writeFile(resolve(output, `${film.theme}-performance.json`), JSON.stringify(result, null, 2));
      console.log(
        JSON.stringify({ theme: film.theme, coldEditorMs, seekSummaryMs: result.seekSummaryMs, playback }),
      );
      if (errors.length || finalPlayback.error)
        throw new Error(`Browser errors in ${film.theme}: ${errors.join('; ')} ${finalPlayback.error ?? ''}`);
    } finally {
      await context.close();
    }
  }
  completed = true;
} catch (error) {
  failure = (error as Error).message;
  throw error;
} finally {
  await browser.close();
  await api(`/projects/${encodeURIComponent(original.id)}/open`, {}).catch((error: Error) =>
    console.error(`Restore active project: ${error.message}`),
  );
  await writeFile(
    resolve(output, 'performance-report.json'),
    JSON.stringify(
      {
        started,
        finished: host(),
        api: values.api,
        web: values.web,
        chromium: browser.version(),
        conditions: values.conditions,
        serial: true,
        performanceThresholds: null,
        methodology: {
          cold: 'Fresh Chromium BrowserContext with HTTP cache disabled. Navigation to matching project identity, selected camera view, first loaded shot thumbnail and a nonuniform stage canvas. Includes browser startup work after navigation and Playwright interaction; not a pure GPU load timer.',
          seeks:
            '50 deterministic real pointer clicks across the visible timeline ruler, ordered nonsequentially. End-to-end host monotonic time to matching displayed time plus two animation frames. Pixel checks run after timing. Includes driver round trips and UI work, not only renderer duration.',
          playback:
            'Actual exported MP4 in the application video player, 1x, muted, after 1s warmup; 20s without screenshots or polling. VideoPlaybackQuality counters report incremental decoded/dropped frames. Host load and active render jobs expose some external concurrency; arbitrary other processes are not controlled.',
          thresholds:
            'No performance pass/fail thresholds are invented. Errors and blank canvases fail functional checks. Inspect measured latency, video time advancement and dropped-frame ratios under the recorded conditions.',
        },
        resourceEvidence,
        completed,
        failure,
        results,
      },
      null,
      2,
    ),
  );
}
