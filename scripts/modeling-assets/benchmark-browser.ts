import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { chromium, type Browser, type Page } from '@playwright/test';
import { PerspectiveCamera, Vector3 } from 'three';
import type { WorkspaceCommand, WorkspaceState } from '../../shared/workspace';
import { ModelingAssetClient } from './client';

type BrowserProbe = {
  active: boolean;
  last: number | null;
  frames: number[];
  longTasks: number[];
  observer?: PerformanceObserver;
};
type ProbeWindow = Window & { __modelingBenchmark?: BrowserProbe };
export function sampleSummary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    min: sorted[0] ?? null,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null,
    max: sorted.at(-1) ?? null,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
  };
}
async function painted(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}
async function pixels(page: Page) {
  return page.locator('[data-testid="stage"] canvas').evaluate((element: HTMLCanvasElement) => {
    const copy = document.createElement('canvas');
    copy.width = 240;
    copy.height = 160;
    const context = copy.getContext('2d')!;
    context.drawImage(element, 0, 0, copy.width, copy.height);
    const bytes = context.getImageData(0, 0, copy.width, copy.height).data;
    const colors = new Set<number>();
    let checksum = 2166136261;
    for (let index = 0; index < bytes.length; index += 4) {
      const value = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
      colors.add(value);
      checksum = Math.imul(checksum ^ value, 16777619) >>> 0;
    }
    return { width: element.width, height: element.height, distinctColors: colors.size, checksum };
  });
}

export class ModelingBrowserBenchmark {
  private browser?: Browser;
  private page?: Page;
  private workspaceId = '';
  private errors: string[] = [];
  private sourceWorkers: { url: string; closed: boolean }[] = [];
  constructor(
    private readonly client: ModelingAssetClient,
    private readonly url: string,
  ) {}
  private guard() {
    return {
      workspaceId: this.workspaceId,
      projectId: this.client.project.id,
      expectedRevision: this.client.project.revision,
    };
  }
  private apply(command: WorkspaceCommand) {
    return this.client.call<WorkspaceState>('workspace_apply', {
      ...this.guard(),
      requestId: randomUUID(),
      command,
    });
  }
  private async state() {
    const deadline = Date.now() + 30000;
    while (true) {
      try {
        return await this.client.call<WorkspaceState>('workspace_get', this.guard());
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !(
            error.message.includes('WORKSPACE_NOT_READY') ||
            (error.message.includes('REVISION_MISMATCH') &&
              error.message.includes('workspaceProjectRevision'))
          ) ||
          Date.now() > deadline
        )
          throw error;
        await new Promise((done) => setTimeout(done, 25));
      }
    }
  }
  async open() {
    this.browser ??= await chromium.launch({ headless: true });
    await this.page?.close();
    this.page = await this.browser.newPage({ viewport: { width: 1440, height: 1000 } });
    this.errors = [];
    this.sourceWorkers = [];
    this.page.on('pageerror', (error) => this.errors.push(error.message));
    this.page.on('worker', (worker) => {
      if (!worker.url().includes('ComponentSourceWorker')) return;
      const record = { url: worker.url(), closed: false };
      this.sourceWorkers.push(record);
      worker.on('close', () => {
        record.closed = true;
      });
    });
    const started = performance.now();
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });
    await this.page.locator('[data-testid="stage"] canvas').waitFor({ state: 'visible' });
    this.workspaceId = '';
    const deadline = Date.now() + 60000;
    while (!this.workspaceId && Date.now() < deadline) {
      const sessions =
        await this.client.call<{ id: string; connected: boolean; state: WorkspaceState }[]>('workspace_list');
      this.workspaceId =
        sessions.find(
          (session) =>
            session.connected &&
            session.state.projectId === this.client.project.id &&
            session.state.projectRevision === this.client.project.revision &&
            !session.state.viewport.loading,
        )?.id ?? '';
      if (!this.workspaceId) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(this.workspaceId, 'Editor did not register the benchmark project');
    const loadedMs = performance.now() - started;
    await this.startSampling();
    const sourceStarted = performance.now();
    await this.apply({ type: 'selection', ids: ['benchmark-mesh'] });
    await this.apply({
      type: 'observation',
      view: 'edit',
      position: [6, 4, 8],
      target: [0, 1.5, 0],
      fov: 43,
    });
    await this.apply({ type: 'components', objectId: 'benchmark-mesh', mode: 'face', display: 'solid' });
    await painted(this.page);
    const sourcePreparationMs = performance.now() - sourceStarted;
    const sourceSampling = await this.finishSampling();
    assert.ok(this.sourceWorkers.length > 0, 'Component source was not prepared by the production Worker');
    assert.equal((await this.state()).viewport.loading, false);
    const cdp = await this.page.context().newCDPSession(this.page);
    await cdp.send('Performance.enable');
    const metrics = await cdp.send('Performance.getMetrics');
    await cdp.detach();
    return {
      loadedMs,
      sourcePreparation: {
        elapsedMs: sourcePreparationMs,
        ...sourceSampling,
        workers: this.sourceWorkers.map((worker) => ({ ...worker })),
      },
      browserVersion: this.browser.version(),
      heap: metrics.metrics.filter((metric) =>
        ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents'].includes(metric.name),
      ),
      pixels: await pixels(this.page),
    };
  }
  async startSampling() {
    await this.page!.evaluate(() => {
      const state: BrowserProbe = { active: true, last: null, frames: [], longTasks: [] };
      const observer = new PerformanceObserver((entries) =>
        entries.getEntries().forEach((entry) => state.longTasks.push(entry.duration)),
      );
      try {
        observer.observe({ entryTypes: ['longtask'] });
        state.observer = observer;
      } catch {
        observer.disconnect();
      }
      (window as ProbeWindow).__modelingBenchmark = state;
      const sampler = {
        frame(time: number) {
          if (!state.active) return;
          if (state.last !== null) state.frames.push(time - state.last);
          state.last = time;
          requestAnimationFrame((next) => sampler.frame(next));
        },
      };
      requestAnimationFrame((time) => sampler.frame(time));
    });
  }
  async finishSampling() {
    const updateStarted = performance.now();
    await this.state();
    await painted(this.page!);
    const publicationToReadyMs = performance.now() - updateStarted;
    const measured = await this.page!.evaluate(() => {
      const state = (window as ProbeWindow).__modelingBenchmark!;
      state.active = false;
      state.observer?.disconnect();
      return { frames: state.frames, longTasks: state.longTasks };
    });
    return {
      publicationToReadyMs,
      frameIntervalMs: sampleSummary(measured.frames),
      longTasksMs: sampleSummary(measured.longTasks),
      framesOver50ms: measured.frames.filter((value) => value > 50).length,
    };
  }
  async inspectSelection(grade: string) {
    const page = this.page!;
    const readyStarted = performance.now();
    await this.state();
    const source = this.client.project.objects.find((object) => object.id === 'benchmark-mesh')?.modeling;
    assert.ok(source?.kind === 'mesh');
    const namespace = source.identity?.namespace ?? (await this.state()).components?.selection?.namespace;
    assert.ok(namespace, 'Component workspace did not identify the legacy mesh source');
    await this.apply({
      type: 'components',
      objectId: 'benchmark-mesh',
      mode: 'face',
      selection: {
        namespace,
        kind: 'face',
        ids: [],
        operation: 'replace',
      },
    });
    await painted(page);
    const renderReadyMs = performance.now() - readyStarted;
    const before = await pixels(page);
    assert.ok(before.distinctColors > 30, `Blank 3D viewport: ${JSON.stringify(before)}`);
    const canvas = page.locator('[data-testid="stage"] canvas');
    const bounds = (await canvas.boundingBox())!;
    const camera = new PerspectiveCamera(43, bounds.width / bounds.height, 0.05, 300);
    camera.position.set(6, 4, 8);
    camera.lookAt(0, 1.5, 0);
    camera.updateMatrixWorld(true);
    const point = new Vector3(1.2, 1.5, 1.6).project(camera);
    const start = performance.now();
    await page.mouse.click(
      bounds.x + ((point.x + 1) * bounds.width) / 2,
      bounds.y + ((1 - point.y) * bounds.height) / 2,
    );
    let state = await this.state();
    const deadline = Date.now() + 30000;
    while (!state.components?.selection?.ids.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = await this.state();
    }
    assert.ok(state.components?.selection?.ids.length, 'Physical viewport click did not select a face');
    assert.equal(state.components.mode, 'face');
    const clickToStateMs = performance.now() - start;
    await painted(page);
    const selected = await pixels(page);
    await this.client.writeArtifact(`${grade}-desktop.png`, await page.screenshot());
    const selection = state.components.selection;
    const mcpStart = performance.now();
    await this.apply({ type: 'components', selection: { ...selection, operation: 'connected' } });
    const mcpSelectMs = performance.now() - mcpStart;
    const all = await this.state();
    assert.ok((all.components?.selection?.ids.length ?? 0) > 1, 'Connected selection did not expand');
    await painted(page);
    const connectedPixels = await pixels(page);
    assert.notEqual(
      connectedPixels.checksum,
      before.checksum,
      'Connected selection did not change rendered feedback',
    );
    await this.apply({
      type: 'components',
      selection: { ...selection, ids: [], operation: 'replace' },
      mode: 'object',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await painted(page);
    const mobile = await pixels(page);
    assert.ok(mobile.distinctColors > 30, `Blank mobile viewport: ${JSON.stringify(mobile)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await this.client.writeArtifact(`${grade}-mobile.png`, await page.screenshot());
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = await cdp.send('Performance.getMetrics');
    await cdp.detach();
    assert.deepEqual(this.errors, [], 'Browser emitted uncaught errors');
    return {
      clickToStateMs,
      renderReadyMs,
      mcpSelectMs,
      selectedFaceIds: selection.ids,
      connectedCount: all.components?.selection?.ids.length,
      before,
      selected,
      connectedPixels,
      mobile,
      heap: metrics.metrics.filter((metric) => ['JSHeapUsedSize', 'JSHeapTotalSize'].includes(metric.name)),
      errors: this.errors,
    };
  }
  async verifyCapture(data: string) {
    return this.page!.evaluate(async (base64: string) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const colors = new Set<number>();
      for (let index = 0; index < pixels.length; index += 16)
        colors.add((pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2]);
      return { width: image.width, height: image.height, distinctColors: colors.size };
    }, data);
  }
  async close() {
    await this.browser?.close();
  }
}
