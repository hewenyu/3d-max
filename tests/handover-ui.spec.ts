import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { attachedCameraFixture } from './fixtures/camera-prop';
import type { Project, SceneObject } from '../shared/types';

test('director authors a two-actor prop handover through current-frame attachment controls with MCP history', async ({
  page,
  request,
}, testInfo) => {
  const directory = testInfo.outputPath('artifacts');
  await mkdir(directory, { recursive: true });
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'handover-ui-acceptance', version: '1' });
  const journal: unknown[] = [];
  const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const value = JSON.parse(
      (result.content as { type: string; text?: string }[]).find((item) => item.type === 'text')!.text!,
    ) as T;
    journal.push({ name, args, result: value });
    return value;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    const initial = attachedCameraFixture();
    initial.objects.find((object) => object.id === 'handover-prop')!.keyframes = [];
    await call('project_import', { project: initial });
    await page.goto('/');
    await page.locator('.tree-select').filter({ hasText: '交接手机' }).click();
    await page.getByRole('button', { name: '当前帧', exact: true }).click();
    const ruler = page.locator('.timeline-ruler');
    const bounds = await ruler.boundingBox();
    await ruler.click({ position: { x: bounds!.width / 2, y: bounds!.height / 2 } });
    await expect(page.locator('.transport-time')).toContainText('00:01:12');
    await page.getByRole('combobox', { name: '角色', exact: true }).selectOption('receiver');
    await expect
      .poll(
        async () =>
          (await call<Project>('project_get')).objects.find((object) => object.id === 'handover-prop')!
            .keyframes.length,
      )
      .toBe(1);
    const after = await call<Project>('project_get');
    const prop = after.objects.find((object) => object.id === 'handover-prop')!;
    expect(prop.attachment?.objectId).toBe('giver');
    expect(prop.keyframes[0].time).toBe(1.5);
    expect(prop.keyframes[0].attachment).toEqual({
      objectId: 'receiver',
      bone: 'rightHand',
      offset: [0, 0, 0],
    });
    const beforeSample = await call<{ objects: SceneObject[] }>('scene_inspect', { sourceTime: 1.49 });
    const afterSample = await call<{ objects: SceneObject[] }>('scene_inspect', { sourceTime: 1.5 });
    expect(beforeSample.objects.find((object) => object.id === prop.id)!.attachment?.objectId).toBe('giver');
    expect(afterSample.objects.find((object) => object.id === prop.id)!.attachment?.objectId).toBe(
      'receiver',
    );
    await page.getByRole('combobox', { name: '角色', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${directory}/desktop.png` });
    const undone = await call<Project>('history_undo', {
      projectId: after.id,
      expectedRevision: after.revision,
    });
    expect(undone.objects.find((object) => object.id === prop.id)!.keyframes).toHaveLength(0);
    const redone = await call<Project>('history_redo', {
      projectId: undone.id,
      expectedRevision: undone.revision,
    });
    expect(redone.objects.find((object) => object.id === prop.id)!.keyframes).toEqual(prop.keyframes);
    await expect(page.getByRole('combobox', { name: '角色', exact: true })).toHaveValue('receiver');
    await page.reload();
    await page.locator('.tree-select').filter({ hasText: '交接手机' }).click();
    await expect(page.locator('.keyframe-list')).toContainText('00:01:12');
    await writeFile(
      `${directory}/report.json`,
      JSON.stringify(
        {
          projectId: after.id,
          authoredRevision: after.revision,
          restoredRevision: redone.revision,
          prop,
          previousRenderEvidence:
            '.data/camera-prop-test-results/camera-prop-attached-prop--1a891-er-bones-through-a-handover/prop-follow-evidence.json',
          passed: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await writeFile(`${directory}/mcp-operations.json`, JSON.stringify(journal, null, 2));
    await client.close();
  }
});
