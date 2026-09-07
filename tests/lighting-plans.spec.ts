import { expect, test, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import type { Command, Project, RenderJob } from '../shared/types';

const run = promisify(execFile);
async function number(page: Page, name: string, value: number) {
  const field = page.getByRole('spinbutton', { name, exact: true });
  await field.fill(String(value));
  await field.press('Enter');
}

test('editable scene and shot lighting plans survive UI/MCP round trips and match real PNG/MP4 frames', async ({
  page,
  request,
}, testInfo) => {
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'lighting-browser', version: '1' });
  const errors: string[] = [];
  const uiCommands: Command[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST' && new URL(outgoing.url()).pathname === '/api/commands')
      uiCommands.push(...outgoing.postDataJSON().commands);
  });
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
    const initial = await call<Project>('project_new', { name: 'Lighting verification', template: 'empty' });
    await call('edit_batch', {
      commands: [
        { type: 'project.settings', payload: { aspect: '16:9', fps: 24 } },
        {
          type: 'object.create',
          payload: {
            id: 'subject',
            type: 'box',
            position: [0, 0.75, 0],
            dimensions: [1.5, 1.5, 1.5],
            keyframes: [
              { id: 'a', time: 0, rotation: [0, 0, 0] },
              { id: 'b', time: 3, rotation: [0, 80, 0] },
            ],
          },
        },
        {
          type: 'object.create',
          payload: { id: 'sphere', type: 'sphere', position: [-2, 0.7, 0], dimensions: [1.4, 1.4, 1.4] },
        },
        {
          type: 'camera.create',
          payload: {
            id: 'camera',
            name: 'Shared camera',
            position: [4, 3, 7],
            target: [-0.6, 0.6, 0],
            fov: 40,
          },
        },
        {
          type: 'shot.create',
          payload: { id: 'key-shot', name: '01 Side key', cameraId: 'camera', sourceIn: 0, sourceOut: 1.5 },
        },
        {
          type: 'shot.create',
          payload: { id: 'fill-shot', name: '02 Soft fill', cameraId: 'camera', sourceIn: 1.5, sourceOut: 3 },
        },
        {
          type: 'sequence.update',
          payload: {
            id: initial.activeSequenceId,
            patch: {
              clips: [
                { id: 'key-clip', shotId: 'key-shot', sourceIn: 0, sourceOut: 1.5 },
                { id: 'fill-clip', shotId: 'fill-shot', sourceIn: 1.5, sourceOut: 3 },
              ],
            },
          },
        },
      ],
    });
    await page.goto('/');
    await expect(page.locator('[data-testid="stage"] canvas')).toBeVisible();
    await page.getByRole('button', { name: '环境', exact: true }).click();
    await page.getByRole('button', { name: '新建布光方案', exact: true }).click();
    await expect.poll(async () => (await call<Project>('project_get')).lightingPlans?.length).toBe(1);
    const firstId = (await call<Project>('project_get')).lightingPlans![0].id;
    await expect(page.getByRole('combobox', { name: '编辑布光方案', exact: true })).toHaveValue(firstId);
    const name = page.getByRole('textbox', { name: '布光方案名称', exact: true });
    await name.fill('Side key');
    await name.press('Enter');
    await number(page, '布光主光强度', 4);
    await number(page, '布光环境光', 0.1);
    await number(page, '布光方位角', -110);
    await number(page, '布光高度角', 25);
    await page.getByRole('combobox', { name: '场景默认布光', exact: true }).selectOption(firstId);
    await page.getByRole('button', { name: '复制布光方案', exact: true }).click();
    await expect.poll(async () => (await call<Project>('project_get')).lightingPlans?.length).toBe(2);
    const secondId = (await call<Project>('project_get')).lightingPlans!.find(
      (plan) => plan.id !== firstId,
    )!.id;
    await expect(page.getByRole('combobox', { name: '编辑布光方案', exact: true })).toHaveValue(secondId);
    await name.fill('Soft fill');
    await name.press('Enter');
    await number(page, '布光主光强度', 0.25);
    await number(page, '布光环境光', 1.5);
    await page.getByRole('button', { name: '锁定布光方案', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: '布光主光强度', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '解锁布光方案', exact: true }).click();
    await page.locator('.shot-card').nth(1).click();
    await page.getByRole('combobox', { name: '镜头布光方案', exact: true }).selectOption(secondId);
    await expect
      .poll(async () => (await call<Project>('project_get')).shots[1].lightingPlanId)
      .toBe(secondId);
    await page.getByRole('combobox', { name: '镜头布光方案', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('lighting-shot-desktop.png') });
    await call('lighting_plan_update', { id: secondId, patch: { name: 'MCP soft fill' } });
    await expect(page.getByRole('combobox', { name: '镜头布光方案', exact: true })).toContainText(
      'MCP soft fill',
    );
    await call('shot_update', { id: 'fill-shot', patch: { locked: true } });
    await expect(page.getByRole('combobox', { name: '镜头布光方案', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '环境', exact: true }).click();
    await page.getByRole('combobox', { name: '编辑布光方案', exact: true }).selectOption(secondId);
    await expect(page.getByRole('spinbutton', { name: '布光主光强度', exact: true })).toBeDisabled();
    await expect(page.getByLabel('布光影响范围')).toContainText('1 个镜头');
    await call('shot_update', { id: 'fill-shot', patch: { locked: false } });
    await expect(page.getByRole('spinbutton', { name: '布光主光强度', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '复制布光方案', exact: true }).click();
    await expect.poll(async () => (await call<Project>('project_get')).lightingPlans?.length).toBe(3);
    await page.getByRole('button', { name: '删除布光方案', exact: true }).click();
    await expect.poll(async () => (await call<Project>('project_get')).lightingPlans?.length).toBe(2);
    await call('history_undo');
    await expect.poll(async () => (await call<Project>('project_get')).lightingPlans?.length).toBe(3);
    await call('history_redo');
    await page.reload();
    await page.getByRole('button', { name: '环境', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '场景默认布光', exact: true })).toHaveValue(firstId);
    await page.getByRole('combobox', { name: '编辑布光方案', exact: true }).selectOption(secondId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.getByRole('combobox', { name: '编辑布光方案', exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: testInfo.outputPath('lighting-plans-mobile.png') });
    await number(page, '布光环境光', 1.4);
    await expect
      .poll(
        async () =>
          (await call<Project>('project_get')).lightingPlans!.find((plan) => plan.id === secondId)!.lighting
            .ambient,
      )
      .toBe(1.4);
    await call('history_undo');
    await expect(page.getByRole('spinbutton', { name: '布光环境光', exact: true })).toHaveValue('1.5');
    await name.fill('Mobile candidate');
    await name.press('Enter');
    await expect
      .poll(
        async () =>
          (await call<Project>('project_get')).lightingPlans!.find((plan) => plan.id === secondId)!.name,
      )
      .toBe('Mobile candidate');
    await call('history_undo');
    await expect(name).toHaveValue('MCP soft fill');
    await page.getByRole('spinbutton', { name: '布光高度角', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('lighting-parameters-mobile.png') });
    const snapshot = await call<Project>('project_get');
    expect(snapshot.lightingPlans!.find((plan) => plan.id === firstId)!.lighting).toEqual({
      intensity: 4,
      ambient: 0.1,
      azimuth: -110,
      elevation: 25,
    });
    const imageResult = await client.callTool({
      name: 'preview_capture',
      arguments: { shotId: 'fill-shot', time: 0.5, width: 1280, height: 720 },
    });
    expect(imageResult.isError).not.toBe(true);
    const image = (imageResult.content as { type: string; data?: string }[]).find(
      (item) => item.type === 'image',
    )!;
    expect(image.data!.length).toBeGreaterThan(10000);
    await writeFile(testInfo.outputPath('mcp-lighting.png'), Buffer.from(image.data!, 'base64'));
    const render = await call<RenderJob>('render_start', {
      projectId: snapshot.id,
      expectedRevision: snapshot.revision,
      sequenceId: snapshot.activeSequenceId,
      aspect: '16:9',
      resolution: 720,
      fps: 24,
      includeAudio: false,
    });
    await call('lighting_plan_update', {
      id: firstId,
      patch: { lighting: { intensity: 0, ambient: 0.02, azimuth: 0, elevation: 0 } },
    });
    await expect
      .poll(
        async () => {
          const job = await call<RenderJob>('render_status', { id: render.id });
          if (job.status === 'failed') throw new Error(job.error);
          return job.status;
        },
        { timeout: 180000 },
      )
      .toBe('completed');
    const media = await request.get(`/api/renders/${render.id}/file`);
    expect(media.ok()).toBe(true);
    const videoPath = testInfo.outputPath('lighting-sequence.mp4');
    await writeFile(videoPath, await media.body());
    const probe = JSON.parse(
      (
        await run('ffprobe', [
          '-v',
          'error',
          '-count_frames',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          videoPath,
        ])
      ).stdout,
    );
    expect(probe.streams[0]).toMatchObject({
      codec_name: 'h264',
      width: 1280,
      height: 720,
      avg_frame_rate: '24/1',
      nb_read_frames: '72',
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?render=1');
    await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
    const samples = await page.evaluate(async (project) => {
      const bridge = window.__WHITEFRAME_RENDER__!;
      await bridge.load(project, 1280, 720);
      const frames = [];
      for (const time of [0.5, 1, 2, 2.5, 0.5]) frames.push({ time, png: await bridge.frame(time) });
      const image = new Image();
      image.src = frames[0].png;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, 1280, 720).data;
      const colors = new Set<number>();
      for (let i = 0; i < pixels.length; i += 4)
        colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
      const samePoseKey = await bridge.frame(0.5, { shotId: 'key-shot', sourceTime: 0.5 });
      const samePoseFill = await bridge.frame(0.5, { shotId: 'fill-shot', sourceTime: 0.5 });
      return { frames, colors: colors.size, samePoseKey, samePoseFill };
    }, snapshot);
    expect(samples.colors).toBeGreaterThan(100);
    expect(samples.frames[0].png).not.toBe(samples.frames[1].png);
    expect(samples.frames[0].png).toBe(samples.frames[4].png);
    expect(samples.samePoseKey).not.toBe(samples.samePoseFill);
    await writeFile(
      testInfo.outputPath('same-pose-key.png'),
      Buffer.from(samples.samePoseKey.split(',')[1], 'base64'),
    );
    await writeFile(
      testInfo.outputPath('same-pose-fill.png'),
      Buffer.from(samples.samePoseFill.split(',')[1], 'base64'),
    );
    expect(samples.frames[2].png.split(',')[1]).toBe(image.data);
    const comparisons = [];
    for (const sample of samples.frames.slice(0, 4)) {
      const frame = Math.round(sample.time * 24);
      const expectedPath = testInfo.outputPath(`frame-${frame}-expected.png`);
      const decodedPath = testInfo.outputPath(`frame-${frame}-decoded.png`);
      await writeFile(expectedPath, Buffer.from(sample.png.split(',')[1], 'base64'));
      await run('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-i',
        videoPath,
        '-vf',
        `select=eq(n\\,${frame})`,
        '-frames:v',
        '1',
        decodedPath,
      ]);
      const result = await run('ffmpeg', [
        '-v',
        'info',
        '-i',
        expectedPath,
        '-i',
        decodedPath,
        '-lavfi',
        'ssim',
        '-f',
        'null',
        '-',
      ]);
      const ssim = Number(/All:([\d.]+)/.exec(result.stderr)?.[1]);
      expect(ssim).toBeGreaterThan(0.98);
      comparisons.push({ frame, ssim });
    }
    expect(errors).toEqual([]);
    for (const type of [
      'lighting.plan.create',
      'lighting.plan.update',
      'lighting.plan.duplicate',
      'lighting.plan.delete',
      'lighting.scene.bind',
      'lighting.shot.bind',
    ])
      expect(uiCommands.some((command) => command.type === type)).toBe(true);
    await writeFile(
      testInfo.outputPath('verification.json'),
      JSON.stringify(
        {
          projectId: snapshot.id,
          revision: snapshot.revision,
          render,
          probe,
          colors: samples.colors,
          comparisons,
          uiCommands,
          errors,
        },
        null,
        2,
      ),
    );
    await writeFile(testInfo.outputPath('project.json'), JSON.stringify(snapshot, null, 2));
  } finally {
    await client.close();
  }
});
