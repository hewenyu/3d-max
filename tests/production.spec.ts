import { expect, test } from '@playwright/test';
import type { Project } from '../shared/types';

test.beforeEach(async ({ request }) => {
  expect(
    (await request.post('/api/project/new', { data: { name: '多场景表演验收', template: 'demo' } })).ok(),
  ).toBeTruthy();
});

test('scene and performance controls preserve independent animation, reusable geometry and story metadata', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '场次', exact: true }).click();
  await page.getByRole('button', { name: '复制表演版本', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/project')).json()).production?.scenes[0]?.performances.length,
    )
    .toBe(2);
  let project: Project = await (await request.get('/api/project')).json();
  const originalSceneId = project.production!.activeSceneId;
  const originalTakeId = project.production!.scenes[0]!.performances[0]!.id;
  const alternateTakeId = project.production!.activePerformanceId;
  const actor = project.objects.find((object) => object.type === 'actor')!;
  const originalX = actor.position[0];
  await page.getByRole('button', { name: '层级', exact: true }).click();
  await page.getByRole('button', { name: actor.name, exact: true }).click();
  const x = page.getByRole('spinbutton', { name: '位置 · m X', exact: true });
  await x.fill('3.25');
  await x.press('Enter');
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/project')).json()).objects.find(
          (object: { id: string }) => object.id === actor.id,
        )?.position[0],
    )
    .toBe(3.25);
  await page.getByRole('button', { name: '场次', exact: true }).click();
  await page.getByRole('combobox', { name: '当前表演', exact: true }).selectOption(originalTakeId);
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/project')).json()).objects.find(
          (object: { id: string }) => object.id === actor.id,
        )?.position[0],
    )
    .toBe(originalX);
  await page.getByRole('combobox', { name: '当前表演', exact: true }).selectOption(alternateTakeId);
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/project')).json()).objects.find(
          (object: { id: string }) => object.id === actor.id,
        )?.position[0],
    )
    .toBe(3.25);
  await page.getByRole('button', { name: '复用当前布景', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/project')).json()).production.scenes.length)
    .toBe(2);
  await page.getByRole('textbox', { name: '场景名称', exact: true }).fill('第二场布景');
  await page.getByRole('textbox', { name: '场景名称', exact: true }).press('Enter');
  await expect
    .poll(async () => (await (await request.get('/api/project')).json()).sceneName)
    .toBe('第二场布景');
  await page.getByRole('button', { name: '新增剧情场次', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/project')).json()).production.storyScenes.length)
    .toBe(1);
  await page.getByRole('combobox', { name: '当前场景', exact: true }).selectOption(originalSceneId);
  await expect(page.getByRole('textbox', { name: '场景名称', exact: true })).not.toHaveValue('第二场布景');
  await page.reload();
  await page.getByRole('button', { name: '场次', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前场景', exact: true })).toHaveValue(originalSceneId);
  project = await (await request.get('/api/project')).json();
  expect(project.production!.scenes[1]!.name).toBe('第二场布景');
  expect(project.production!.storyScenes).toHaveLength(1);
  await page.screenshot({ path: 'test-results/production-desktop.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
  expect(errors).toEqual([]);
});

test('mobile production controls remain usable and shot bindings select an explicit performance', async ({
  page,
  request,
}) => {
  await request.post('/api/commands', {
    data: { commands: [{ type: 'production.initialize', payload: {} }] },
  });
  const current: Project = await (await request.get('/api/project')).json();
  const scene = current.production!.scenes[0]!;
  await request.post('/api/commands', {
    data: {
      commands: [
        {
          type: 'performance.duplicate',
          payload: {
            sceneId: scene.id,
            id: scene.performances[0]!.id,
            newId: 'mobile-alternate',
            name: '手机表演方案',
            select: false,
          },
        },
      ],
    },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '场景资源面板', exact: true }).click();
  await page.getByRole('button', { name: '场次', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前表演', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '当前表演', exact: true }).selectOption('mobile-alternate');
  await expect
    .poll(async () => (await (await request.get('/api/project')).json()).production.activePerformanceId)
    .toBe('mobile-alternate');
  await page.screenshot({ path: 'test-results/production-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: '收起资源面板', exact: true }).click();
  await page.locator('.shot-card').first().click();
  await page.getByRole('button', { name: '属性面板', exact: true }).click();
  await page.getByRole('combobox', { name: '镜头绑定表演', exact: true }).selectOption('mobile-alternate');
  await expect
    .poll(async () => (await (await request.get('/api/project')).json()).shots[0].performanceId)
    .toBe('mobile-alternate');
  await expect(page.getByRole('combobox', { name: '镜头绑定表演', exact: true })).toHaveValue(
    'mobile-alternate',
  );
});
