import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Project } from '../shared/types';
import type { TemplateContent, TemplateSummary } from '../shared/templates';

for (const width of [1440, 390]) {
  test(`template library edits through UI and public MCP at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    const connection = await (await request.get('/api/connection')).json();
    const client = new Client({ name: 'template-browser', version: '1' });
    const savedIds: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
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
      await call('project_new', { name: `Template source ${width}`, template: 'demo' });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.goto('/');
      if (width === 390) await page.getByRole('button', { name: '场景资源面板', exact: true }).click();
      await page.getByRole('button', { name: '手机 / 关键道具', exact: true }).click();
      await page.getByRole('button', { name: '模板', exact: true }).click();
      const templateName = `Object assembly ${width} ${Date.now()}`;
      await page.getByRole('textbox', { name: '新模板名称', exact: true }).fill(templateName);
      await page.getByRole('button', { name: '保存模板', exact: true }).click();
      const row = page.locator('.template-row').filter({ hasText: templateName });
      await expect(row).toContainText('3 对象');
      const saved = (await call<TemplateSummary[]>('template_list')).find(
        (item) => item.name === templateName,
      )!;
      savedIds.push(saved.id);
      const content = (await call<{ content: TemplateContent }>('template_get', { id: saved.id })).content;
      const targetName = `Template target ${width}`;
      const target = await call<Project>('project_new', { name: targetName });
      await expect(page.locator('.project-name')).toContainText(targetName);
      await call('template_instantiate', {
        template: content,
        projectId: target.id,
        expectedRevision: target.revision,
      });
      await expect(page.locator('.statusbar')).toContainText('4 对象');
      await row.getByRole('button', { name: '置入', exact: true }).click();
      await expect(page.locator('.statusbar')).toContainText('8 对象');
      const current = await call<Project>('project_get');
      expect(current.objects).toHaveLength(8);
      expect(new Set(current.objects.map((object) => object.id)).size).toBe(8);
      await page.getByRole('button', { name: '模板', exact: true }).click();
      await row.getByRole('button', { name: `编辑模板 ${templateName}`, exact: true }).click();
      await page.getByRole('textbox', { name: '模板名称', exact: true }).fill(`${templateName} revised`);
      await page.getByRole('button', { name: '保存模板信息', exact: true }).click();
      await expect
        .poll(async () => (await call<TemplateSummary>('template_get', { id: saved.id })).revision)
        .toBe(1);
      const scene = await call<TemplateSummary>('template_save', {
        name: `Scene library ${width}`,
        kind: 'scene',
        projectId: current.id,
        expectedRevision: current.revision,
      });
      savedIds.push(scene.id);
      await page.getByRole('button', { name: '刷新模板库', exact: true }).click();
      await expect(page.locator('.template-row').filter({ hasText: scene.name })).toBeVisible();
      await expect(page.getByRole('button', { name: '刷新模板库', exact: true })).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`library-${width}.png`) });
      expect(
        await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          scroll: document.querySelector('.app')!.scrollLeft,
        })),
      ).toEqual({ width, scroll: 0 });
      const restored = await call<{ content: TemplateContent }>('template_get', { id: scene.id });
      const next = await call<Project>('project_new', { name: 'Another independent project' });
      await call('template_instantiate', {
        template: restored.content,
        projectId: next.id,
        expectedRevision: next.revision,
      });
      const placed = await call<Project>('project_get');
      expect(placed.production?.scenes).toHaveLength(2);
      expect(placed.objects).toHaveLength(8);
      expect(errors).toEqual([]);
    } finally {
      for (const id of savedIds) await call('template_delete', { id });
      await client.close();
    }
  });
}

test('project package download and browser restore keep the editable scene and undo history', async ({
  page,
  request,
}) => {
  const response = await request.post('/api/project/new', {
    data: { name: 'Browser package project', template: 'demo' },
  });
  expect(response.ok()).toBe(true);
  const original = (await response.json()) as Project;
  await request.post('/api/commands', {
    data: {
      commands: [{ type: 'project.update', payload: { name: 'Packaged edit' } }],
      projectId: original.id,
      expectedRevision: original.revision,
    },
  });
  await page.goto('/');
  await page.locator('.project-name').click();
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  await page.getByRole('button', { name: '导出项目包', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载项目包', exact: true }).click();
  const artifact = await download;
  expect(artifact.suggestedFilename()).toMatch(/\.whiteframe$/);
  const file = await artifact.path();
  expect(file).toBeTruthy();
  await page.getByLabel('恢复项目包文件', { exact: true }).setInputFiles(file!);
  await expect(page.getByRole('dialog', { name: '项目', exact: true })).toHaveCount(0);
  const restored = (await (await request.get('/api/project')).json()) as Project;
  expect(restored.id).not.toBe(original.id);
  expect(restored.name).toBe('Packaged edit');
  expect(restored.objects).toEqual(original.objects);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.project-name')).toHaveText('Browser package project');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.project-name')).toHaveText('Packaged edit');
});
