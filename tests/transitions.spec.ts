import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Project, RenderJob } from '../shared/types';
import { transitionFixture } from './fixtures/transitions';

const run = promisify(execFile);

test('compact transition editor keeps actual dissolve controls inside 320px and 390px screens', async ({
  page,
  request,
}, testInfo) => {
  const imported = await request.post('/api/project/import', { data: transitionFixture() });
  expect(imported.ok()).toBe(true);
  await page.goto('/');
  await page.locator('.shot-card').nth(1).click();
  await page.getByRole('button', { name: '画面转场', exact: true }).click();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('spinbutton', { name: '交叉溶解时长', exact: true })).toHaveValue('1');
    await expect(page.getByRole('button', { name: '应用', exact: true })).toBeEnabled();
    const bounds = await page.locator('.transition-panel').evaluate((element) => ({
      width: element.clientWidth,
      content: element.scrollWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(bounds.document).toBe(width);
    expect(bounds.content).toBeLessThanOrEqual(bounds.width);
    await page.screenshot({ path: testInfo.outputPath(`transition-editor-${width}.png`) });
  }
});

test('real moving scene dissolves and fades match shared preview/export pixels including depth of field', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?render=1');
  await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
  const result = await page.evaluate(async (project) => {
    const bridge = window.__WHITEFRAME_RENDER__!;
    await bridge.load(project, 1280, 720);
    const pixels = () => {
      const copy = document.createElement('canvas');
      copy.width = 1280;
      copy.height = 720;
      const context = copy.getContext('2d')!;
      context.drawImage(document.querySelector('canvas')!, 0, 0);
      return context.getImageData(0, 0, 1280, 720).data;
    };
    await bridge.frame(0, { shotId: 'shot-1', sourceTime: 5 });
    const outgoing = pixels();
    await bridge.frame(0, { shotId: 'shot-2', sourceTime: 1 });
    const incoming = pixels();
    const middlePng = await bridge.frame(4);
    const middle = pixels();
    let blendError = 0;
    let black = 0;
    let contrast = 0;
    for (let index = 0; index < middle.length; index += 4) {
      for (let channel = 0; channel < 3; channel++)
        blendError = Math.max(
          blendError,
          Math.abs(middle[index + channel] - (outgoing[index + channel] + incoming[index + channel]) / 2),
        );
      contrast += Math.abs(outgoing[index] - incoming[index]);
    }
    await bridge.frame(0);
    for (const value of pixels().filter((_, index) => index % 4 !== 3)) black = Math.max(black, value);
    const laterPng = await bridge.frame(4.25);
    const repeat = await bridge.frame(4);
    await bridge.frame(0, { shotId: 'shot-1', sourceTime: 1.5 });
    const full = pixels();
    await bridge.frame(0.5);
    const half = pixels();
    let fadeError = 0;
    for (let index = 0; index < half.length; index++)
      if (index % 4 !== 3) fadeError = Math.max(fadeError, Math.abs(half[index] - full[index] / 2));
    const path = '/src/engine/SceneEngine.ts';
    const { SceneEngine } = await import(/* @vite-ignore */ path);
    const preview = document.createElement('div');
    preview.style.cssText = 'position:absolute;inset:0;width:1280px;height:720px';
    document.body.append(preview);
    const engine = new SceneEngine(preview, { interactive: false });
    engine.setHelpers(false);
    engine.setView('camera');
    await engine.setProject(project);
    engine.setTime(4);
    const previewPng = engine.capture();
    engine.resize(390, 690);
    engine.setTime(4);
    const mobilePng = engine.capture();
    engine.dispose();
    await bridge.frame(4);
    return { blendError, contrast, black, fadeError, middlePng, laterPng, repeat, previewPng, mobilePng };
  }, transitionFixture());
  expect(result.contrast).toBeGreaterThan(1_000_000);
  expect(result.blendError).toBeLessThanOrEqual(1);
  expect(result.fadeError).toBeLessThanOrEqual(1);
  expect(result.black).toBe(0);
  expect(result.middlePng).not.toBe(result.laterPng);
  expect(result.middlePng).toBe(result.repeat);
  expect(result.middlePng).toBe(result.previewPng);
  await writeFile(
    testInfo.outputPath('dissolve-mobile.png'),
    Buffer.from(result.mobilePng.split(',')[1], 'base64'),
  );
  await page.screenshot({ path: testInfo.outputPath('dissolve-desktop.png') });
  expect(errors).toEqual([]);
});

test('desktop/mobile editing, real MCP undo and actual MP4 preserve visual transitions', async ({
  page,
  request,
}, testInfo) => {
  const imported = await request.post('/api/project/import', { data: transitionFixture() });
  expect(imported.ok(), await imported.text()).toBe(true);
  let project = (await imported.json()) as Project;
  const read = async () => (await (await request.get('/api/project')).json()) as Project;
  await page.goto('/');
  await page.getByRole('button', { name: '画面转场', exact: true }).click();
  const input = page.getByRole('spinbutton', { name: '画面淡入时长', exact: true });
  await input.fill('0.75');
  await input.press('Tab');
  await page.getByRole('button', { name: '应用', exact: true }).click();
  await expect.poll(async () => (await read()).sequences[0].clips[0].fadeIn).toBe(0.75);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '画面转场', exact: true }).click();
  await expect(input).toHaveValue('0.75');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('transition-editor-mobile.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'transition-verification', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  try {
    expect((await client.listTools()).tools.some((tool) => tool.name === 'clip_transition')).toBe(true);
    project = await read();
    const edit = await client.callTool({
      name: 'clip_transition',
      arguments: {
        projectId: project.id,
        expectedRevision: project.revision,
        sequenceId: project.activeSequenceId,
        clipId: 'clip-2',
        transitionIn: { type: 'dissolve', duration: 0.8 },
      },
    });
    expect(edit.isError, JSON.stringify(edit)).not.toBe(true);
    project = await read();
    expect(project.sequences[0].clips[1].transitionIn?.duration).toBe(0.8);
    const undo = await client.callTool({
      name: 'history_undo',
      arguments: { projectId: project.id, expectedRevision: project.revision },
    });
    expect(undo.isError).not.toBe(true);
    project = await read();
    expect(project.sequences[0].clips[1].transitionIn?.duration).toBe(1);
    const started = await client.callTool({
      name: 'render_start',
      arguments: {
        projectId: project.id,
        expectedRevision: project.revision,
        fps: 24,
        resolution: 720,
        aspect: '16:9',
        burnIn: false,
        includeAudio: false,
      },
    });
    expect(started.isError, JSON.stringify(started)).not.toBe(true);
    const job = JSON.parse(
      (started.content as { type: string; text?: string }[]).find((item) => item.type === 'text')!.text!,
    ) as RenderJob;
    await expect
      .poll(
        async () => {
          const current = (await (await request.get(`/api/renders/${job.id}`)).json()) as RenderJob;
          if (current.status === 'failed') throw new Error(current.error);
          return current.status;
        },
        { timeout: 120000 },
      )
      .toBe('completed');
    const path = testInfo.outputPath('visual-transitions.mp4');
    await writeFile(path, await (await request.get(`/api/renders/${job.id}/file`)).body());
    const probe = JSON.parse(
      (
        await run('ffprobe', [
          '-v',
          'error',
          '-count_frames',
          '-show_entries',
          'format=duration:stream=width,height,avg_frame_rate,nb_read_frames',
          '-of',
          'json',
          path,
        ])
      ).stdout,
    );
    expect(probe.streams[0]).toMatchObject({
      width: 1280,
      height: 720,
      avg_frame_rate: '24/1',
      nb_read_frames: '192',
    });
    expect(Number(probe.format.duration)).toBe(8);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?render=1');
    await page.waitForFunction(() => Boolean(window.__WHITEFRAME_RENDER__));
    const png = await page.evaluate(async (project) => {
      await window.__WHITEFRAME_RENDER__!.load(project, 1280, 720);
      return window.__WHITEFRAME_RENDER__!.frame(4);
    }, project);
    const reference = testInfo.outputPath('dissolve-reference.png');
    await writeFile(reference, Buffer.from(png.split(',')[1], 'base64'));
    const comparison = await run('ffmpeg', [
      '-v',
      'info',
      '-i',
      path,
      '-i',
      reference,
      '-filter_complex',
      '[0:v]select=eq(n\\,96),setpts=PTS-STARTPTS[a];[a][1:v]ssim',
      '-an',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ]);
    const similarity = Number(comparison.stderr.match(/All:([\d.]+)/)?.[1]);
    expect(similarity).toBeGreaterThan(0.995);
    await writeFile(
      testInfo.outputPath('verification.json'),
      JSON.stringify({ jobId: job.id, projectId: project.id, media: probe, ssim: similarity }, null, 2),
    );
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
      element.playbackRate = 1;
      await element.play();
    });
    await expect
      .poll(() => player.evaluate((element: HTMLVideoElement) => element.ended), { timeout: 15000 })
      .toBe(true);
    await player.evaluate((element: HTMLVideoElement) => {
      element.currentTime = 4;
    });
    await page.screenshot({ path: testInfo.outputPath('transition-video-playback.png') });
  } finally {
    await client.close();
  }
});
