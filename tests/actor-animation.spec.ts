import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createObject } from '../shared/project';
import type { Project } from '../shared/types';

const runFile = promisify(execFile);

test('actor clips, full joint keys and CCD contacts share editable UI/MCP state and export real motion', async ({
  page,
  request,
}, testInfo) => {
  const directory = testInfo.outputPath('artifacts');
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'actor-ui-acceptance', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const journal: unknown[] = [];
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
    journal.push({ name, arguments: args, isError: result.isError ?? false });
    const text = (result.content as { type: string; text?: string }[]).find(
      (item) => item.type === 'text',
    )?.text;
    if (result.isError) throw new Error(`${name}: ${text}`);
    return text ? JSON.parse(text) : result;
  }
  async function number(label: string, value: number) {
    const input = page.getByRole('spinbutton', { name: label, exact: true });
    await input.fill(String(value));
    await input.press('Enter');
  }
  async function seek(time: number) {
    const ruler = page.locator('.timeline-ruler');
    const box = (await ruler.boundingBox())!;
    await ruler.click({ position: { x: (time / 8) * box.width, y: box.height / 2 } });
  }
  await mkdir(directory, { recursive: true });
  try {
    await client.connect(transport);
    const capabilities = await client.listTools();
    expect(capabilities.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['actor_clip_set', 'actor_constraint_set', 'actor_animation_set']),
    );
    const fresh: Project = await call('project_new', { name: 'Actor Animation QA', template: 'empty' });
    const actor = { ...createObject('actor', '动作角色'), id: 'qa-actor' };
    const floor = {
      ...createObject('plane', '地面'),
      id: 'qa-floor',
      position: [0, -0.05, 0],
      dimensions: [7, 0.05, 6],
    };
    const target = {
      ...createObject('sphere', '接触目标'),
      id: 'qa-target',
      position: [-0.4, 1.15, 0.32],
      dimensions: [0.07, 0.07, 0.07],
      tone: '#7f9591',
    };
    await call('edit_batch', {
      commands: [
        { type: 'project.settings', payload: { aspect: '16:9', fps: 24, resolution: 720 } },
        ...[actor, floor, target].map((object) => ({ type: 'object.create', payload: object })),
        {
          type: 'camera.create',
          payload: {
            id: 'qa-camera',
            name: '表演全景',
            position: [3.1, 2.2, 4.1],
            target: [0, 0.9, 0],
            fov: 35,
          },
        },
        {
          type: 'shot.create',
          payload: { id: 'qa-shot', name: '角色动作验收', cameraId: 'qa-camera', sourceIn: 0, sourceOut: 8 },
        },
        {
          type: 'sequence.update',
          payload: {
            id: fresh.activeSequenceId,
            patch: { clips: [{ id: 'qa-edit', shotId: 'qa-shot', sourceIn: 0, sourceOut: 8 }] },
          },
        },
      ],
    });
    await call('actor_animation_set', {
      id: actor.id,
      animation: {
        clips: [
          { id: 'qa-punch', action: 'punch', start: 0, end: 1.2, fadeIn: 0.1, fadeOut: 0.2 },
          { id: 'qa-block', action: 'block', start: 1, end: 2.4, fadeIn: 0.2, fadeOut: 0.2 },
          { id: 'qa-fall', action: 'fall', start: 2.2, end: 4.2, fadeIn: 0.2, fadeOut: 0.2 },
          { id: 'qa-getup', action: 'getup', start: 4, end: 6.3, fadeIn: 0.2, fadeOut: 0.2 },
          { id: 'qa-weapon', action: 'weapon', start: 6.1, end: 8, fadeIn: 0.2, fadeOut: 0.2 },
        ],
        constraints: [],
        jointKeys: [],
      },
    });
    await page.goto('/');
    await expect(page.locator('[data-testid="stage"] canvas')).toBeVisible();
    await page.locator('.tree-select').filter({ hasText: '动作角色' }).click();
    await expect(page.getByRole('textbox', { name: '对象名称', exact: true })).toHaveValue('动作角色');
    await expect(page.getByRole('combobox', { name: '动作片段', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: '动作片段', exact: true }).selectOption('qa-punch');
    await number('动作权重', 0.85);
    await page.getByRole('checkbox', { name: '镜像', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '镜像', exact: true })).toBeChecked();
    await expect
      .poll(
        async () =>
          (await call('project_get')).objects.find((item: { id: string }) => item.id === actor.id).actor
            .animation.clips[0],
      )
      .toMatchObject({ weight: 0.85, mirror: true });
    await page.getByRole('button', { name: '复制动作片段', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await call('project_get')).objects.find((item: { id: string }) => item.id === actor.id).actor
            .animation.clips.length,
      )
      .toBe(6);
    await page.getByRole('button', { name: '删除动作片段', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await call('project_get')).objects.find((item: { id: string }) => item.id === actor.id).actor
            .animation.clips.length,
      )
      .toBe(5);
    await page.getByRole('combobox', { name: '新关键帧关节', exact: true }).selectOption('head');
    await page.getByRole('button', { name: '添加关节关键帧', exact: true }).click();
    await number('关节偏转 Y', 12);
    await expect
      .poll(
        async () =>
          (await call('project_get')).objects.find((item: { id: string }) => item.id === actor.id).actor
            .animation.jointKeys[0].rotation[1],
      )
      .toBe(12);
    await page.getByRole('button', { name: '添加接触约束', exact: true }).click();
    await number('接触结束时间', 2);
    await page.getByRole('combobox', { name: '接触目标类型', exact: true }).selectOption('object');
    await page.getByRole('combobox', { name: '接触目标对象', exact: true }).selectOption('qa-target');
    await expect
      .poll(
        async () =>
          (await call('project_get')).objects.find((item: { id: string }) => item.id === actor.id).actor
            .animation.constraints[0].target.objectId,
      )
      .toBe('qa-target');
    await page.getByRole('button', { name: '摄影机', exact: true }).click();
    await seek(0.6);
    await page.getByRole('button', { name: '下一帧', exact: true }).click();
    await expect(page.getByText('已接触', { exact: true })).toBeVisible();
    await page.getByText('已接触', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${directory}/desktop-contact.png` });
    const before = await page.locator('[data-testid="stage"] canvas').screenshot();
    await seek(3.7);
    const fallen = await page.locator('[data-testid="stage"] canvas').screenshot();
    expect(createHash('sha256').update(before).digest('hex')).not.toBe(
      createHash('sha256').update(fallen).digest('hex'),
    );
    await page.screenshot({ path: `${directory}/desktop-fall.png` });
    const saved: Project = await call('project_get');
    await page.reload();
    await page.locator('.tree-select').filter({ hasText: '动作角色' }).click();
    await expect(page.getByRole('spinbutton', { name: '动作权重', exact: true })).toHaveValue('0.85');
    expect((await call('project_get')).objects).toEqual(saved.objects);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.getByRole('spinbutton', { name: '动作速度', exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${directory}/mobile-actions.png` });
    await page.getByRole('button', { name: '收起属性面板', exact: true }).click();
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await expect.poll(async () => page.locator('.transport-time').innerText()).not.toContain('00:00:00');
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    for (const at of [0.4, 3.7, 5.3, 6.7]) {
      const preview = await call('preview_capture', { shotId: 'qa-shot', time: at, width: 960, height: 540 });
      const image = preview.content.find((item: { type: string }) => item.type === 'image');
      expect(image?.data).toBeTruthy();
      await writeFile(`${directory}/pose-${at}.png`, Buffer.from(image.data, 'base64'));
    }
    const job = await call('render_start', {
      shotId: 'qa-shot',
      fps: 24,
      resolution: 720,
      aspect: '16:9',
      includeAudio: false,
    });
    await expect
      .poll(
        async () => {
          const status = await call('render_status', { id: job.id });
          if (status.status === 'failed') throw new Error(status.error);
          return status.status;
        },
        { timeout: 120_000, intervals: [1000, 2000, 4000] },
      )
      .toBe('completed');
    const completed = await call('render_status', { id: job.id });
    const video = await request.get(completed.downloadUrl);
    expect(video.ok()).toBeTruthy();
    const videoPath = `${directory}/actor-actions.mp4`;
    await writeFile(videoPath, await video.body());
    const probe = JSON.parse(
      (await runFile('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath]))
        .stdout,
    );
    const stream = probe.streams.find((item: { codec_type: string }) => item.codec_type === 'video');
    expect(stream).toMatchObject({
      codec_name: 'h264',
      width: 1280,
      height: 720,
      r_frame_rate: '24/1',
      nb_frames: '192',
    });
    expect(Number(probe.format.duration)).toBe(8);
    expect(errors).toEqual([]);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await writeFile(
      `${directory}/report.json`,
      JSON.stringify(
        {
          projectId: saved.id,
          revision: saved.revision,
          browserErrors: errors,
          ffprobe: probe,
          checks: [
            'MCP capability discovery',
            'UI clip editing/duplicate/delete',
            'full joint key editing',
            'object target CCD diagnostics',
            'UI/MCP shared state',
            'reload persistence',
            'desktop/mobile layout',
            'actual pose images',
            '8-second deterministic MP4',
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(`${directory}/project.json`, JSON.stringify(saved, null, 2));
  } finally {
    await writeFile(`${directory}/mcp-journal.json`, JSON.stringify(journal, null, 2));
    await client.close();
  }
});
