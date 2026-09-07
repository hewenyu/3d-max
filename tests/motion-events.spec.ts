import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { attachedCameraFixture } from './fixtures/camera-prop';
import type { CommandResponse, Project } from '../shared/types';
import { writeFile } from 'node:fs/promises';

test('event UI creates, edits, synchronizes and deletes records through the same reversible MCP commands', async ({
  page,
  request,
}, testInfo) => {
  const client = new Client({ name: 'motion-events-browser', version: '1' });
  const connection = await (await request.get('/api/connection')).json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return JSON.parse(
      (result.content as { type: string; text?: string }[]).find((item) => item.type === 'text')!.text!,
    ) as T;
  };
  const read = () => call<Project>('project_get');
  const event = async () =>
    (await read()).objects.find((item) => item.id === 'handover-prop')!.motionEvents![0];
  const number = async (name: string, value: string) => {
    const field = page.getByRole('spinbutton', { name, exact: true });
    await field.fill(value);
    await field.press('Enter');
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    await call('project_import', { project: attachedCameraFixture() });
    await page.goto('/');
    await page.getByRole('button', { name: '交接手机', exact: true }).click();
    await page.locator('summary').filter({ hasText: '路径与载具' }).click();
    await page.getByRole('button', { name: '添加运动事件', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '事件类型', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: '事件类型', exact: true }).selectOption('explosion');
    await number('事件源时间', '1');
    await number('事件时长', '0.8');
    await number('事件强度', '45');
    await number('事件世界位置 X', '2.5');
    await page.getByRole('combobox', { name: '事件关联目标', exact: true }).selectOption('receiver');
    await expect.poll(event).toMatchObject({
      time: 1,
      kind: 'explosion',
      duration: 0.8,
      strength: 45,
      otherId: 'receiver',
      position: [2.5, 0, 0],
    });
    await page.getByRole('group', { name: '运动事件', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('motion-events-desktop.png') });
    let current = await read();
    let selected = await event();
    await call('motion_events_set', {
      id: 'handover-prop',
      events: [{ ...selected, kind: 'projectile', strength: 72 }],
      projectId: current.id,
      expectedRevision: current.revision,
    });
    await expect(page.getByRole('combobox', { name: '事件类型', exact: true })).toHaveValue('projectile');
    await expect(page.getByRole('spinbutton', { name: '事件强度', exact: true })).toHaveValue('72');
    current = await read();
    selected = await event();
    await call('sync_group_set', {
      group: {
        id: 'event-sync',
        name: '交接同步',
        members: [
          { kind: 'motion-event', objectId: 'handover-prop', id: selected.id },
          { kind: 'keyframe', objectId: 'handover-prop', id: 'handover' },
        ],
      },
      projectId: current.id,
      expectedRevision: current.revision,
    });
    await number('事件源时间', '1.5');
    await expect
      .poll(async () => (await read()).objects.find((item) => item.id === 'handover-prop')!.keyframes[0].time)
      .toBe(2);
    current = await read();
    const locked = await call<CommandResponse>('sync_group_set', {
      group: { ...current.synchronization![0], locked: true },
      projectId: current.id,
      expectedRevision: current.revision,
    });
    await expect(page.getByRole('spinbutton', { name: '事件源时间', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '删除运动事件', exact: true })).toBeDisabled();
    await call('sync_group_set', {
      group: { ...locked.project.synchronization![0], locked: false },
      projectId: current.id,
      expectedRevision: locked.project.revision,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.getByRole('group', { name: '运动事件', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('motion-events-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    current = await read();
    await page.getByRole('button', { name: '删除运动事件', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '事件类型', exact: true })).toHaveCount(0);
    const deleted = await read();
    expect(deleted.synchronization).toEqual([]);
    expect(deleted.objects.find((item) => item.id === 'handover-prop')!.motionEvents).toEqual([]);
    await call('history_undo', { projectId: current.id, expectedRevision: deleted.revision });
    await expect(page.getByRole('combobox', { name: '事件类型', exact: true })).toHaveValue('projectile');
    expect((await read()).synchronization).toEqual(current.synchronization);
    current = await read();
    const objectLocked = await call<CommandResponse>('object_update', {
      id: 'handover-prop',
      patch: { locked: true },
      projectId: current.id,
      expectedRevision: current.revision,
    });
    await expect(page.getByRole('button', { name: '添加运动事件', exact: true })).toBeDisabled();
    await expect(page.getByRole('combobox', { name: '事件类型', exact: true })).toBeDisabled();
    await call('object_update', {
      id: 'handover-prop',
      patch: { locked: false },
      projectId: current.id,
      expectedRevision: objectLocked.project.revision,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page.getByRole('button', { name: '交接手机', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '事件类型', exact: true })).toHaveValue('projectile');
    await writeFile(
      testInfo.outputPath('motion-events-evidence.json'),
      JSON.stringify(
        {
          projectId: current.id,
          event: await event(),
          synchronization: (await read()).synchronization,
          mcpAndUiAgree: true,
          undoRestoredEventAndSync: true,
          passed: true,
        },
        null,
        2,
      ),
    );
    expect(errors).toEqual([]);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await client.close();
  }
});
