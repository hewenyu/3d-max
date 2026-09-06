import { test, expect } from '@playwright/test';
import type { Project } from '../shared/types';

test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/project/new', { data: { name: '编辑器验收', template: 'demo' } });
  expect(response.ok()).toBeTruthy();
});

test('scene edits persist, undo restores, and cloned cameras remain independent', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('[data-testid="stage"] canvas')).toBeVisible();
  await page.getByRole('button', { name: '资产', exact: true }).click();
  await page.getByRole('button', { name: '立方体', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '对象名称', exact: true })).toHaveValue('立方体');
  await page.getByRole('textbox', { name: '对象名称', exact: true }).fill('测试方块');
  await page.getByRole('textbox', { name: '对象名称', exact: true }).press('Enter');
  const xInput = page.getByRole('spinbutton', { name: '位置 · m X', exact: true });
  await xInput.fill('2.75');
  await xInput.press('Enter');
  await expect
    .poll(async () => {
      const p: Project = await (await request.get('/api/project')).json();
      return p.objects.find((o) => o.name === '测试方块')?.position[0];
    })
    .toBe(2.75);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(xInput).toHaveValue('0');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(xInput).toHaveValue('2.75');
  await page.reload();
  await page.getByRole('button', { name: '测试方块', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '位置 · m X', exact: true })).toHaveValue('2.75');

  await page.locator('.shot-card').nth(2).click();
  const original: Project = await (await request.get('/api/project')).json();
  const originalCamera = original.cameras.find((c) => c.id === 'camera-reveal')!;
  await page.getByRole('button', { name: '复制剪辑方案', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/project')).json()).sequences.length).toBe(2);
  const copied: Project = await (await request.get('/api/project')).json();
  const copy = copied.sequences.find((s) => s.id !== original.activeSequenceId)!;
  await page.getByRole('combobox', { name: '剪辑方案', exact: true }).selectOption(copy.id);
  await page.locator('.shot-card').nth(2).click();
  const cameraX = page.getByRole('spinbutton', { name: '机位 · m X', exact: true });
  await cameraX.fill('-1.25');
  await cameraX.press('Enter');
  await expect
    .poll(async () => {
      const p: Project = await (await request.get('/api/project')).json();
      const copiedShot = p.shots.find((s) => s.id === copy.clips[2].shotId)!;
      return p.cameras.find((c) => c.id === copiedShot.cameraId)?.position[0];
    })
    .toBe(-1.25);
  const final: Project = await (await request.get('/api/project')).json();
  expect(final.cameras.find((c) => c.id === originalCamera.id)).toEqual(originalCamera);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('director notes, beat timing, project navigation and render configuration are usable', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.locator('.shot-card')).toHaveCount(3);
  await page.getByRole('button', { name: '导演', exact: true }).click();
  await page.getByRole('button', { name: '添加剧情节拍', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '节拍名称', exact: true })).toHaveCount(6);
  const title = page.getByRole('textbox', { name: '节拍名称', exact: true }).last();
  await title.fill('追问');
  await title.press('Enter');
  await page.getByRole('textbox', { name: '镜头意见', exact: true }).fill('最后一镜保持机位，等待反应。');
  await page.getByRole('button', { name: '记录', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/project')).json()).notes.length).toBe(1);
  await page.getByRole('button', { name: '导出视频', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '导出白模视频' })).toBeVisible();
  await page.getByRole('combobox', { name: '导出画幅', exact: true }).selectOption('16:9');
  await expect(page.getByRole('button', { name: /开始导出/ })).toContainText('240 帧');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'MCP 连接' })).toBeVisible();
  await expect(page.locator('.code-config')).toContainText('http://127.0.0.1:4180/mcp');
  await page.getByRole('button', { name: 'stdio', exact: true }).click();
  await expect(page.locator('.code-config')).toContainText('WHITEFRAME_API_URL');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const current: Project = await (await request.get('/api/project')).json();
  await page.locator('.project-name').click();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('场景模板').selectOption('empty');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.locator('.shot-card')).toHaveCount(0);
  await page.locator('.project-name').click();
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  await page.locator('.project-list-item').filter({ hasText: current.name }).first().click();
  await expect(page.locator('.shot-card')).toHaveCount(3);
  await expect.poll(async () => (await (await request.get('/api/project')).json()).id).toBe(current.id);
});

test('mobile canvas, playback and panels remain usable without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('[data-testid="stage"] canvas')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => page.locator('.transport-time').innerText()).not.toContain('00:00:00');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '场景资源面板', exact: true }).click();
  await expect(page.locator('.scene-panel')).toBeVisible();
  await page.getByRole('button', { name: '收起资源面板', exact: true }).click();
  await page.getByRole('button', { name: '属性面板', exact: true }).click();
  await expect(page.locator('.inspector')).toBeVisible();
  await page.getByRole('button', { name: '收起属性面板', exact: true }).click();
  await page.screenshot({ path: 'test-results/mobile-editor.png' });
});
