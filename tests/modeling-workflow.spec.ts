import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Command, CommandResponse, Project, SceneObject, Vec3 } from '../shared/types';
import type { MeshData, CurveData, TerrainData } from '../shared/modeling';
import { skinnedModelAsset } from './fixtures/skinned-model';

async function number(page: Page, label: string, value: number) {
  const input = page.getByRole('spinbutton', { name: label, exact: true });
  await input.fill(String(value));
  await input.press('Enter');
}

test('manual modeling connects multi-selection, snapped group transforms, mesh edits, Boolean, roads and terrain to persisted MCP previews', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(15000);
  const projectName = `人工建模流程验收 ${Date.now()}`;
  const created = await request.post('/api/project/new', {
    data: { name: projectName, template: 'empty' },
  });
  expect(created.ok()).toBe(true);
  const projectId = ((await created.json()) as Project).id;
  const read = async () => (await (await request.get('/api/project')).json()) as Project;
  const object = async (name: string) => (await read()).objects.find((item) => item.name === name)!;
  const commands: Command[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (event) => {
    if (event.method() === 'POST' && new URL(event.url()).pathname === '/api/commands')
      commands.push(...event.postDataJSON().commands);
  });
  const mutate = async (action: () => Promise<unknown>) => {
    const response = page.waitForResponse(
      (event) => event.request().method() === 'POST' && new URL(event.url()).pathname === '/api/commands',
    );
    await action();
    const result = await response;
    expect(result.ok(), await result.text()).toBe(true);
    return (await result.json()) as CommandResponse;
  };
  const setNumber = async (label: string, value: number) => {
    const input = page.getByRole('spinbutton', { name: label, exact: true });
    if (Number(await input.inputValue()) !== value) await mutate(() => number(page, label, value));
  };
  const setVector = async (label: string, values: Vec3) => {
    for (const [index, axis] of ['X', 'Y', 'Z'].entries()) await setNumber(`${label} ${axis}`, values[index]);
  };
  const add = async (type: string, name: string) => {
    await page.getByRole('button', { name: '资产', exact: true }).click();
    await mutate(() => page.getByRole('button', { name: type, exact: true }).click());
    await mutate(async () => {
      const input = page.getByRole('textbox', { name: '对象名称', exact: true });
      await input.fill(name);
      await input.press('Enter');
    });
    return await object(name);
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const gate = await add('墙体', '石门');
  await setVector('尺寸 · m', [4, 3, 0.8]);
  await setVector('位置 · m', [-3.13, 0.43, 0]);
  const unsupported: SceneObject[] = [];
  const assertUnsupported = async (item: SceneObject) => {
    unsupported.push(item);
    const before = await read();
    const convert = page.getByRole('button', { name: '转换为网格', exact: true });
    await expect(convert).toBeDisabled();
    await expect(convert).toHaveAttribute('title', '此对象的原始几何不支持网格转换');
    await page.getByRole('combobox', { name: '布尔操作对象', exact: true }).selectOption(gate.id);
    await expect(page.getByRole('button', { name: '执行布尔', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '执行布尔', exact: true })).toHaveAttribute(
      'title',
      '此对象的原始几何不支持网格转换',
    );
    await page.getByRole('combobox', { name: '建模类型', exact: true }).selectOption('road');
    await expect(page.getByRole('button', { name: '创建几何体', exact: true })).toBeEnabled();
    await page.getByRole('combobox', { name: '建模类型', exact: true }).selectOption('mesh');
    expect(await read()).toEqual(before);
    await page.getByRole('button', { name: '层级', exact: true }).click();
    await mutate(() => page.getByRole('button', { name: `隐藏 ${item.name}`, exact: true }).click());
  };
  for (const label of ['门', '窗', '沙发', '茶几', '椅子', '手机'])
    await assertUnsupported(await add(label, `转换限制 / ${label}`));
  await page.getByRole('button', { name: '资产', exact: true }).click();
  const importedBytes = await skinnedModelAsset();
  await mutate(() =>
    page.locator('.scene-panel input[type=file]').setInputFiles({
      name: 'conversion-import.gltf',
      mimeType: 'model/gltf+json',
      buffer: importedBytes,
    }),
  );
  await expect(page.getByRole('textbox', { name: '对象名称', exact: true })).toHaveValue('conversion-import');
  await assertUnsupported(await object('conversion-import'));
  await page.getByRole('button', { name: '转换为网格', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('unsupported-model-conversion.png') });
  await page.getByRole('button', { name: '石门', exact: true }).click();
  await expect(page.getByRole('button', { name: '转换为网格', exact: true })).toBeEnabled();
  const operandOptions = await page
    .getByRole('combobox', { name: '布尔操作对象', exact: true })
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  for (const item of unsupported) expect(operandOptions).not.toContain(item.id);
  const column = await add('立方体', '立柱');
  await setVector('尺寸 · m', [1, 2, 1]);
  await setVector('位置 · m', [-0.37, 0.81, 0]);
  await page.getByRole('button', { name: '石门', exact: true }).click();
  await page.getByRole('button', { name: '立柱', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.getByRole('combobox', { name: '对齐坐标轴', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '对齐坐标轴', exact: true }).selectOption('y');
  await page.getByRole('combobox', { name: '对齐目标', exact: true }).selectOption('value');
  await mutate(() => page.getByRole('button', { name: '对齐原点', exact: true }).click());
  expect((await object('石门')).position[1]).toBe(0);
  expect((await object('立柱')).position[1]).toBe(0);
  const grouped = await mutate(() =>
    page.locator('.scene-panel').getByRole('button', { name: '编组', exact: true }).click(),
  );
  const group = grouped.results[0] as SceneObject;
  await expect(page.getByRole('textbox', { name: '对象名称', exact: true })).toHaveValue('新编组');
  await setVector('位置 · m', [1.23, 0, -1]);
  const childBefore = [(await object('石门')).position, (await object('立柱')).position];
  await page.getByRole('button', { name: '网格吸附', exact: true }).click();
  const canvas = page.locator('[data-testid="stage"] canvas');
  await page.mouse.move(20, 20);
  const handle = await canvas.evaluate((element: HTMLCanvasElement) => {
    const copy = document.createElement('canvas');
    copy.width = element.width;
    copy.height = element.height;
    const context = copy.getContext('2d')!;
    context.drawImage(element, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    const points: [number, number][] = [];
    for (let y = 0; y < copy.height; y++)
      for (let x = 0; x < copy.width; x++) {
        const i = (y * copy.width + x) * 4;
        if (pixels[i] > 180 && pixels[i + 1] < 110 && pixels[i + 2] < 110) points.push([x, y]);
      }
    if (points.length < 10) throw new Error('Translation X handle is not visible');
    const maximum = Math.max(...points.map((point) => point[0]));
    const tip = points.filter((point) => point[0] > maximum - 6);
    const bounds = element.getBoundingClientRect();
    return {
      x:
        bounds.left +
        ((tip.reduce((sum, point) => sum + point[0], 0) / tip.length) * bounds.width) / element.width,
      y:
        bounds.top +
        ((tip.reduce((sum, point) => sum + point[1], 0) / tip.length) * bounds.height) / element.height,
    };
  });
  await mutate(async () => {
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 61, handle.y + 11, { steps: 12 });
    await page.mouse.up();
  });
  const snapped = (await read()).objects.find((item) => item.id === group.id)!;
  expect(snapped.position[0]).not.toBe(1.23);
  expect(Math.abs(snapped.position[0] * 10 - Math.round(snapped.position[0] * 10))).toBeLessThan(1e-6);
  expect([(await object('石门')).position, (await object('立柱')).position]).toEqual(childBefore);
  await setVector('旋转 · °', [0, 15, 0]);
  await setVector('缩放', [1.1, 1.1, 1.1]);
  await mutate(() => page.getByRole('button', { name: '锁定对象', exact: true }).click());
  await expect(page.getByRole('spinbutton', { name: '位置 · m X', exact: true })).toBeDisabled();
  await mutate(() => page.getByRole('button', { name: '解锁对象', exact: true }).click());
  await page.screenshot({ path: testInfo.outputPath('group-align-snap-desktop.png') });
  await page.getByRole('button', { name: '立柱', exact: true }).click();
  await mutate(() => page.getByRole('button', { name: '复制选中对象', exact: true }).click());
  const duplicate = await object('立柱 副本');
  expect(duplicate.parentId).toBe(group.id);
  await mutate(() => page.getByRole('button', { name: '隐藏 立柱 副本', exact: true }).click());
  await page.getByRole('button', { name: '石门', exact: true }).click();
  await mutate(() => page.getByRole('button', { name: '转换为网格', exact: true }).click());
  await setNumber('顶点坐标 X', -2.15);
  await number(page, '面片索引', 4);
  await number(page, '挤出距离', 0.6);
  await mutate(() => page.getByRole('button', { name: '挤出面片', exact: true }).click());
  const extruded = (await object('石门')).modeling as MeshData;
  expect(extruded.vertices).toHaveLength(12);
  expect(extruded.faces).toHaveLength(10);
  expect(Math.max(...extruded.vertices.map((vertex) => vertex[1]))).toBeCloseTo(3.6);
  const face = extruded.faces[1];
  await number(page, '面片索引', 1);
  await mutate(() => page.getByRole('button', { name: '删除面片', exact: true }).click());
  const indices = page.getByRole('textbox', { name: '新面片索引', exact: true });
  await indices.fill(JSON.stringify(face));
  await indices.press('Enter');
  await mutate(() => page.getByRole('button', { name: '创建面片', exact: true }).click());
  expect(((await object('石门')).modeling as MeshData).faces).toHaveLength(10);
  await page.screenshot({ path: testInfo.outputPath('editable-mesh-desktop.png') });
  const cutter = await add('立方体', '门洞切体');
  await mutate(() => page.getByRole('combobox', { name: '对象父级', exact: true }).selectOption(group.id));
  await setVector('位置 · m', [-3.13, 0, 0]);
  await setVector('尺寸 · m', [1.5, 2.4, 2]);
  await page.getByRole('button', { name: '石门', exact: true }).click();
  await page.getByRole('combobox', { name: '布尔操作对象', exact: true }).selectOption(cutter.id);
  await mutate(() => page.getByRole('button', { name: '执行布尔', exact: true }).click());
  expect((await object('门洞切体')).visible).toBe(false);
  const carved = (await object('石门')).modeling as MeshData;
  expect(carved.faces.length).toBeGreaterThan(10);
  expect(carved.vertices).not.toEqual(extruded.vertices);
  await add('地板', '曲线道路');
  await setVector('位置 · m', [0, 0.16, 0]);
  await page.getByRole('combobox', { name: '建模类型', exact: true }).selectOption('road');
  await mutate(() => page.getByRole('button', { name: '创建几何体', exact: true }).click());
  await setNumber('道路宽度', 2.2);
  await page.getByRole('combobox', { name: '曲线控制点', exact: true }).selectOption({ value: '1' });
  await expect(page.getByRole('combobox', { name: '曲线控制点', exact: true })).toHaveValue('1');
  await setNumber('控制点位置 X', -2);
  await setNumber('控制点位置 Y', 0.4);
  expect(((await object('曲线道路')).modeling as CurveData).points[1]).toEqual([-2, 0.4, 5]);
  await mutate(() => page.getByRole('button', { name: '添加控制点', exact: true }).click());
  expect(((await object('曲线道路')).modeling as CurveData).points).toHaveLength(4);
  await add('地板', '山地');
  await setVector('位置 · m', [0, -0.05, 0]);
  await page.getByRole('combobox', { name: '建模类型', exact: true }).selectOption('terrain');
  await mutate(() => page.getByRole('button', { name: '创建几何体', exact: true }).click());
  await setNumber('地形宽度', 24);
  await setNumber('地形长度', 24);
  await setNumber('地形 X 分段', 12);
  await setNumber('地形 Z 分段', 12);
  await number(page, '地形网格行', 9);
  await number(page, '地形网格列', 9);
  await setNumber('地形格点高度', 1.5);
  await number(page, '笔刷中心 X', 6);
  await number(page, '笔刷中心 Z', 6);
  await number(page, '笔刷半径', 4);
  await number(page, '地形笔刷数值', 2);
  await mutate(() => page.getByRole('button', { name: '应用笔刷', exact: true }).click());
  expect(((await object('山地')).modeling as TerrainData).heights[9 * 13 + 9]).toBeGreaterThan(1.5);
  await mutate(() => page.getByRole('button', { name: '材质 #adb5b5', exact: true }).click());
  await page.getByRole('button', { name: '新镜头', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '机位 · m X', exact: true })).toBeVisible();
  await mutate(() => page.getByRole('combobox', { name: '构图画幅', exact: true }).selectOption('16:9'));
  await setVector('机位 · m', [18, 13, 23]);
  await setVector('朝向目标 · m', [0, 1, 5]);
  await page.getByRole('button', { name: '曲线道路', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '属性面板', exact: true }).click();
  await setNumber('道路宽度', 2.4);
  await page.getByRole('combobox', { name: '曲线控制点', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('curve-editor-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: '场景资源面板', exact: true }).click();
  await page.getByRole('button', { name: '山地', exact: true }).click();
  await page.getByRole('button', { name: '属性面板', exact: true }).click();
  await setNumber('地形格点高度', 0.25);
  await page.getByRole('combobox', { name: '地形笔刷', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('terrain-editor-mobile.png') });
  await page.getByRole('button', { name: '场景资源面板', exact: true }).click();
  await page.getByRole('button', { name: '多选对象', exact: true }).click();
  await page.getByRole('button', { name: '石门', exact: true }).click();
  await page.getByRole('button', { name: '立柱', exact: true }).click();
  await page.getByRole('button', { name: '山地', exact: true }).click();
  await page.getByRole('button', { name: '属性面板', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '对齐坐标轴', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('touch-selection-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const final = await read();
  await page.reload();
  expect((await read()).objects).toEqual(final.objects);
  await page.locator('.project-name').click();
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  await page.locator('.project-list-item').filter({ hasText: projectName }).click();
  await expect(page.getByRole('dialog', { name: '项目', exact: true })).toHaveCount(0);
  const persisted = await read();
  expect(persisted.id).toBe(projectId);
  expect(persisted.objects).toEqual(final.objects);
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'manual-modeling-readback', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    const response = await client.callTool({ name: 'project_get', arguments: {} });
    expect(response.isError).not.toBe(true);
    const remote = JSON.parse(
      (response.content as { type: string; text?: string }[]).find((item) => item.type === 'text')!.text!,
    ) as Project;
    expect(remote).toEqual(persisted);
    const preview = await client.callTool({
      name: 'preview_capture',
      arguments: { shotId: remote.shots[0].id, time: 0, width: 1280, height: 720 },
    });
    expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
    const image = (preview.content as { type: string; data?: string }[]).find(
      (item) => item.type === 'image',
    )!.data!;
    expect(image.length).toBeGreaterThan(10000);
    await writeFile(testInfo.outputPath('manual-modeling-preview.png'), Buffer.from(image, 'base64'));
    await writeFile(testInfo.outputPath('project.json'), JSON.stringify(remote, null, 2));
    await writeFile(testInfo.outputPath('ui-commands.json'), JSON.stringify(commands, null, 2));
    const types = [...new Set(commands.map((command) => command.type))];
    for (const type of [
      'object.create',
      'object.align',
      'object.group',
      'object.duplicate',
      'mesh.convert',
      'mesh.vertex.set',
      'mesh.face.extrude',
      'mesh.face.delete',
      'mesh.face.add',
      'mesh.boolean',
      'curve.set',
      'terrain.set',
      'terrain.point.set',
      'terrain.sculpt',
    ])
      expect(types).toContain(type);
    await writeFile(
      testInfo.outputPath('verification.json'),
      JSON.stringify(
        {
          projectId: remote.id,
          revision: remote.revision,
          commands: commands.length,
          types,
          groupId: group.id,
          snappedPosition: snapped.position,
          gateId: gate.id,
          columnId: column.id,
          persistedObjects: remote.objects.length,
          mcpReadbackMatches: true,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
  }
  await page.getByRole('button', { name: '摄影机', exact: true }).click();
  await page.getByRole('button', { name: '石门', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('manual-modeling-final-desktop.png') });
  expect(errors).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
