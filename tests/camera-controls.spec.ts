import { expect, test } from '@playwright/test';
import type { Project } from '../shared/types';

for (const [name, width, height] of [
  ['desktop', 1440, 1000],
  ['mobile', 390, 844],
] as const) {
  test(`${name} camera controls save independent framing, optical keys and safe margins`, async ({
    page,
    request,
  }, testInfo) => {
    const response = await request.post('/api/project/new', {
      data: { name: '镜头光学验收', template: 'demo' },
    });
    expect(response.ok()).toBeTruthy();
    const initial = (await response.json()) as Project;
    const cameraId = initial.shots[0]!.cameraId;
    const camera = initial.cameras.find((item) => item.id === cameraId)!;
    const read = async () => (await (await request.get('/api/project')).json()) as Project;
    const cameraState = async () => (await read()).cameras.find((item) => item.id === cameraId)!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await page.goto('/');
    if (name === 'mobile') await page.getByRole('button', { name: '属性面板', exact: true }).click();
    const aspect = page.getByRole('combobox', { name: '构图画幅', exact: true });
    await aspect.selectOption('9:16');
    await expect.poll(async () => (await read()).settings.aspect).toBe('9:16');
    await page.getByRole('checkbox', { name: '当前画幅独立构图', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '当前画幅独立构图', exact: true })).toBeChecked();
    await expect.poll(async () => Boolean((await cameraState()).compositions?.['9:16'])).toBe(true);
    const x = page.getByRole('spinbutton', { name: '机位 · m X', exact: true });
    await x.fill('8.4');
    await x.press('Enter');
    await expect.poll(async () => (await cameraState()).compositions?.['9:16']?.position[0]).toBe(8.4);
    await aspect.selectOption('16:9');
    await expect(page.getByRole('checkbox', { name: '当前画幅独立构图', exact: true })).not.toBeChecked();
    await expect(x).toHaveValue(String(camera.position[0]));
    await aspect.selectOption('9:16');
    await expect(x).toHaveValue('8.4');
    await page.getByRole('checkbox', { name: '启用景深', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '启用景深', exact: true })).toBeChecked();
    const distance = page.getByRole('spinbutton', { name: '对焦距离', exact: true });
    await distance.fill('7');
    await distance.press('Enter');
    await expect.poll(async () => (await cameraState()).optics?.focusDistance).toBe(7);
    await page.getByRole('button', { name: '添加对焦关键帧', exact: true }).click();
    await expect.poll(async () => (await cameraState()).optics?.keyframes.length).toBe(1);
    await page.locator('summary').filter({ hasText: '构图安全区' }).click();
    const bottom = page.getByRole('spinbutton', { name: '下边距', exact: true });
    await bottom.fill('18');
    await bottom.press('Enter');
    await expect.poll(async () => (await read()).settings.safeArea?.bottom).toBe(0.18);
    await page.reload();
    if (name === 'mobile') await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '启用景深', exact: true })).toBeChecked();
    await expect(page.getByRole('spinbutton', { name: '机位 · m X', exact: true })).toHaveValue('8.4');
    await page.locator('summary').filter({ hasText: '光学对焦' }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.querySelector('.app')!.scrollLeft)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`camera-${name}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect((await cameraState()).position).toEqual(camera.position);
    expect(errors).toEqual([]);
  });
}
