import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { attachedCameraFixture } from './fixtures/camera-prop';
import type { CommandResponse, Project } from '../shared/types';
import type { SceneEngine } from '../src/engine/SceneEngine';
import type { BuiltObject } from '../src/engine/ObjectFactory';
import type { PerspectiveCamera } from 'three';

declare global {
  interface Window {
    propCameraTest: SceneEngine;
  }
}

test('attached prop follow works through UI and MCP and targets actual renderer bones through a handover', async ({
  page,
  request,
}, testInfo) => {
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'attached-camera-browser', version: '1' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return JSON.parse(
      (result.content as { type: string; text?: string }[]).find((item) => item.type === 'text')!.text!,
    ) as T;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    await call('project_import', { project: attachedCameraFixture() });
    await page.goto('/');
    await expect(page.locator('[data-testid="stage"] canvas')).toBeVisible();
    await page.getByRole('combobox', { name: '运动方式', exact: true }).selectOption('follow');
    await page.getByRole('combobox', { name: '运镜主体', exact: true }).selectOption('handover-prop');
    await page.getByRole('button', { name: '生成运镜关键帧', exact: true }).click();
    await expect.poll(async () => (await call<Project>('project_get')).cameras[0].keyframes.length).toBe(74);
    const followed = await call<Project>('project_get');
    await page.getByRole('button', { name: '摄影机', exact: true }).click();
    await page.getByRole('combobox', { name: '运镜主体', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('prop-follow-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.getByRole('combobox', { name: '运镜主体', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('combobox', { name: '运镜主体', exact: true })).toHaveValue('handover-prop');
    await page.screenshot({ path: testInfo.outputPath('prop-follow-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const mounted = await call<CommandResponse>('camera_motion', {
      id: 'prop-camera',
      motion: 'follow',
      subjectId: 'handover-prop',
      start: 0,
      end: 3,
      rotateWithSubject: true,
      projectId: followed.id,
      expectedRevision: followed.revision,
    });
    expect(mounted.project.cameras[0].keyframes.at(-1)!.position).not.toEqual(
      followed.cameras[0].keyframes.at(-1)!.position,
    );
    const undone = await call<Project>('history_undo', {
      projectId: followed.id,
      expectedRevision: mounted.project.revision,
    });
    expect(undone.cameras[0].keyframes).toEqual(followed.cameras[0].keyframes);
    const previewHashes: string[] = [];
    for (const time of [0.5, 2.5]) {
      const result = await client.callTool({
        name: 'preview_capture',
        arguments: { shotId: 'prop-shot', time, width: 1280, height: 720 },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const image = (result.content as { type: string; data?: string }[]).find(
        (item) => item.type === 'image',
      )!;
      const bytes = Buffer.from(image.data!, 'base64');
      await writeFile(testInfo.outputPath(`prop-follow-mcp-${time}.png`), bytes);
      previewHashes.push(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(previewHashes[0]).not.toBe(previewHashes[1]);
    await page.route('**/prop-camera-render-test', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><body style="margin:0"><div id="stage" style="position:relative;width:1280px;height:720px"></div></body>',
      }),
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/prop-camera-render-test');
    const evidence = await page.evaluate(async (project) => {
      const path = '/src/engine/SceneEngine.ts';
      const { SceneEngine } = await import(/* @vite-ignore */ path);
      const engine = new SceneEngine(document.getElementById('stage')!, { interactive: false });
      window.propCameraTest = engine;
      engine.setView('camera');
      engine.setHelpers(false);
      await engine.setProject(project);
      const internal = engine as unknown as {
        objects: Map<string, BuiltObject>;
        shotCamera: PerspectiveCamera;
      };
      return [0, 0.5, 1.49, 1.5, 2.5, 0.5].map((time) => {
        engine.setTime(time);
        const root = internal.objects.get('handover-prop')!.root;
        const position = root.getWorldPosition(root.position.clone());
        const projected = position.clone().project(internal.shotCamera);
        const canvas = document.querySelector('canvas')!;
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = copy.getContext('2d')!;
        context.drawImage(canvas, 0, 0);
        const data = context.getImageData(0, 0, copy.width, copy.height).data;
        const colors = new Set<number>();
        for (let i = 0; i < data.length; i += 4)
          colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        return {
          time,
          position: position.toArray(),
          projected: projected.toArray(),
          colors: colors.size,
          png: engine.capture(),
          contact: engine.getConstraintResults(time < 1.5 ? 'giver' : 'receiver')[0],
        };
      });
    }, followed);
    for (const frame of evidence) {
      expect(Math.abs(frame.projected[0])).toBeLessThan(0.003);
      expect(Math.abs(frame.projected[1])).toBeLessThan(0.003);
      expect(frame.colors).toBeGreaterThan(30);
      expect(frame.contact.reached).toBe(true);
    }
    expect(evidence[1].png).toBe(evidence[5].png);
    expect(evidence[1].png).not.toBe(evidence[4].png);
    await page.screenshot({ path: testInfo.outputPath('prop-follow-render.png') });
    await writeFile(
      testInfo.outputPath('prop-follow-evidence.json'),
      JSON.stringify(
        { previewHashes, samples: evidence.map(({ png: _png, ...frame }) => frame), passed: true },
        null,
        2,
      ),
    );
    await page.evaluate(() => window.propCameraTest.dispose());
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});
