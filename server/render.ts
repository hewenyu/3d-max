import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { z } from 'zod';
import type { Project, RenderJob, RenderOptions } from '../shared/types.ts';
import type { ServerConfig } from './config.ts';
import type { Store } from './store.ts';
import { ApiError } from './errors.ts';
import { audioSegments } from './audio.ts';
import { encoderArguments } from './encoder.ts';

export const renderOptionsSchema = z
  .object({
    sequenceId: z.string().optional(),
    shotId: z.string().optional(),
    fps: z.number().int().min(1).max(60).optional(),
    resolution: z.union([z.literal(720), z.literal(1080)]).optional(),
    aspect: z.enum(['16:9', '9:16', '1:1']).optional(),
    includeAudio: z.boolean().optional(),
    burnIn: z.boolean().optional(),
    requestId: z.string().min(1).max(200).optional(),
    projectId: z.string().min(1).max(200).optional(),
    expectedRevision: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((options) => !(options.sequenceId && options.shotId), 'Choose a sequence or a shot, not both');
export const previewSchema = z
  .object({
    time: z.number().min(0).max(36000).default(0),
    shotId: z.string().optional(),
    sequenceId: z.string().optional(),
    width: z.number().int().min(64).max(1920).default(720),
    height: z.number().int().min(64).max(1920).default(1280),
  })
  .strict();
export type PreviewOptions = z.infer<typeof previewSchema>;

interface RenderBridge {
  load(project: Project, width: number, height: number): Promise<void>;
  frame(
    time: number,
    options: { sequenceId?: string; shotId?: string; sourceTime?: number; burnIn?: boolean },
  ): Promise<string>;
}

interface ActiveRender {
  cancelled: boolean;
  page?: Page;
  process?: ChildProcessWithoutNullStreams;
}

async function boundedPageTask<T>(page: Page, task: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ApiError('RENDER_TIMEOUT', `${label} exceeded 45 seconds`, 504));
      void page.close().catch(() => {});
    }, 45000);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function renderDuration(project: Project, options: RenderOptions) {
  if (options.shotId) {
    const shot = project.shots.find((item) => item.id === options.shotId);
    if (!shot) throw new ApiError('NOT_FOUND', 'Shot not found', 404);
    return shot.sourceOut - shot.sourceIn;
  }
  const sequence = project.sequences.find(
    (item) => item.id === (options.sequenceId || project.activeSequenceId),
  );
  if (!sequence) throw new ApiError('NOT_FOUND', 'Sequence not found', 404);
  return sequence.clips.reduce((sum, clip) => sum + clip.sourceOut - clip.sourceIn, 0);
}

export function renderDimensions(aspect: NonNullable<RenderOptions['aspect']>, resolution: number) {
  if (aspect === '1:1') return { width: resolution, height: resolution };
  const long = Math.round((resolution * 16) / 9 / 2) * 2;
  return aspect === '9:16' ? { width: resolution, height: long } : { width: long, height: resolution };
}

export class RenderService {
  private browser?: Promise<Browser>;
  private queue: string[] = [];
  private active = new Map<string, ActiveRender>();
  private pumping = false;
  private stopped = false;
  private previews = 0;

  constructor(
    private config: ServerConfig,
    private store: Store,
  ) {}

  private getBrowser() {
    if (!this.browser) {
      this.browser = chromium
        .launch({ headless: true, args: ['--disable-dev-shm-usage'] })
        .then((browser) => {
          browser.on('disconnected', () => {
            this.browser = undefined;
          });
          return browser;
        })
        .catch((error) => {
          this.browser = undefined;
          throw new ApiError(
            'BROWSER_UNAVAILABLE',
            `Chromium could not start. Run npx playwright install chromium. ${String(error)}`,
            503,
          );
        });
    }
    return this.browser;
  }

  private async page(project: Project, width: number, height: number) {
    const browser = await this.getBrowser();
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(45000);
    try {
      const url = new URL(this.config.appUrl);
      const allowedOrigins = new Set([url.origin, new URL(this.config.apiUrl).origin]);
      await page.routeWebSocket('**/*', (socket) => socket.close());
      await page.route('**/*', async (route) => {
        const resource = new URL(route.request().url());
        if (!allowedOrigins.has(resource.origin)) return route.abort('blockedbyclient');
        if (resource.pathname.startsWith('/api/')) {
          const asset = this.store.assetByUrl(resource.pathname);
          if (!asset) return route.abort('blockedbyclient');
          try {
            return await route.fulfill({
              status: 200,
              contentType: asset.mime,
              body: await readFile(asset.path),
            });
          } catch {
            return route.abort('failed');
          }
        }
        if (resource.pathname === '/mcp') return route.abort('blockedbyclient');
        return route.continue();
      });
      url.searchParams.set('render', '1');
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForFunction(() =>
        Boolean((window as unknown as { __WHITEFRAME_RENDER__?: RenderBridge }).__WHITEFRAME_RENDER__),
      );
      await boundedPageTask(
        page,
        page.evaluate(
          async ({ project: scene, width: w, height: h }) => {
            await (window as unknown as { __WHITEFRAME_RENDER__: RenderBridge }).__WHITEFRAME_RENDER__.load(
              scene,
              w,
              h,
            );
          },
          { project, width, height },
        ),
        'Scene loading',
      );
      return page;
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  private async frame(page: Page, project: Project, time: number, options: RenderOptions) {
    const shot = options.shotId ? project.shots.find((item) => item.id === options.shotId) : undefined;
    const data = await boundedPageTask(
      page,
      page.evaluate(
        async ({ time: current, options: settings }) =>
          (window as unknown as { __WHITEFRAME_RENDER__: RenderBridge }).__WHITEFRAME_RENDER__.frame(
            current,
            settings,
          ),
        {
          time,
          options: {
            sequenceId: options.sequenceId,
            shotId: options.shotId,
            sourceTime: shot ? shot.sourceIn + time : undefined,
            burnIn: options.burnIn,
          },
        },
      ),
      'Frame rendering',
    );
    if (typeof data !== 'string' || !data.startsWith('data:image/png;base64,'))
      throw new ApiError('INVALID_FRAME', 'Renderer did not return a PNG frame', 500);
    return data;
  }

  async preview(input: unknown) {
    const options = previewSchema.parse(input);
    if (options.shotId && options.sequenceId)
      throw new ApiError('INVALID_PREVIEW', 'Choose one shot or one sequence');
    const project = this.store.project();
    const duration = renderDuration(project, options);
    if (duration <= 0 || options.time > duration)
      throw new ApiError('INVALID_TIME', 'Preview time is outside the selected sequence or shot');
    if (this.previews >= 2) throw new ApiError('PREVIEW_BUSY', 'Two previews are already running', 429);
    this.previews++;
    let page: Page | undefined;
    try {
      page = await this.page(project, options.width, options.height);
      return {
        dataUrl: await this.frame(
          page,
          project,
          Math.min(options.time, Math.max(0, duration - 0.000001)),
          options,
        ),
      };
    } finally {
      await page?.close();
      this.previews--;
    }
  }

  start(input: unknown) {
    if (this.stopped) throw new ApiError('RENDER_UNAVAILABLE', 'Renderer is shutting down', 503);
    const { requestId, projectId, expectedRevision, ...parsed } = renderOptionsSchema.parse(input);
    const project = this.store.project();
    if (projectId !== undefined && projectId !== project.id)
      throw new ApiError('PROJECT_CONFLICT', 'The active project changed; read it before exporting', 409, {
        project,
      });
    const fingerprint = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    if (requestId) {
      const cached = this.store.cachedRender(project.id, requestId, fingerprint);
      if (cached) return cached;
    }
    if (expectedRevision !== undefined && expectedRevision !== project.revision)
      throw new ApiError(
        'REVISION_CONFLICT',
        'Project changed; read the latest revision before exporting',
        409,
        { project },
      );
    if (this.queue.length >= 8) throw new ApiError('RENDER_QUEUE_FULL', 'Export queue is full', 429);
    this.store.assertAssets(project);
    const options: RenderOptions = {
      ...parsed,
      fps: parsed.fps || project.settings.fps,
      resolution: parsed.resolution || project.settings.resolution,
      aspect: parsed.aspect || project.settings.aspect,
      includeAudio: parsed.includeAudio ?? true,
      burnIn: parsed.burnIn ?? false,
    };
    if (!options.shotId) options.sequenceId = parsed.sequenceId || project.activeSequenceId;
    const duration = renderDuration(project, options);
    const totalFrames = Math.ceil(duration * options.fps! - 1e-8);
    if (totalFrames < 1 || totalFrames > 18000)
      throw new ApiError('INVALID_DURATION', 'Export must contain 1 to 18000 frames');
    const job: RenderJob = {
      id: randomUUID(),
      status: 'queued',
      progress: 0,
      frame: 0,
      totalFrames,
      projectRevision: project.revision,
      createdAt: new Date().toISOString(),
      options,
    };
    this.store.addJob(job, project, requestId ? { id: requestId, fingerprint } : undefined);
    this.queue.push(job.id);
    void this.pump();
    return job;
  }

  cancel(id: string) {
    const job = this.store.job(id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    this.queue = this.queue.filter((value) => value !== id);
    const active = this.active.get(id);
    if (active) {
      active.cancelled = true;
      active.process?.kill('SIGKILL');
      void active.page?.close();
    }
    const next: RenderJob = { ...job, status: 'cancelled' };
    this.store.updateJob(next);
    return next;
  }

  private async pump() {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.stopped) await this.run(this.queue.shift()!);
    } finally {
      this.pumping = false;
    }
  }

  private async run(id: string) {
    let job = this.store.job(id);
    if (job.status !== 'queued') return;
    const project = this.store.jobProject(id);
    project.settings = {
      ...project.settings,
      aspect: job.options.aspect!,
      fps: job.options.fps!,
      resolution: job.options.resolution!,
    };
    const active: ActiveRender = { cancelled: false };
    this.active.set(id, active);
    const output = resolve(this.config.dataDir, 'renders', `${id}.mp4`);
    const update = (patch: Partial<RenderJob>) => {
      job = { ...job, ...patch };
      this.store.updateJob(job);
    };
    let completion: Promise<void> | undefined;
    try {
      update({ status: 'rendering' });
      const { width, height } = renderDimensions(job.options.aspect!, job.options.resolution!);
      active.page = await this.page(project, width, height);
      if (active.cancelled) return;
      const duration = job.totalFrames / job.options.fps!;
      const args = encoderArguments(job, audioSegments(project, job.options, duration, this.store), output);
      const process = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      active.process = process;
      let errorOutput = '';
      process.stderr.on('data', (data: Buffer) => {
        errorOutput = (errorOutput + data.toString()).slice(-6000);
      });
      process.stdout.resume();
      completion = new Promise<void>((resolveProcess, reject) => {
        process.once('error', (error) => reject(new Error(`FFmpeg failed to start: ${error.message}`)));
        process.once('close', (code) =>
          code === 0 ? resolveProcess() : reject(new Error(errorOutput || `FFmpeg exited with code ${code}`)),
        );
      });
      void completion.catch(() => {});
      process.stdin.on('error', () => {});
      for (let frame = 0; frame < job.totalFrames; frame++) {
        if (active.cancelled || this.stopped) throw new Error('Export cancelled');
        const image = await this.frame(active.page, project, frame / job.options.fps!, job.options);
        await new Promise<void>((done, reject) =>
          process.stdin.write(Buffer.from(image.slice('data:image/png;base64,'.length), 'base64'), (error) =>
            error ? reject(error) : done(),
          ),
        );
        if (frame % 4 === 0 || frame === job.totalFrames - 1)
          update({ frame: frame + 1, progress: Math.min(0.97, ((frame + 1) / job.totalFrames) * 0.97) });
      }
      process.stdin.end();
      update({ status: 'encoding', progress: 0.98 });
      let encodingTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          completion,
          new Promise<never>((_done, reject) => {
            encodingTimer = setTimeout(
              () =>
                reject(
                  new ApiError('ENCODING_TIMEOUT', 'Video encoding did not finish within 60 seconds', 504),
                ),
              60000,
            );
          }),
        ]);
      } finally {
        clearTimeout(encodingTimer);
      }
      if (!active.cancelled) update({ status: 'completed', progress: 1, url: `/api/renders/${id}/file` });
    } catch (error) {
      if (!active.cancelled)
        update({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      active.process?.kill('SIGKILL');
      await completion?.catch(() => {});
      await active.page?.close().catch(() => {});
      this.active.delete(id);
      if (this.store.job(id).status !== 'completed') await unlink(output).catch(() => {});
    }
  }

  async close() {
    this.stopped = true;
    for (const id of [...this.queue, ...this.active.keys()]) this.cancel(id);
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close();
    while (this.pumping) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}
