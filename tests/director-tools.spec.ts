import { expect, test } from '@playwright/test';
import { productionRenderFixture } from './fixtures/production-render';
import { createDemoProject, createObject } from '../shared/project';
import { selectProduction, syncProduction } from '../shared/production';

test('mobile viewport tools remain reachable without horizontal page movement', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('[data-testid="stage"] canvas')).toBeVisible();
  await page.getByRole('button', { name: '更多视口工具', exact: true }).click();
  const menu = page.getByRole('menu', { name: '视口工具' });
  await expect(menu).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-viewport-menu.png') });
  await menu.getByRole('menuitemcheckbox', { name: '旋转', exact: true }).click();
  await page.getByRole('button', { name: '更多视口工具', exact: true }).click();
  await expect(menu.getByRole('menuitemcheckbox', { name: '旋转', exact: true })).toBeChecked();
  await menu.getByRole('menuitem', { name: '镜头方案比较', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '剪辑方案对比' })).toBeVisible();
  await page
    .getByRole('dialog', { name: '剪辑方案对比' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '场景资源面板', exact: true }).click();
  await expect(page.locator('.scene-panel')).toBeVisible();
  expect(
    await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      x: document.querySelector('.app')!.scrollLeft,
    })),
  ).toEqual({ width: 390, x: 0 });
  await page.setViewportSize({ width: 320, height: 720 });
  const bounds = await page.locator('.workspace-toolbar').evaluate((element) =>
    Array.from(element.querySelectorAll('button'))
      .filter((button) => button.getBoundingClientRect().width)
      .map((button) => ({
        label: button.getAttribute('aria-label'),
        left: button.getBoundingClientRect().left,
        right: button.getBoundingClientRect().right,
      })),
  );
  expect(bounds.every((button) => button.left >= 0 && button.right <= 320)).toBe(true);
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`sequence comparison synchronizes actual scene pixels and independent source clocks at ${viewport.width}px`, async ({
    page,
    request,
  }, testInfo) => {
    const project = productionRenderFixture();
    project.sequences.push({
      ...structuredClone(project.sequences[0]),
      id: 'alternate-edit',
      name: 'Alternate edit',
      clips: [...project.sequences[0].clips].reverse().map((clip, index) => ({
        ...clip,
        id: `alternate-${index}`,
        sourceIn: index === 0 ? 0.5 : clip.sourceIn,
      })),
    });
    const imported = await request.post('/api/project/import', { data: project });
    expect(imported.ok(), await imported.text()).toBe(true);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('[data-testid="stage"] canvas')).toBeVisible();
    if (viewport.width < 760) {
      await page.getByRole('button', { name: '更多视口工具', exact: true }).click();
      await page.getByRole('menuitem', { name: '镜头方案比较', exact: true }).click();
    } else await page.getByRole('button', { name: '镜头方案比较', exact: true }).click();
    await expect(page.getByRole('button', { name: '播放对比', exact: true })).toBeEnabled();
    await page.getByRole('slider', { name: '对比成片时间' }).evaluate((element) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(element, '0.75');
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.getByTestId('compare-A')).toContainText('源 0.750s');
    await expect(page.getByTestId('compare-B')).toContainText('源 1.250s');
    const pixels = await page.locator('.compare-viewport canvas').evaluateAll((elements) =>
      elements.map((element) => {
        const canvas = element as HTMLCanvasElement;
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = copy.getContext('2d')!;
        context.drawImage(canvas, 0, 0);
        const data = context.getImageData(0, 0, copy.width, copy.height).data;
        const colors = new Set<number>();
        let distinct = 0;
        for (let index = 0; index < data.length; index += 4) {
          colors.add((data[index] << 16) | (data[index + 1] << 8) | data[index + 2]);
          if (
            Math.abs(data[index] - data[0]) +
              Math.abs(data[index + 1] - data[1]) +
              Math.abs(data[index + 2] - data[2]) >
            24
          )
            distinct++;
        }
        return { source: canvas.toDataURL(), colors: colors.size, foreground: distinct / (data.length / 4) };
      }),
    );
    expect(pixels).toHaveLength(2);
    expect(pixels[0].source).not.toBe(pixels[1].source);
    expect(pixels.every((frame) => frame.colors > 30 && frame.foreground > 0.05)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('sequence-compare.png') });
    await page.getByRole('button', { name: '播放对比', exact: true }).click();
    await expect.poll(async () => page.locator('.compare-clock').innerText()).not.toContain('0.75');
    await page.getByRole('button', { name: '暂停对比', exact: true }).click();
    await page.getByRole('slider', { name: '对比成片时间' }).evaluate((element) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(element, '5.9');
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.getByTestId('compare-B')).toContainText('末帧');
    await page.getByRole('button', { name: '交换对比方案', exact: true }).click();
    await expect(page.getByTestId('compare-A')).toContainText('末帧');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page
      .getByRole('dialog', { name: '剪辑方案对比' })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await expect(page.locator('.compare-viewport canvas')).toHaveCount(0);
  });
}

test('continuity panel filters evidence, seeks findings and records reversible director exceptions', async ({
  page,
}, testInfo) => {
  const project = createDemoProject();
  const subject = createObject('box', 'Offscreen subject');
  subject.position = [50, 0, 0];
  project.objects.push(subject);
  project.shots[0].subjectIds.push(subject.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('[data-testid="stage"] canvas')).toBeVisible();
  await page.evaluate(async (project) => {
    const path = '/tests/fixtures/director-tools-harness.tsx';
    const harness = await import(/* @vite-ignore */ path);
    harness.mountContinuity(project);
  }, project);
  const panel = page.getByRole('region', { name: '连续性检查' });
  const issue = panel.getByRole('row').filter({ hasText: '主体出画' }).first();
  await expect(issue).toBeVisible();
  await issue.getByRole('button', { name: '定位 主体出画', exact: true }).click();
  await expect(page.locator('#continuity-harness')).toHaveAttribute('data-seek', /\d/);
  await expect(panel.locator('.continuity-detail')).toContainText('画面归一化坐标');
  await panel.getByRole('textbox', { name: '连续性忽略原因' }).fill('有意保留画外人物');
  await panel.getByRole('button', { name: '标记为有意剪辑' }).click();
  await panel.getByRole('combobox', { name: '连续性筛选' }).selectOption('ignored');
  await expect(panel.getByRole('row').filter({ hasText: '主体出画' })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('continuity-mobile.png') });
  await panel.getByRole('button', { name: '恢复检查', exact: true }).click();
  await expect(panel).toContainText('暂无忽略记录');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('continuity navigation activates the bound scene before editing a reused object ID', async ({
  page,
  request,
}, testInfo) => {
  const project = productionRenderFixture();
  const originalScene = project.production!.activeSceneId;
  const originalTake = project.production!.activePerformanceId;
  selectProduction(project, 'scene-second', 'take-second');
  project.objects.find((object) => object.id === 'shared-actor')!.position = [50, 0, 0];
  syncProduction(project);
  selectProduction(project, originalScene, originalTake);
  const imported = await request.post('/api/project/import', { data: project });
  expect(imported.ok(), await imported.text()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: '连续性审查', exact: true }).click();
  const finding = page.getByRole('row').filter({ hasText: '03 道具揭示' }).filter({ hasText: '主体出画' });
  await finding.getByRole('button', { name: '定位 主体出画', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/project')).json()).production.activeSceneId)
    .toBe('scene-second');
  await expect(page.getByRole('spinbutton', { name: '位置 · m X', exact: true })).toHaveValue('50');
  await page.getByRole('spinbutton', { name: '位置 · m X', exact: true }).fill('51');
  await page.getByRole('spinbutton', { name: '位置 · m X', exact: true }).press('Enter');
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/project')).json()).objects.find(
          (object: { id: string }) => object.id === 'shared-actor',
        ).position[0],
    )
    .toBe(51);
  const current = await (await request.get('/api/project')).json();
  expect(
    current.production.scenes
      .find((scene: { id: string }) => scene.id === originalScene)
      .objects.find((object: { id: string }) => object.id === 'shared-actor').position[0],
  ).toBe(-1.5);
  await page.screenshot({ path: testInfo.outputPath('continuity-scene-navigation.png') });
});
