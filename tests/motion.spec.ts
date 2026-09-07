import { writeFile } from 'node:fs/promises';
import { expect, test, type Route } from '@playwright/test';
import type { Command, Project } from '../shared/types';
import { motionPathSchema } from '../shared/motion';

test('car path editing, actual moving canvas and physics baking work through the shared project', async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fresh = await request.post('/api/project/new', {
    data: { name: '路径与刚体验收', template: 'empty' },
  });
  const project = (await fresh.json()) as Project;
  const path = motionPathSchema.parse({
    points: [{ position: [0, 0.1, 0] }, { position: [0, 0.1, 10] }],
    speed: [{ duration: 6, fromSpeed: 2, toSpeed: 2, easing: 'constant' }],
  });
  const initialized = await request.post('/api/commands', {
    data: {
      projectId: project.id,
      expectedRevision: project.revision,
      commands: [
        {
          type: 'vehicle.create',
          payload: { id: 'car', name: '测试赛车', kind: 'car', position: [0, 0.1, 0] },
        },
        { type: 'motion.path.set', payload: { id: 'car', path } },
        {
          type: 'object.create',
          payload: {
            id: 'floor',
            name: '路面',
            type: 'plane',
            dimensions: [30, 0.1, 40],
            physics: { mode: 'static', restitution: 0 },
          },
        },
        { type: 'camera.create', payload: { id: 'camera', position: [8, 7, 12], target: [0, 0.7, 6] } },
        { type: 'shot.create', payload: { id: 'shot', cameraId: 'camera', sourceIn: 0, sourceOut: 10 } },
        {
          type: 'sequence.update',
          payload: {
            id: project.activeSequenceId,
            patch: { clips: [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 10 }] },
          },
        },
      ],
    },
  });
  expect(initialized.ok(), await initialized.text()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: '测试赛车', exact: true }).click();
  await page.getByRole('button', { name: '编辑运动路径', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '运动路径', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加路径点', exact: true }).click();
  const point = page.getByRole('spinbutton', { name: '路径点 3 X', exact: true });
  await point.fill('5');
  await point.press('Enter');
  await page.getByRole('button', { name: '匹配全路径', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('motion-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog', { name: '运动路径', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('motion-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '保存并烘焙', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(async () => {
      const current = (await (await request.get('/api/project')).json()) as Project;
      return current.objects.find((object) => object.id === 'car')!.keyframes.length;
    })
    .toBe(145);
  const saved = (await (await request.get('/api/project')).json()) as Project;
  expect(saved.objects.find((object) => object.id === 'car')!.motion!.points[2]!.position[0]).toBe(5);
  const canvas = page.locator('[data-testid="stage"] canvas');
  await page.getByRole('button', { name: '回到开始', exact: true }).click();
  const first = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL()))
    .not.toBe(first);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const colors = await canvas.evaluate((element: HTMLCanvasElement) => {
    const output = document.createElement('canvas');
    output.width = 100;
    output.height = 100;
    const context = output.getContext('2d')!;
    context.drawImage(element, 0, 0, 100, 100);
    const data = context.getImageData(0, 0, 100, 100).data;
    const values = new Set<string>();
    for (let index = 0; index < data.length; index += 4)
      values.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
    return values.size;
  });
  expect(colors).toBeGreaterThan(30);
  await page.getByText('刚体模拟', { exact: true }).click();
  const enabled = page.getByRole('checkbox', { name: '启用刚体', exact: true });
  await expect(enabled).not.toBeChecked();
  let releasePhysics!: () => void;
  const physicsGate = new Promise<void>((resolve) => {
    releasePhysics = resolve;
  });
  let intercepted = false;
  const delayPhysics = async (route: Route) => {
    const commands = route.request().postDataJSON().commands as Command[];
    if (
      !intercepted &&
      commands.some((command) => command.type === 'physics.body.set' && command.payload.id === 'car')
    ) {
      intercepted = true;
      // Hold dispatch as well as the HTTP response so SSE cannot apply the edit early.
      await physicsGate;
    }
    await route.continue();
  };
  await page.route('**/api/commands', delayPhysics);
  try {
    await enabled.click();
    await expect.poll(() => intercepted).toBe(true);
    await expect(enabled).toBeDisabled();
    await expect(enabled).not.toBeChecked();
    const pending = (await (await request.get('/api/project')).json()) as Project;
    expect(pending.objects.find((object) => object.id === 'car')!.physics).toBeUndefined();
    await page.screenshot({ path: testInfo.outputPath('physics-toggle-pending.png') });
  } finally {
    releasePhysics();
  }
  await expect(enabled).toBeChecked();
  await expect(enabled).toBeEnabled();
  await expect
    .poll(async () => {
      const current = (await (await request.get('/api/project')).json()) as Project;
      return current.objects.find((object) => object.id === 'car')!.physics?.mode;
    })
    .toBe('dynamic');
  await page.unroute('**/api/commands', delayPhysics);
  const enabledProject = (await (await request.get('/api/project')).json()) as Project;
  await writeFile(
    testInfo.outputPath('physics-async-toggle.json'),
    JSON.stringify(
      {
        intercepted,
        checkedAfterResponse: await enabled.isChecked(),
        revision: enabledProject.revision,
        physics: enabledProject.objects.find((object) => object.id === 'car')!.physics,
      },
      null,
      2,
    ),
  );
  await expect(page.getByRole('combobox', { name: '刚体类型', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '重力环境', exact: true }).selectOption('zero');
  const duration = page.getByRole('spinbutton', { name: '模拟时长', exact: true });
  await duration.fill('1');
  await duration.press('Enter');
  await page.getByRole('button', { name: '烘焙场景刚体', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('1.00 s');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const simulated = (await (await request.get('/api/project')).json()) as Project;
  const car = simulated.objects.find((object) => object.id === 'car')!;
  expect(car.physics?.mode).toBe('dynamic');
  expect(car.keyframes.some((frame) => frame.id.startsWith('physics-'))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('physics-desktop.png') });
  await page.reload();
  await page.getByRole('button', { name: '测试赛车', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '启用刚体', exact: true })).toBeChecked();
  expect(errors).toEqual([]);
});
