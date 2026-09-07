import { expect, test } from '@playwright/test';
import { createEmptyProject, createObject } from '../shared/project';
import type { Project } from '../shared/types';
import type { SceneEngine } from '../src/engine/SceneEngine';

declare global {
  interface Window {
    opticsTest: { engine: SceneEngine; project: Project };
  }
}

function opticalFixture() {
  const project = createEmptyProject('Optical verification');
  project.settings.aspect = '16:9';
  project.settings.safeArea = { top: 0.1, right: 0.15, bottom: 0.2, left: 0.05, thirds: false };
  for (let index = 0; index < 9; index++) {
    for (const distance of [1.6, 4]) {
      const bar = createObject('box', `Focus chart ${distance} ${index}`);
      const ratio = distance / 1.6;
      bar.dimensions = [0.027 * ratio, 0.65 * ratio, 0.02];
      bar.position = [
        (distance === 1.6 ? -0.3 : 0.7) + (index - 4) * 0.029 * ratio,
        1.1 - bar.dimensions[1] / 2,
        -distance,
      ];
      bar.tone = index % 2 ? '#f5f5f5' : '#333333';
      project.objects.push(bar);
    }
  }
  project.cameras = [
    {
      id: 'optical-camera',
      name: 'Focus pull',
      position: [0, 1.1, 0],
      target: [0, 1.1, -1],
      fov: 25,
      locked: false,
      keyframes: [],
      optics: {
        enabled: true,
        focusDistance: 1.6,
        focusTargetId: null,
        fStop: 0.7,
        sensorWidthMm: 36,
        keyframes: [{ id: 'focus-pull', time: 2, focusDistance: 4, easing: 'linear' }],
      },
      compositions: {
        '9:16': { position: [-0.3, 1.1, 0], target: [-0.3, 1.1, -1], fov: 30, keyframes: [] },
      },
    },
  ];
  project.shots = [
    {
      id: 'optical-shot',
      name: 'Pull focus',
      cameraId: 'optical-camera',
      sourceIn: 0,
      sourceOut: 3,
      intent: '',
      subjectIds: [],
      hiddenIds: [],
      beatId: null,
      locked: false,
    },
  ];
  project.sequences[0].clips = [{ id: 'optical-clip', shotId: 'optical-shot', sourceIn: 0, sourceOut: 3 }];
  return project;
}

test('independent optical focus pulls change depth sharpness with matching deterministic PNG export', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = opticalFixture();
  await page.route('**/optics-render-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><body style="margin:0"><div id="stage" style="position:relative;width:1280px;height:720px"></div></body>',
    }),
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/optics-render-test');
  await page.evaluate(async (project) => {
    const path = '/src/engine/SceneEngine.ts';
    const { SceneEngine } = await import(/* @vite-ignore */ path);
    const engine = new SceneEngine(document.getElementById('stage')!, { interactive: false });
    window.opticsTest = { engine, project };
    engine.setHelpers(false);
    engine.setView('camera');
    await engine.setProject(project);
  }, project);
  const frames = await page.evaluate(() => {
    const engine = window.opticsTest.engine;
    const capture = (time: number) => {
      engine.setTime(time);
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext('2d')!;
      context.drawImage(engine.canvas, 0, 0);
      const values = context.getImageData(0, 0, 1280, 720).data;
      const contrast = (start: number, end: number) => {
        let total = 0;
        for (let y = 240; y < 480; y += 4)
          for (let x = start; x < end; x++) {
            const index = (y * 1280 + x) * 4;
            total += Math.abs(values[index] - values[index + 4]);
          }
        return total;
      };
      return {
        png: engine.capture(),
        near: contrast(180, 490),
        far: contrast(760, 1030),
        target: engine.getSample()?.camera?.target,
        focus: engine.getSample()?.camera?.optics?.focusDistance,
      };
    };
    return { near: capture(0), middle: capture(1), far: capture(2), repeat: capture(0) };
  });
  expect(frames.near.focus).toBe(1.6);
  expect(frames.middle.focus).toBeCloseTo(2.8);
  expect(frames.far.focus).toBe(4);
  expect(frames.near.target).toEqual(frames.far.target);
  expect(frames.near.near).toBeGreaterThan(frames.far.near * 1.4);
  expect(frames.far.far).toBeGreaterThan(frames.near.far * 1.4);
  expect(frames.near.png).toBe(frames.repeat.png);
  await page.screenshot({ path: testInfo.outputPath('optics-near-focus.png') });
  await page.evaluate(() => window.opticsTest.engine.setTime(2));
  await page.screenshot({ path: testInfo.outputPath('optics-far-focus.png') });
  await page.evaluate(() => window.opticsTest.engine.setSafeFrame(true));
  const safety = await page.locator('#stage > div').evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
    width: (element as HTMLElement).style.width,
    height: (element as HTMLElement).style.height,
    guides: [...element.children].map((child) => (child as HTMLElement).style.display),
  }));
  expect(safety).toEqual({
    left: '64px',
    top: '72px',
    width: '1024px',
    height: '504px',
    guides: ['none', 'none', 'none', 'none'],
  });
  await page.evaluate(() => window.opticsTest.engine.dispose());
  await page.goto('/?render=1');
  await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
  const exported = await page.evaluate(async (project) => {
    await window.__WHITEFRAME_RENDER__!.load(project, 1280, 720);
    return window.__WHITEFRAME_RENDER__!.frame(2);
  }, project);
  expect(exported).toBe(frames.far.png);
  expect(errors).toEqual([]);
});

test('portrait framing has an independent camera without changing landscape composition', async ({
  page,
}, testInfo) => {
  const project = opticalFixture();
  project.settings.aspect = '9:16';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?render=1');
  await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
  const images = await page.evaluate(async (project) => {
    const bridge = window.__WHITEFRAME_RENDER__!;
    await bridge.load(project, 390, 693);
    const portrait = await bridge.frame(0);
    const path = '/shared/timeline.ts';
    const { sampleCamera } = await import(/* @vite-ignore */ path);
    const portraitCamera = sampleCamera(project.cameras[0], 0, '9:16');
    const landscapeCamera = sampleCamera(project.cameras[0], 0, '16:9');
    return { portrait, portraitCamera, landscapeCamera };
  }, project);
  expect(images.portraitCamera.position).toEqual([-0.3, 1.1, 0]);
  expect(images.landscapeCamera.position).toEqual([0, 1.1, 0]);
  expect(images.portraitCamera.fov).toBe(30);
  expect(images.landscapeCamera.fov).toBe(25);
  expect(images.portrait.length).toBeGreaterThan(10000);
  await page.screenshot({ path: testInfo.outputPath('optics-portrait.png') });
});
