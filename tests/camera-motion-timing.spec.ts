import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFile } from 'node:fs/promises';
import { attachedCameraFixture } from './fixtures/camera-prop';
import type { CommandResponse, Project } from '../shared/types';
import type { SceneEngine } from '../src/engine/SceneEngine';
import type { BuiltObject } from '../src/engine/ObjectFactory';
import type { PerspectiveCamera } from 'three';

test('active repeated clip drives UI and MCP follow through reverse independent timing and renders the held prop at frame center', async ({
  page,
  request,
}, testInfo) => {
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'camera-timing-browser', version: '1' });
  const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return JSON.parse(
      (result.content as { type: string; text?: string }[]).find((item) => item.type === 'text')!.text!,
    ) as T;
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    const initial = attachedCameraFixture();
    initial.sequences[0].clips[0].sourceOut = 1;
    initial.sequences[0].clips.push({
      id: 'reverse-repeat',
      shotId: 'prop-shot',
      sourceIn: 0,
      sourceOut: 3,
      retiming: {
        audio: 'mute',
        segments: [{ duration: 3, fromSpeed: 0.25, toSpeed: 1.75, easing: 'smooth' }],
      },
      cameraTiming: { mode: 'independent', sourceIn: 8, rate: -2 },
    });
    await call('project_import', { project: initial });
    await page.goto('/');
    await expect(page.locator('[data-testid="stage"] canvas')).toBeVisible();
    await page.locator('.shot-card').nth(1).click();
    await expect(page.locator('.transport-time')).toContainText('00:01:00');
    await page.getByRole('combobox', { name: '运动方式', exact: true }).selectOption('follow');
    await page.getByRole('combobox', { name: '运镜主体', exact: true }).selectOption('handover-prop');
    await page.getByRole('button', { name: '生成运镜关键帧', exact: true }).click();
    await expect
      .poll(async () => (await call<Project>('project_get')).cameras[0].keyframes.length)
      .toBeGreaterThan(72);
    const followed = await call<Project>('project_get');
    const keys = followed.cameras[0].keyframes;
    expect(keys[0].time).toBe(2);
    expect(keys.at(-1)!.time).toBe(8);
    const middle = keys.find((key) => Math.abs(key.time - 5) < 1e-8)!;
    const marker = page.locator(
      `.timeline-diamond[data-clip-id="reverse-repeat"][data-keyframe-id="${middle.id}"]`,
    );
    await expect(marker).toHaveCount(1);
    expect(
      await marker.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left)),
    ).toBeCloseTo(62.5, 5);
    await marker.click();
    await expect(page.locator('.transport-time')).toContainText('00:02:12');
    await page.screenshot({ path: testInfo.outputPath('camera-time-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.getByRole('combobox', { name: '运镜主体', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('combobox', { name: '运镜主体', exact: true })).toHaveValue('handover-prop');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: testInfo.outputPath('camera-time-mobile.png') });
    const repeated = await call<CommandResponse>('camera_motion', {
      id: 'prop-camera',
      motion: 'follow',
      subjectId: 'handover-prop',
      sequenceId: followed.activeSequenceId,
      clipId: 'reverse-repeat',
      shotId: 'prop-shot',
      start: 2,
      end: 8,
      projectId: followed.id,
      expectedRevision: followed.revision,
    });
    expect(repeated.project.cameras[0].keyframes.map(({ id: _id, ...key }) => key)).toEqual(
      keys.map(({ id: _id, ...key }) => key),
    );
    await page.route('**/camera-time-render-test', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><body style="margin:0"><div id="stage" style="position:relative;width:1280px;height:720px"></div></body>',
      }),
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/camera-time-render-test');
    const evidence = await page.evaluate(async (project) => {
      const path = '/src/engine/SceneEngine.ts';
      const { SceneEngine } = await import(/* @vite-ignore */ path);
      const engine: SceneEngine = new SceneEngine(document.getElementById('stage')!, { interactive: false });
      engine.setView('camera');
      engine.setHelpers(false);
      await engine.setProject(project);
      const internal = engine as unknown as {
        objects: Map<string, BuiltObject>;
        shotCamera: PerspectiveCamera;
      };
      const samples = [1, 1.5, 2.5, 3.5, 1.5].map((time) => {
        engine.setTime(time);
        const root = internal.objects.get('handover-prop')!.root;
        const projected = root.getWorldPosition(root.position.clone()).project(internal.shotCamera);
        const canvas = document.querySelector('canvas')!;
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = copy.getContext('2d')!;
        context.drawImage(canvas, 0, 0);
        const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
        const colors = new Set<number>();
        for (let index = 0; index < pixels.length; index += 4)
          colors.add((pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2]);
        return { time, projected: projected.toArray(), colors: colors.size, png: engine.capture() };
      });
      engine.dispose();
      return samples;
    }, followed);
    for (const frame of evidence) {
      expect(Math.abs(frame.projected[0])).toBeLessThan(0.003);
      expect(Math.abs(frame.projected[1])).toBeLessThan(0.003);
      expect(frame.colors).toBeGreaterThan(30);
    }
    expect(evidence[1].png).toBe(evidence[4].png);
    expect(evidence[1].png).not.toBe(evidence[3].png);
    await writeFile(
      testInfo.outputPath('camera-time-render.png'),
      Buffer.from(evidence[2].png.split(',')[1], 'base64'),
    );
    await writeFile(
      testInfo.outputPath('camera-time-evidence.json'),
      JSON.stringify({ passed: true, samples: evidence.map(({ png: _png, ...sample }) => sample) }, null, 2),
    );
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});
