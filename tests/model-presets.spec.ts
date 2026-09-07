import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CommandResponse, Project, RenderJob } from '../shared/types';
import type { ModelCatalog } from '../shared/model-catalog';
import { skinnedModelAsset } from './fixtures/skinned-model';

const run = promisify(execFile);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
test('imported rig animation and scale-aware presets connect manual UI, official MCP, reload and real video', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240000);
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'model-preset-acceptance', version: '1.0' });
  const errors: string[] = [];
  const journal: unknown[] = [];
  const pixelChecks: unknown[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    journal.push({ name, arguments: args, error: result.isError ?? false });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return JSON.parse(
      (result.content as { type: string; text?: string }[]).find((item) => item.type === 'text')!.text!,
    ) as T;
  };
  const read = async () => (await (await request.get('/api/project')).json()) as Project;
  const mutate = async (action: () => Promise<unknown>) => {
    const response = page.waitForResponse(
      (event) => event.request().method() === 'POST' && new URL(event.url()).pathname === '/api/commands',
    );
    await action();
    const result = await response;
    expect(result.ok(), await result.text()).toBe(true);
    return (await result.json()) as CommandResponse;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    await call('project_new', { name: `模型与摄影机 ${Date.now()}`, template: 'empty' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: '资产', exact: true }).click();
    const modelBytes = await skinnedModelAsset(true);
    await mutate(() =>
      page
        .locator('input[accept=".glb,.gltf"]')
        .setInputFiles({ name: 'Rig-performer.glb', mimeType: 'model/gltf-binary', buffer: modelBytes }),
    );
    await expect(page.getByRole('combobox', { name: '内嵌动画', exact: true })).toHaveValue('0');
    let project = await read();
    const model = project.objects[0];
    const catalog = await call<ModelCatalog>('model_catalog', { objectId: model.id, projectId: project.id });
    expect(catalog.skins[0].joints).toHaveLength(2);
    expect(catalog.animations.map((animation) => animation.name)).toEqual(['Sway left', 'Sway right']);
    await page.getByText('Two joint rig · 2 关节', { exact: true }).click();
    await expect(page.getByText('Upper body', { exact: true })).toBeVisible();
    await mutate(() => page.getByRole('combobox', { name: '内嵌动画', exact: true }).selectOption('1'));
    await page.screenshot({ path: testInfo.outputPath('model-directory-desktop.png') });
    await call('edit_batch', {
      commands: [
        {
          type: 'project.settings',
          payload: {
            aspect: '16:9',
            fps: 24,
            resolution: 720,
            environment: { ground: false, background: '#182c38', groundTone: '#cccccc' },
          },
        },
        { type: 'object.update', payload: { id: model.id, patch: { dimensions: [1, 1.8, 1] } } },
        {
          type: 'camera.create',
          payload: {
            id: 'model-camera',
            name: '模型摄影机',
            position: [0, 1, 4],
            target: [0, 1, 0],
            fov: 44,
          },
        },
        {
          type: 'shot.create',
          payload: {
            id: 'model-shot',
            name: '内嵌骨架表演',
            cameraId: 'model-camera',
            sourceIn: 0,
            sourceOut: 2,
            subjectIds: [model.id],
          },
        },
      ],
    });
    const preview = async (name: string, time = 1) => {
      const result = await client.callTool(
        { name: 'preview_capture', arguments: { shotId: 'model-shot', time, width: 1280, height: 720 } },
        undefined,
        { timeout: 120000 },
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const png = (result.content as { type: string; data?: string }[]).find(
        (item) => item.type === 'image',
      )!;
      const bytes = Buffer.from(png.data!, 'base64');
      await writeFile(testInfo.outputPath(name), bytes);
      const pixels = await page.evaluate(async (data) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let bright = 0;
        for (let index = 0; index < rgba.length; index += 4)
          if (rgba[index] > 140 && rgba[index + 1] > 140 && rgba[index + 2] > 140) bright++;
        bitmap.close();
        return { width: canvas.width, height: canvas.height, bright };
      }, png.data!);
      expect(pixels.bright).toBeGreaterThan(1000);
      expect(pixels.bright).toBeLessThan(pixels.width * pixels.height * 0.8);
      pixelChecks.push({ name, ...pixels });
      return bytes;
    };
    const right = await preview('model-right.png');
    await call('model_animation_set', { id: model.id, animationIndex: 0 });
    const left = await preview('model-left.png');
    expect(hash(left)).not.toBe(hash(right));
    await call('model_animation_set', { id: model.id, animationIndex: null });
    const rest = await preview('model-static.png');
    expect(hash(rest)).not.toBe(hash(left));
    expect(hash(rest)).not.toBe(hash(right));
    await call('history_undo');
    expect(hash(await preview('model-undo.png'))).toBe(hash(left));
    await page.reload();
    await page.getByRole('button', { name: 'Rig-performer', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '内嵌动画', exact: true })).toHaveValue('0');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await mutate(() => page.getByRole('combobox', { name: '内嵌动画', exact: true }).selectOption('1'));
    await page.screenshot({ path: testInfo.outputPath('model-directory-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    project = await read();
    const job = await call<RenderJob>('render_start', {
      shotId: 'model-shot',
      projectId: project.id,
      expectedRevision: project.revision,
      fps: 24,
      resolution: 720,
      aspect: '16:9',
      burnIn: false,
      includeAudio: false,
    });
    await expect
      .poll(
        async () => {
          const state = await call<RenderJob>('render_status', { id: job.id });
          if (state.status === 'failed') throw new Error(state.error);
          return state.status;
        },
        { timeout: 120000 },
      )
      .toBe('completed');
    const video = testInfo.outputPath('imported-skeleton.mp4');
    await writeFile(video, await (await request.get(`/api/renders/${job.id}/file`)).body());
    const probe = JSON.parse(
      (
        await run('ffprobe', [
          '-v',
          'error',
          '-count_frames',
          '-show_entries',
          'stream=width,height,avg_frame_rate,nb_read_frames',
          '-of',
          'json',
          video,
        ])
      ).stdout,
    );
    expect(probe.streams[0]).toMatchObject({
      width: 1280,
      height: 720,
      avg_frame_rate: '24/1',
      nb_read_frames: '48',
    });
    const comparison = await run('ffmpeg', [
      '-v',
      'info',
      '-i',
      video,
      '-i',
      testInfo.outputPath('model-right.png'),
      '-filter_complex',
      '[0:v]select=eq(n\\,24),setpts=PTS-STARTPTS[a];[a][1:v]ssim',
      '-an',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ]);
    const ssim = Number(comparison.stderr.match(/All:([\d.]+)/)?.[1]);
    expect(ssim).toBeGreaterThan(0.995);
    await writeFile(
      testInfo.outputPath('model-verification.json'),
      JSON.stringify({ catalog, jobId: job.id, probe, ssim, journal }, null, 2),
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: '导出视频', exact: true }).click();
    const record = page.locator('.render-job').filter({ has: page.locator(`a[href*="${job.id}"]`) });
    await record.getByRole('button', { name: '播放视频', exact: true }).click();
    const player = page.getByLabel('已导出白模视频', { exact: true });
    await expect
      .poll(() => player.evaluate((element: HTMLVideoElement) => element.readyState))
      .toBeGreaterThanOrEqual(3);
    await player.evaluate(async (element: HTMLVideoElement) => {
      element.currentTime = 0;
      await element.play();
    });
    await expect
      .poll(() => player.evaluate((element: HTMLVideoElement) => element.ended), { timeout: 10000 })
      .toBe(true);
    await player.evaluate((element: HTMLVideoElement) => {
      element.currentTime = 1;
    });
    await page.screenshot({ path: testInfo.outputPath('imported-skeleton-video-playback.png') });
    await page.goto('/');
    await call('edit_batch', {
      commands: [
        {
          type: 'object.create',
          payload: {
            id: 'landmark',
            name: '160米地标',
            type: 'box',
            dimensions: [80, 160, 60],
            position: [300, 0, -80],
          },
        },
        { type: 'shot.update', payload: { id: 'model-shot', patch: { subjectIds: ['landmark'] } } },
      ],
    });
    await page.getByRole('button', { name: '模型摄影机', exact: true }).click();
    const applied = await mutate(() => page.getByRole('button', { name: '全景', exact: true }).click());
    const camera = applied.project.cameras.find((item) => item.id === 'model-camera')!;
    expect(camera.target).toEqual([300, 80, -80]);
    await page.getByRole('button', { name: '全景', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('landmark-preset-desktop.png') });
    await preview('landmark-wide.png', 0);
    await call('camera_preset', { id: 'model-camera', shotId: 'model-shot', preset: 'wide', aspect: '9:16' });
    const portrait = await read();
    expect(portrait.cameras.find((item) => item.id === 'model-camera')!.compositions!['9:16']).toBeTruthy();
    await call('edit_batch', {
      commands: [
        {
          type: 'object.create',
          payload: { id: 'one', name: '前景人物', type: 'actor', position: [-1, 0, 0] },
        },
        {
          type: 'object.create',
          payload: { id: 'two', name: '后景人物', type: 'actor', position: [1, 0, 2] },
        },
        { type: 'object.update', payload: { id: model.id, patch: { visible: false } } },
        { type: 'shot.update', payload: { id: 'model-shot', patch: { subjectIds: ['one', 'two'] } } },
      ],
    });
    await mutate(() => page.getByRole('button', { name: '双人', exact: true }).click());
    await preview('two-shot.png', 0);
    await mutate(() => page.getByRole('button', { name: '过肩', exact: true }).click());
    await preview('over-shoulder.png', 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.getByRole('button', { name: '过肩', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('camera-presets-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors).toEqual([]);
    await writeFile(testInfo.outputPath('final-project.json'), JSON.stringify(await read(), null, 2));
    await writeFile(testInfo.outputPath('pixel-checks.json'), JSON.stringify(pixelChecks, null, 2));
  } finally {
    await client.close();
  }
});
