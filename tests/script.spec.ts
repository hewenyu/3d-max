import { expect, test } from '@playwright/test';
import type { Project } from '../shared/types';

test('script review edits timing, selects scenes and creates a persistent visible previsualization', async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post('/api/project/new', { data: { name: '剧本拆解验收', template: 'empty' } });
  await page.goto('/');
  await page.getByRole('button', { name: '剧本拆解验收', exact: true }).click();
  await page.getByRole('button', { name: '剧本拆解', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '剧本拆解', exact: true });
  await dialog
    .getByRole('textbox', { name: '剧本文本', exact: true })
    .fill(
      'Title: 门外来客\n\n.INT. 客厅 - 夜\n\n门打开。\n\n@林川\n你来了。\n\n@苏雨\n我来了。\n\n.EXT. 屋顶 - 清晨\n\n清晨的屋顶。',
    );
  await dialog.getByRole('button', { name: '拆解剧本', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '剧本名称', exact: true })).toHaveValue('门外来客');
  const heading = dialog.getByRole('textbox', { name: '场次 1 标题', exact: true });
  await heading.fill('');
  await expect(dialog.getByRole('button', { name: '创建预演', exact: true })).toBeDisabled();
  await heading.fill('INT. 审阅客厅 - 夜');
  await dialog.getByRole('spinbutton', { name: '场次 1 条目 2 时长', exact: true }).fill('5');
  await dialog.getByRole('spinbutton', { name: '场次 1 条目 2 时长', exact: true }).press('Enter');
  await dialog.getByRole('checkbox', { name: '选择场次 2', exact: true }).uncheck();
  await page.screenshot({ path: testInfo.outputPath('script-review-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('script-review-mobile.png') });
  await dialog.getByRole('button', { name: '创建预演', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const current = (await (await request.get('/api/project')).json()) as Project;
  expect(current.production!.storyScenes).toHaveLength(1);
  expect(current.production!.storyScenes[0]!.name).toBe('INT. 审阅客厅 - 夜');
  expect(current.objects.filter((object) => object.type === 'actor')).toHaveLength(2);
  const dialogue = current.beats.find((beat) => beat.actorId && beat.text === '你来了。')!;
  expect(dialogue.endTime - dialogue.time).toBe(5);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  const persisted = (await (await request.get('/api/project')).json()) as Project;
  expect(persisted.production).toEqual(current.production);
  const canvas = page.locator('[data-testid="stage"] canvas');
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const sample = document.createElement('canvas');
        sample.width = 100;
        sample.height = 100;
        const context = sample.getContext('2d')!;
        context.drawImage(element, 0, 0, 100, 100);
        const pixels = context.getImageData(0, 0, 100, 100).data;
        const colors = new Set<string>();
        for (let index = 0; index < pixels.length; index += 4)
          colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`);
        return colors.size;
      }),
    )
    .toBeGreaterThan(25);
  await page.screenshot({ path: testInfo.outputPath('script-created-desktop.png') });
  expect(errors).toEqual([]);
});
