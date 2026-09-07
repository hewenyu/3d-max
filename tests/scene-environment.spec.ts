import { expect, test } from '@playwright/test';
import { createEmptyProject, createObject } from '../shared/project';
import { productionRenderFixture } from './fixtures/production-render';

test('large ground receivers remain uniformly lit outside actual object shadows', async ({
  page,
}, testInfo) => {
  const project = createEmptyProject('Shadow receiver');
  project.settings.aspect = '16:9';
  const base = createObject('plane');
  base.position = [0, -1.3, 1100];
  base.dimensions = [1000, 1, 2700];
  project.objects = [base];
  project.cameras = [
    {
      id: 'camera',
      name: 'Ground view',
      position: [10, 12, 40],
      target: [0, 0, 65],
      fov: 48,
      locked: false,
      keyframes: [],
    },
  ];
  project.shots = [
    {
      id: 'shot',
      name: 'Ground view',
      cameraId: 'camera',
      sourceIn: 0,
      sourceOut: 2,
      intent: '',
      subjectIds: [],
      hiddenIds: [],
      beatId: null,
      locked: false,
    },
  ];
  project.sequences[0].clips = [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 2 }];
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?render=1');
  await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
  await page.evaluate(async (project) => {
    await window.__WHITEFRAME_RENDER__!.load(project, 1280, 720);
    await window.__WHITEFRAME_RENDER__!.frame(0);
  }, project);
  const colors = await page
    .locator('canvas')
    .first()
    .evaluate((element) => {
      const copy = document.createElement('canvas');
      copy.width = 1280;
      copy.height = 720;
      const context = copy.getContext('2d')!;
      context.drawImage(element as HTMLCanvasElement, 0, 0);
      return [100, 320, 540, 760, 980, 1180].flatMap((x) =>
        [300, 450, 600].map((y) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3)),
      );
    });
  for (let channel = 0; channel < 3; channel++) {
    const values = colors.map((color) => color[channel]);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(3);
  }
  await page.screenshot({ path: testInfo.outputPath('uniform-ground-shadows.png') });
});

test('kilometer-scale water remains behind a close land surface without depth fighting', async ({
  page,
}, testInfo) => {
  const project = createEmptyProject('Deep water precision');
  project.settings.aspect = '16:9';
  project.settings.environment = { ground: false, background: '#ccddee', groundTone: '#b6bcb8' };
  const land = createObject('plane');
  land.dimensions = [1000, 0.1, 1000];
  land.tone = '#e1e4de';
  const water = createObject('plane');
  water.dimensions = [24000, 0.25, 24000];
  water.position = [0, -0.7, 0];
  water.tone = '#234c90';
  project.objects = [land, water];
  project.cameras = [
    {
      id: 'camera',
      name: 'Coast view',
      position: [-150, 80, -100],
      target: [0, 0, 150],
      fov: 48,
      locked: false,
      keyframes: [],
    },
  ];
  project.shots = [
    {
      id: 'shot',
      name: 'Coast view',
      cameraId: 'camera',
      sourceIn: 0,
      sourceOut: 2,
      intent: '',
      subjectIds: [],
      hiddenIds: [],
      beatId: null,
      locked: false,
    },
  ];
  project.sequences[0].clips = [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 2 }];
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?render=1');
  await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
  await page.evaluate(async (project) => {
    await window.__WHITEFRAME_RENDER__!.load(project, 1280, 720);
    await window.__WHITEFRAME_RENDER__!.frame(0);
  }, project);
  const blue = await page
    .locator('canvas')
    .first()
    .evaluate((element) => {
      const copy = document.createElement('canvas');
      copy.width = 1280;
      copy.height = 720;
      const context = copy.getContext('2d')!;
      context.drawImage(element as HTMLCanvasElement, 0, 0);
      const data = context.getImageData(300, 360, 680, 300).data;
      let count = 0;
      for (let index = 0; index < data.length; index += 4) if (data[index + 2] > data[index] + 25) count++;
      return count;
    });
  expect(blue).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('large-depth-precision.png') });
});

test('large scenes render beyond 300 meters and ground-free environments export correctly', async ({
  page,
}, testInfo) => {
  const project = createEmptyProject('Deep scene');
  project.settings.aspect = '16:9';
  project.settings.environment = { ground: false, background: '#ccddee', groundTone: '#b6bcb8' };
  const remote = createObject('box');
  remote.id = 'remote';
  remote.dimensions = [400, 300, 300];
  remote.position = [0, 0, -1500];
  remote.tone = '#68796f';
  project.objects = [remote];
  project.cameras = [
    {
      id: 'camera',
      name: 'Long range',
      position: [0, 180, 0],
      target: [0, 180, -1500],
      fov: 35,
      locked: false,
      keyframes: [],
    },
  ];
  project.shots = [
    {
      id: 'shot',
      name: 'Long range',
      cameraId: 'camera',
      sourceIn: 0,
      sourceOut: 2,
      intent: '',
      subjectIds: ['remote'],
      hiddenIds: [],
      beatId: null,
      locked: false,
    },
  ];
  project.sequences[0].clips = [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 2 }];
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?render=1');
  await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
  const first = await page.evaluate(async (project) => {
    await window.__WHITEFRAME_RENDER__!.load(project, 1280, 720);
    return window.__WHITEFRAME_RENDER__!.frame(0);
  }, project);
  const pixels = await page
    .locator('canvas')
    .first()
    .evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d')!;
      context.drawImage(canvas, 0, 0);
      const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
      return { upper: pixel(10, 10), lower: pixel(10, 710), center: pixel(640, 360) };
    });
  expect(pixels.upper).toEqual(pixels.lower);
  expect(pixels.center).not.toEqual(pixels.upper);
  await page.screenshot({ path: testInfo.outputPath('large-ground-free-scene.png') });
  const next = structuredClone(project);
  next.settings.environment!.ground = true;
  const ground = await page.evaluate(async (project) => {
    await window.__WHITEFRAME_RENDER__!.load(project, 1280, 720);
    return window.__WHITEFRAME_RENDER__!.frame(0);
  }, next);
  expect(ground).not.toBe(first);
  await page.screenshot({ path: testInfo.outputPath('large-ground-scene.png') });
});

test('shot bindings select the environment stored in each scene', async ({ page }) => {
  const project = productionRenderFixture();
  project.settings.environment = { ground: false, background: '#ccddee', groundTone: '#b6bcb8' };
  project.production!.scenes[0].environment = project.settings.environment;
  project.production!.scenes[1].environment = { ground: false, background: '#dde8d7', groundTone: '#b6bcb8' };
  await page.goto('/?render=1');
  await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
  const colors = await page.evaluate(async (project) => {
    const bridge = window.__WHITEFRAME_RENDER__!;
    await bridge.load(project, 1280, 720);
    const result: number[][] = [];
    for (const time of [0, 4, 0]) {
      await bridge.frame(time);
      const source = document.querySelector('canvas')!;
      const copy = document.createElement('canvas');
      copy.width = source.width;
      copy.height = source.height;
      const context = copy.getContext('2d')!;
      context.drawImage(source, 0, 0);
      result.push([...context.getImageData(5, 5, 1, 1).data]);
    }
    return result;
  }, project);
  expect(colors[0]).not.toEqual(colors[1]);
  expect(colors[0]).toEqual(colors[2]);
});
