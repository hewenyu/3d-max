import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CommandResponse, Project } from '../shared/types';

test('modifier stack UI and MCP share editable source, render changes, mobile controls and undo', async ({
  page,
  request,
}, testInfo) => {
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'modifier-browser', version: '1' });
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
    const project = await call<Project>('project_new', { name: '修改器验收' });
    await call('edit_batch', {
      projectId: project.id,
      expectedRevision: project.revision,
      commands: [
        { type: 'project.settings', payload: { aspect: '16:9' } },
        {
          type: 'object.create',
          payload: { id: 'box', type: 'box', name: '阵列构件', dimensions: [2, 2, 2] },
        },
        {
          type: 'object.keyframe.set',
          payload: { id: 'box', keyframe: { id: 'start', time: 0, position: [0, 0, 0] } },
        },
        {
          type: 'object.keyframe.set',
          payload: { id: 'box', keyframe: { id: 'end', time: 3, position: [0, 1, 0] } },
        },
        { type: 'camera.create', payload: { id: 'camera', position: [9, 7, 12], target: [3, 1, 0] } },
        { type: 'shot.create', payload: { id: 'shot', cameraId: 'camera', sourceIn: 0, sourceOut: 3 } },
        {
          type: 'sequence.update',
          payload: {
            id: project.activeSequenceId,
            patch: { clips: [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 3 }] },
          },
        },
      ],
    });
    await page.goto('/');
    await page.getByRole('button', { name: '阵列构件', exact: true }).click();
    await page.getByRole('combobox', { name: '新增修改器类型', exact: true }).selectOption('array');
    await page.getByRole('button', { name: '添加修改器', exact: true }).click();
    const count = page.getByRole('spinbutton', { name: '修改器 1 数量', exact: true });
    await expect(count).toHaveValue('2');
    await count.fill('3');
    await count.press('Enter');
    await expect
      .poll(async () => {
        const current = await call<Project>('project_get');
        const stack = current.objects[0].modeling;
        return stack?.kind === 'stack' && stack.modifiers[0].type === 'array' ? stack.modifiers[0].count : 0;
      })
      .toBe(3);
    let current = await call<Project>('project_get');
    const added = await call<CommandResponse>('modifier_add', {
      id: 'box',
      modifier: { id: 'smooth', type: 'subdivision', iterations: 1 },
      projectId: current.id,
      expectedRevision: current.revision,
    });
    await expect(page.getByRole('spinbutton', { name: '修改器 2 细分级别', exact: true })).toHaveValue('1');
    await page.getByRole('button', { name: '上移修改器 2', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: '修改器 1 细分级别', exact: true })).toHaveValue('1');
    await page.getByRole('button', { name: '摄影机', exact: true }).click();
    const canvas = page.locator('[data-testid="stage"] canvas');
    await expect(canvas).toBeVisible();
    await page.locator('.modifier-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('modifiers-desktop.png') });
    const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await expect
      .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL()))
      .not.toBe(before);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.locator('.modifier-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('modifiers-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.getByRole('checkbox', { name: '启用修改器 1', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '启用修改器 1', exact: true })).not.toBeChecked();
    current = await call<Project>('project_get');
    expect(current.objects[0].modeling!.kind).toBe('stack');
    await page.getByRole('button', { name: '烘焙修改器', exact: true }).click();
    await expect(page.getByRole('button', { name: '烘焙修改器', exact: true })).toHaveCount(0);
    current = await call<Project>('project_get');
    expect(current.objects[0].modeling!.kind).toBe('mesh');
    await call('history_undo', { projectId: current.id, expectedRevision: current.revision });
    await expect(page.getByRole('button', { name: '烘焙修改器', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    current = await call<Project>('project_get');
    expect(current.objects[0].modeling!.kind).toBe('stack');
    expect(current.id).toBe(added.project.id);
    const preview = await client.callTool({
      name: 'preview_capture',
      arguments: { shotId: 'shot', time: 1, width: 720, height: 405 },
    });
    expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
    const image = (preview.content as { type: string; data?: string }[]).find(
      (item) => item.type === 'image',
    );
    expect(image?.data?.length).toBeGreaterThan(10000);
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});
