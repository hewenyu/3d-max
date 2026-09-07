import { expect, test, type Page } from '@playwright/test';
import type { SceneEngine } from '../src/engine/SceneEngine';
import type { BuiltObject } from '../src/engine/ObjectFactory';
import type { Project } from '../shared/types';
import { productionRenderFixture } from './fixtures/production-render';

declare global {
  interface Window {
    productionTest: { engine: SceneEngine; project: Project; selected: Array<string | null> };
  }
}

async function harness(page: Page, project: Project, width: number, height: number) {
  await page.route('**/production-render-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body style="margin:0"><div id="viewport" style="position:relative;width:100vw;height:100vh"></div></body></html>',
    }),
  );
  await page.setViewportSize({ width, height });
  await page.goto('/production-render-test');
  await page.evaluate(async (project) => {
    const path = '/src/engine/SceneEngine.ts';
    const { SceneEngine } = await import(/* @vite-ignore */ path);
    const selected: Array<string | null> = [];
    const engine = new SceneEngine(document.getElementById('viewport')!, {
      interactive: true,
      onSelect: (id: string | null) => selected.push(id),
    });
    window.productionTest = { engine, project, selected };
    engine.setHelpers(false);
    engine.setView('camera');
    await engine.setProject(project);
  }, project);
}

async function frame(page: Page, time: number, mode: 'camera' | 'edit' | 'top' = 'camera') {
  return page.evaluate(
    ({ time, mode }) => {
      const engine = window.productionTest.engine;
      engine.setView(mode);
      engine.setTime(time);
      const internal = engine as unknown as { objects: Map<string, BuiltObject> };
      const actor = internal.objects.get('shared-actor')!.root;
      const marker = internal.objects.get('shared-marker')!.root;
      const image = document.createElement('canvas');
      image.width = engine.canvas.width;
      image.height = engine.canvas.height;
      const context = image.getContext('2d')!;
      context.drawImage(engine.canvas, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const colors = new Set<number>();
      for (let index = 0; index < pixels.length; index += 16)
        colors.add((pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2]);
      return {
        actor: { uuid: actor.uuid, position: actor.position.toArray() },
        marker: marker.uuid,
        context: engine.getRenderContext(),
        png: engine.capture(),
        colors: colors.size,
      };
    },
    { time, mode },
  );
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`scene cuts and independent takes render deterministic nonblank pixels at ${viewport.width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const project = productionRenderFixture();
    await harness(page, project, viewport.width, viewport.height);
    const original = await frame(page, 0.5);
    const alternate = await frame(page, 2.5);
    const second = await frame(page, 4.5);
    expect(original.actor.position[0]).toBeCloseTo(-1.25);
    expect(alternate.actor.position[0]).toBeCloseTo(1.775);
    expect(second.actor.position[0]).toBe(-2);
    expect(original.actor.uuid).toBe(alternate.actor.uuid);
    expect(original.actor.uuid).not.toBe(second.actor.uuid);
    expect(original.marker).not.toBe(second.marker);
    expect(original.context.workspace).toBe(true);
    expect(alternate.context.workspace).toBe(false);
    expect(second.context.sceneId).toBe('scene-second');
    expect(new Set([original.png, alternate.png, second.png]).size).toBe(3);
    for (const result of [original, alternate, second]) expect(result.colors).toBeGreaterThan(200);
    expect((await frame(page, 0.5)).png).toBe(original.png);
    expect((await frame(page, 4)).actor.position[0]).toBe(-2);
    await page.screenshot({ path: `test-results/production-render-${viewport.width}.png` });
    await page.mouse.click(viewport.width / 2, viewport.height / 2);
    expect(await page.evaluate(() => window.productionTest.selected)).toEqual([]);
    expect((await frame(page, 4.5, 'edit')).actor.position[0]).toBeCloseTo(-1.25);
    expect((await frame(page, 4.5, 'top')).context.workspace).toBe(true);
    await page.evaluate(async () => {
      const { engine, project } = window.productionTest;
      const next = structuredClone(project);
      next.objects[0].name = 'Renamed performer';
      await engine.setProject(next);
    });
    expect((await frame(page, 0.5)).actor.uuid).toBe(original.actor.uuid);
    expect(errors).toEqual([]);
    await page.evaluate(() => window.productionTest.engine.dispose());
  });
}

test('PNG export bridge and shared thumbnails resolve bound production scenes and performances', async ({
  page,
}) => {
  const project = productionRenderFixture();
  await harness(page, project, 1280, 720);
  const expected = await frame(page, 4.5);
  await page.evaluate(() => window.productionTest.engine.dispose());
  await page.goto('/?render=1');
  await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
  const exported = await page.evaluate(async (project) => {
    const bridge = window.__WHITEFRAME_RENDER__!;
    await bridge.load(project, 1280, 720);
    const second = await bridge.frame(4.5);
    const alternate = await bridge.frame(0, { shotId: 'shot-2', sourceTime: 0.5 });
    const repeated = await bridge.frame(4.5);
    const path = '/src/engine/ThumbnailRenderer.ts';
    const thumbnails = await import(/* @vite-ignore */ path);
    const previews: string[] = [];
    for (const shot of project.shots) previews.push(await thumbnails.requestShotThumbnail(project, shot));
    thumbnails.disposeThumbnailRenderer();
    return { second, alternate, repeated, previews };
  }, project);
  expect(exported.second).toBe(expected.png);
  expect(exported.repeated).toBe(exported.second);
  expect(exported.alternate).not.toBe(exported.second);
  expect(new Set(exported.previews).size).toBe(3);
  expect(exported.previews.every((preview) => preview.startsWith('data:image/png;base64,'))).toBe(true);
});
