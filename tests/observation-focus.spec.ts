import { expect, test, type Locator, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Box3, Object3D, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import type { Project, SceneObject, Vec3 } from '../shared/types';

interface ObservationProbe {
  activeCamera: PerspectiveCamera | OrthographicCamera;
  sceneBounds: Box3;
  objects: Map<string, { root: Object3D }>;
  orbit: { target: Vector3; maxDistance: number };
  selected: string[];
  editorCamera: PerspectiveCamera;
  topCamera: OrthographicCamera;
  editorOrbit: ObservationControls;
  topOrbit: ObservationControls;
}

interface ObservationControls {
  target: Vector3;
  _panOffset: Vector3;
  _sphericalDelta: { phi: number; theta: number };
  _scale: number;
}

declare global {
  interface Window {
    __observationFocus?: ObservationProbe;
  }
}

interface Fixture {
  name: string;
  objects: Partial<SceneObject>[];
  selected: string[];
  position: Vec3;
  target: Vec3;
}

const fixtures: Fixture[] = [
  {
    name: 'tower',
    objects: [{ id: 'tower', type: 'box', dimensions: [80, 160, 60], position: [300, 0, -80] }],
    selected: ['tower'],
    position: [300, 180, 500],
    target: [300, 80, -80],
  },
  {
    name: 'wide-site',
    objects: [{ id: 'wide', type: 'box', dimensions: [160, 2, 160], position: [600, 0, -80] }],
    selected: ['wide'],
    position: [600, 180, 350],
    target: [600, 1, -80],
  },
  {
    name: 'transformed-group',
    objects: [
      {
        id: 'group',
        type: 'group',
        position: [430, 65, -290],
        rotation: [12, 40, -6],
        scale: [2.3, 0.8, 1.6],
      },
      {
        id: 'nested',
        type: 'group',
        parentId: 'group',
        position: [-32, 8, 24],
        rotation: [-23, 12, 17],
        scale: [0.7, 1.5, 2],
      },
      { id: 'column', type: 'box', parentId: 'nested', dimensions: [12, 80, 18], position: [8, 0, -15] },
      {
        id: 'platform',
        type: 'box',
        parentId: 'group',
        dimensions: [60, 2, 90],
        position: [44, -3, 21],
        rotation: [0, -20, 0],
      },
    ],
    selected: ['group'],
    position: [450, 220, 450],
    target: [450, 100, -250],
  },
  {
    name: 'ordinary-object',
    objects: [{ id: 'ordinary', type: 'box', dimensions: [2, 3, 2], position: [3, 0, -2] }],
    selected: ['ordinary'],
    position: [8, 5, 10],
    target: [3, 1.5, -2],
  },
  {
    name: 'multiple-and-empty-selection',
    objects: [
      { id: 'left-object', type: 'box', dimensions: [25, 35, 25], position: [440, 0, -90] },
      { id: 'right-object', type: 'box', dimensions: [25, 45, 25], position: [560, 0, -60] },
    ],
    selected: ['left-object', 'right-object'],
    position: [500, 100, 350],
    target: [500, 22.5, -75],
  },
];

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stage = (page: Page) => page.locator('[data-testid="stage"] canvas');
const capture = (page: Page) => stage(page).evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
const settle = (page: Page, frames = 65) =>
  page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const tick = () => (--count <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames,
  );

async function viewportTool(page: Page, name: string, checkbox = false) {
  if (page.viewportSize()!.width <= 520) {
    await page.getByRole('button', { name: '更多视口工具', exact: true }).click();
    await page.getByRole(checkbox ? 'menuitemcheckbox' : 'menuitem', { name, exact: true }).click();
  } else await page.getByRole('button', { name, exact: true }).click();
}

async function selectObjects(page: Page, names: string[]) {
  const mobile = page.viewportSize()!.width <= 820;
  if (mobile) await page.getByRole('button', { name: '场景资源面板', exact: true }).click();
  for (const [index, name] of names.entries())
    await page.getByRole('button', { name, exact: true }).click({ modifiers: index ? ['Shift'] : [] });
  if (mobile) await page.getByRole('button', { name: '收起资源面板', exact: true }).click();
}

async function pixelBounds(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const copy = document.createElement('canvas');
    copy.width = element.width;
    copy.height = element.height;
    const context = copy.getContext('2d')!;
    context.drawImage(element, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let minX = copy.width,
      minY = copy.height,
      maxX = -1,
      maxY = -1,
      count = 0;
    for (let y = 0; y < copy.height; y++)
      for (let x = 0; x < copy.width; x++) {
        const index = (y * copy.width + x) * 4;
        if (
          Math.abs(pixels[index] - 18) + Math.abs(pixels[index + 1] - 63) + Math.abs(pixels[index + 2] - 98) <
          24
        )
          continue;
        count++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    return { width: copy.width, height: copy.height, minX, minY, maxX, maxY, count };
  });
}

async function projection(page: Page, ids: string[]) {
  return page.evaluate((ids) => {
    const engine = window.__observationFocus;
    if (!engine) return null;
    const camera = engine.activeCamera;
    const bounds = engine.sceneBounds.clone().makeEmpty();
    if (ids.length) for (const id of ids) bounds.expandByObject(engine.objects.get(id)!.root);
    else bounds.copy(engine.sceneBounds);
    camera.updateMatrixWorld(true);
    const corners = [];
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z]) {
          const point = camera.position.clone().set(x, y, z);
          corners.push({ world: point.toArray(), ndc: point.project(camera).toArray() });
        }
    return {
      selection: engine.selected,
      corners,
      position: camera.position.toArray(),
      target: engine.orbit.target.toArray(),
      distance: camera.position.distanceTo(engine.orbit.target),
      maxDistance: engine.orbit.maxDistance,
      forward: camera.getWorldDirection(camera.position.clone()).toArray(),
      near: camera.near,
      far: camera.far,
      zoom: camera.zoom,
    };
  }, ids);
}

async function navigationState(page: Page) {
  return page.evaluate(() => {
    const engine = window.__observationFocus;
    if (!engine) return null;
    const read = (camera: PerspectiveCamera | OrthographicCamera, control: ObservationControls) => ({
      position: camera.position.toArray(),
      target: control.target.toArray(),
      quaternion: camera.quaternion.toArray(),
      zoom: camera.zoom,
      pendingPan: control._panOffset.toArray(),
      pendingRotation: { ...control._sphericalDelta },
      pendingScale: control._scale,
    });
    return {
      edit: read(engine.editorCamera, engine.editorOrbit),
      top: read(engine.topCamera, engine.topOrbit),
    };
  });
}

async function pixelDifference(page: Page, before: string, after: string) {
  return page.evaluate(
    async ({ before, after }) => {
      const pixels = async (source: string) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const left = await pixels(before),
        right = await pixels(after);
      let changedPixels = 0,
        absoluteDifference = 0,
        maximumChannelDifference = 0;
      for (let i = 0; i < left.length; i += 4) {
        let changed = false;
        for (let channel = 0; channel < 3; channel++) {
          const difference = Math.abs(left[i + channel] - right[i + channel]);
          changed ||= difference > 0;
          absoluteDifference += difference;
          maximumChannelDifference = Math.max(maximumChannelDifference, difference);
        }
        if (changed) changedPixels++;
      }
      return { changedPixels, pixels: left.length / 4, absoluteDifference, maximumChannelDifference };
    },
    { before, after },
  );
}

async function panAndZoom(page: Page) {
  const before = await capture(page);
  const box = (await stage(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.38, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await settle(page);
  const panned = await capture(page);
  expect(hash(panned)).not.toBe(hash(before));
  await page.mouse.wheel(0, 350);
  await settle(page, 120);
  expect(hash(await capture(page))).not.toBe(hash(panned));
}

async function dragWithInertia(page: Page) {
  const box = (await stage(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45, { steps: 4 });
  await page.mouse.up();
}

for (const [viewport, width, height] of [
  ['desktop', 1440, 1000],
  ['mobile', 390, 844],
] as const) {
  test(`${viewport} observation focus fits large and ordinary scenes and preserves photographed cameras`, async ({
    page,
    request,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const records: unknown[] = [];
    for (const fixture of fixtures) {
      await page.setViewportSize({ width, height });
      const created = await request.post('/api/project/new', {
        data: { name: `Observation focus ${fixture.name}`, template: 'empty' },
      });
      expect(created.ok()).toBe(true);
      const project = (await created.json()) as Project;
      const response = await request.post('/api/commands', {
        data: {
          projectId: project.id,
          expectedRevision: project.revision,
          commands: [
            {
              type: 'project.settings',
              payload: {
                aspect: '16:9',
                environment: { ground: false, background: '#123f62', groundTone: '#cccccc' },
              },
            },
            ...fixture.objects.map((object) => ({
              type: 'object.create',
              payload: { ...object, name: object.id, tone: '#eeeeee', locked: true },
            })),
            {
              type: 'camera.create',
              payload: {
                id: 'saved-camera',
                name: 'Saved camera',
                position: fixture.position,
                target: fixture.target,
                fov: 44,
              },
            },
            {
              type: 'shot.create',
              payload: {
                id: 'saved-shot',
                name: 'Saved shot',
                cameraId: 'saved-camera',
                sourceIn: 0,
                sourceOut: 2,
              },
            },
            {
              type: 'sequence.update',
              payload: {
                id: project.activeSequenceId,
                patch: { clips: [{ id: 'saved-clip', shotId: 'saved-shot', sourceIn: 0, sourceOut: 2 }] },
              },
            },
          ],
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
      const savedBefore = (await (await request.get('/api/project')).json()) as Project;
      if (fixture.name === 'tower') await page.goto('/');
      await expect(page.locator('.project-name')).toHaveText(project.name);
      // Development telemetry only retains the instance; production runs use the same UI and pixel assertions.
      if (!testInfo.project.metadata.builtFrontend && fixture.name === 'tower')
        await page.evaluate(async () => {
          const path = '/src/engine/SceneEngine.ts';
          const { SceneEngine } = await import(path);
          const original = SceneEngine.prototype.focus;
          SceneEngine.prototype.focus = function (this: ObservationProbe, ...args: unknown[]) {
            window.__observationFocus = this;
            return original.apply(this, args);
          };
        });
      if (fixture.name === 'tower') {
        await viewportTool(page, '网格与辅助线', true);
        await stage(page).evaluate((canvas) =>
          canvas.setAttribute('data-observation-instance', 'persistent'),
        );
      } else await expect(stage(page)).toHaveAttribute('data-observation-instance', 'persistent');
      await selectObjects(page, fixture.selected);
      await page.getByRole('button', { name: '摄影机', exact: true }).click();
      await settle(page);
      const shotBefore = await capture(page);
      const client =
        fixture.name === 'tower' ? new Client({ name: 'observation-focus', version: '1' }) : null;
      const preview = async (label: string) => {
        const result = await client!.callTool({
          name: 'preview_capture',
          arguments: { time: 0, width: 1280, height: 720 },
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const image = (result.content as { type: string; data?: string }[]).find(
          (item) => item.type === 'image',
        );
        expect(image?.data).toBeTruthy();
        const bytes = Buffer.from(image!.data!, 'base64');
        await writeFile(testInfo.outputPath(`${viewport}-${label}.png`), bytes);
        return hash(bytes);
      };
      let previewBefore: string | null = null;
      try {
        if (client) {
          const connection = await (await request.get('/api/connection')).json();
          await client.connect(
            new StreamableHTTPClientTransport(new URL(connection.url), {
              requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
            }),
          );
          previewBefore = await preview('photographed-before');
        }
        const assertFramed = async (mode: 'edit' | 'top', label: string, ids = fixture.selected) => {
          await settle(page);
          const pixels = await pixelBounds(stage(page));
          expect(pixels.count, label).toBeGreaterThan(pixels.width * pixels.height * 0.005);
          expect(pixels.minX, label).toBeGreaterThan(pixels.width * 0.025);
          expect(pixels.minY, label).toBeGreaterThan(pixels.height * 0.025);
          expect(pixels.maxX, label).toBeLessThan(pixels.width * 0.975);
          expect(pixels.maxY, label).toBeLessThan(pixels.height * 0.975);
          const projected = await projection(page, ids);
          if (projected) {
            expect(projected.selection).toEqual(ids);
            for (const corner of projected.corners) {
              expect(Math.abs(corner.ndc[0]), label).toBeLessThanOrEqual(1 / 1.15 + 0.002);
              expect(Math.abs(corner.ndc[1]), label).toBeLessThanOrEqual(1 / 1.15 + 0.002);
              expect(corner.ndc[2], label).toBeGreaterThanOrEqual(-1);
              expect(corner.ndc[2], label).toBeLessThanOrEqual(1);
            }
            expect(projected.maxDistance).toBeGreaterThan(projected.distance);
            if (mode === 'top') expect(projected.forward[1]).toBeCloseTo(-1, 8);
          }
          const png = await capture(page);
          await settle(page, 15);
          expect(hash(await capture(page))).toBe(hash(png));
          const stem = `${viewport}-${fixture.name}-${label}`;
          await stage(page).screenshot({ path: testInfo.outputPath(`${stem}-canvas.png`) });
          await page.screenshot({ path: testInfo.outputPath(`${stem}-ui.png`) });
          records.push({
            fixture: fixture.name,
            mode,
            label,
            viewport: page.viewportSize(),
            pixels,
            projected,
            pngHash: hash(png),
          });
          await writeFile(
            testInfo.outputPath('observation-focus.json'),
            JSON.stringify(
              {
                viewport,
                builtFrontend: Boolean(testInfo.project.metadata.builtFrontend),
                errors,
                records,
              },
              null,
              2,
            ),
          );
          return png;
        };
        await page.getByRole('button', { name: '自由视角', exact: true }).click();
        await viewportTool(page, '聚焦选中对象');
        await assertFramed('edit', 'perspective-fit');
        await panAndZoom(page);
        if (fixture.name === 'tower') await dragWithInertia(page);
        await viewportTool(page, '聚焦选中对象');
        const editorFrame = await assertFramed('edit', 'perspective-refit');
        await page.getByRole('button', { name: '俯视调度', exact: true }).click();
        await viewportTool(page, '聚焦选中对象');
        await assertFramed('top', 'top-fit');
        await panAndZoom(page);
        const topNavigation = await capture(page);
        const navigationBefore = await navigationState(page);
        await page.getByRole('button', { name: '自由视角', exact: true }).click();
        await settle(page);
        expect(hash(await capture(page))).toBe(hash(editorFrame));
        await page.getByRole('button', { name: '俯视调度', exact: true }).click();
        await settle(page);
        const navigationAfter = await navigationState(page);
        const topReturned = await capture(page);
        const difference = await pixelDifference(page, topNavigation, topReturned);
        await writeFile(
          testInfo.outputPath(`${fixture.name}-view-switch.json`),
          JSON.stringify(
            {
              navigationBefore,
              navigationAfter,
              difference,
              beforeHash: hash(topNavigation),
              afterHash: hash(topReturned),
              settling: { panFrames: 65, afterWheelFrames: 120, afterEachViewSwitchFrames: 65 },
            },
            null,
            2,
          ),
        );
        await writeFile(
          testInfo.outputPath(`${fixture.name}-top-navigation-before.png`),
          Buffer.from(topNavigation.split(',')[1], 'base64'),
        );
        await writeFile(
          testInfo.outputPath(`${fixture.name}-top-navigation-after.png`),
          Buffer.from(topReturned.split(',')[1], 'base64'),
        );
        if (navigationBefore && navigationAfter) {
          expect(navigationAfter.edit).toEqual(navigationBefore.edit);
          expect(navigationAfter.top.zoom).toBe(navigationBefore.top.zoom);
          for (let axis = 0; axis < 3; axis++) {
            const remainder = navigationBefore.top.pendingPan[axis];
            expect(navigationAfter.top.target[axis]).toBeCloseTo(
              navigationBefore.top.target[axis] + remainder,
              6,
            );
            expect(navigationAfter.top.position[axis]).toBeCloseTo(
              navigationBefore.top.position[axis] + remainder,
              6,
            );
          }
          for (let component = 0; component < 4; component++)
            expect(navigationAfter.top.quaternion[component]).toBeCloseTo(
              navigationBefore.top.quaternion[component],
              10,
            );
          expect(navigationAfter.top.pendingPan).toEqual([0, 0, 0]);
        }
        // Consuming sub-micrometer damping can change an antialiased edge by one coverage sample.
        expect(difference.changedPixels / difference.pixels).toBeLessThan(0.002);
        expect(difference.absoluteDifference / (difference.pixels * 3)).toBeLessThan(0.1);
        if (fixture.name === 'tower') {
          await page.getByRole('button', { name: '自由视角', exact: true }).click();
          await dragWithInertia(page);
          await page.getByRole('button', { name: '俯视调度', exact: true }).click();
          await settle(page);
          expect(hash(await capture(page))).toBe(hash(topReturned));
          await page.getByRole('button', { name: '自由视角', exact: true }).click();
          await settle(page);
          const settledEditor = await capture(page);
          await settle(page, 15);
          expect(hash(await capture(page))).toBe(hash(settledEditor));
          await viewportTool(page, '聚焦选中对象');
          await assertFramed('edit', 'after-inertial-view-switch');
          await page.getByRole('button', { name: '俯视调度', exact: true }).click();
        }
        await viewportTool(page, '聚焦选中对象');
        await assertFramed('top', 'top-refit');
        if (fixture.name === 'wide-site') {
          for (const size of [
            { width: 1000, height: 1000 },
            { width: 390, height: 844 },
            { width, height },
          ]) {
            await page.setViewportSize(size);
            await page.getByRole('button', { name: '自由视角', exact: true }).click();
            await assertFramed('edit', `resize-${size.width}-edit`);
            await page.getByRole('button', { name: '俯视调度', exact: true }).click();
            await assertFramed('top', `resize-${size.width}-top`);
          }
          for (const [mode, name] of [
            ['edit', '自由视角'],
            ['top', '俯视调度'],
          ] as const) {
            await page.getByRole('button', { name, exact: true }).click();
            await panAndZoom(page);
            await viewportTool(page, '聚焦选中对象');
            await assertFramed(mode, `resize-navigation-${mode}`);
          }
        }
        if (fixture.selected.length > 1) {
          await page.keyboard.press('Escape');
          await page.getByRole('button', { name: '自由视角', exact: true }).click();
          await viewportTool(page, '聚焦选中对象');
          await assertFramed('edit', 'whole-scene-edit', []);
          await page.getByRole('button', { name: '俯视调度', exact: true }).click();
          await viewportTool(page, '聚焦选中对象');
          await assertFramed('top', 'whole-scene-top', []);
        }
        expect(await (await request.get('/api/project')).json()).toEqual(savedBefore);
        await page.getByRole('button', { name: '摄影机', exact: true }).click();
        await expect.poll(async () => hash(await capture(page))).toBe(hash(shotBefore));
        const previewAfter = client ? await preview('photographed-after') : null;
        expect(previewAfter).toBe(previewBefore);
        const reloaded = await page.context().newPage();
        try {
          await reloaded.setViewportSize({ width, height });
          await reloaded.goto('/');
          await reloaded.getByRole('button', { name: '摄影机', exact: true }).click();
          await expect.poll(async () => hash(await capture(reloaded))).toBe(hash(shotBefore));
        } finally {
          await reloaded.close();
          await page.bringToFront();
        }
        expect(await (await request.get('/api/project')).json()).toEqual(savedBefore);
        records.push({
          fixture: fixture.name,
          projectId: savedBefore.id,
          revision: savedBefore.revision,
          savedProjectUnchanged: true,
          persistentViewport: fixture.name !== 'tower',
          shotAndReloadHash: hash(shotBefore),
          previewBefore,
          previewAfter,
        });
      } finally {
        await client?.close();
      }
    }
    expect(errors).toEqual([]);
    await writeFile(
      testInfo.outputPath('observation-focus.json'),
      JSON.stringify(
        { viewport, builtFrontend: Boolean(testInfo.project.metadata.builtFrontend), errors, records },
        null,
        2,
      ),
    );
  });
}
