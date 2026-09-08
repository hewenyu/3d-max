import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MeshModifier } from '../shared/modifier-schema';
import type { ModifierStack } from '../shared/modeling';
import type { Project } from '../shared/types';

async function modelingClient(request: APIRequestContext) {
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'advanced-modifier-browser', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const content = (response.content as { type: string; text?: string }[]).find(
      (item) => item.type === 'text',
    );
    return JSON.parse(content!.text!) as T;
  };
  const project = () => call<Project>('project_get');
  const edit = async (name: string, args: Record<string, unknown>) => {
    const current = await project();
    return call(name, {
      ...args,
      projectId: current.id,
      expectedRevision: current.revision,
      requestId: `advanced-ui-${crypto.randomUUID()}`,
    });
  };
  return { client, call, project, edit };
}

async function fillNumber(page: Page, name: string, value: number) {
  const input = page.getByRole('spinbutton', { name, exact: true });
  await input.fill(String(value));
  await input.press('Enter');
  await expect(input).toHaveValue(String(value));
}

async function pixels(page: Page) {
  const data = await page
    .locator('[data-testid="stage"] canvas')
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  return createHash('sha256').update(data).digest('hex');
}

function stack(project: Project): ModifierStack {
  const modeling = project.objects.find((object) => object.id === 'subject')?.modeling;
  expect(modeling?.kind).toBe('stack');
  return modeling as ModifierStack;
}

function modifierType(project: Project, index = 0) {
  const modeling = project.objects.find((object) => object.id === 'subject')?.modeling;
  return modeling?.kind === 'stack' ? modeling.modifiers.at(index)?.type : undefined;
}

test('retained Boolean edits its operand through UI and MCP and updates the rendered result', async ({
  page,
  request,
}, info) => {
  const mcp = await modelingClient(request);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await mcp.call('project_new', { name: '布尔依赖验收' });
    await mcp.edit('object_create', { id: 'subject', name: '布尔主体', type: 'box', dimensions: [2, 2, 2] });
    await page.goto('/');
    await page.getByRole('button', { name: '布尔主体', exact: true }).click();
    await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
    await page.getByRole('combobox', { name: '新增修改器类型', exact: true }).selectOption('boolean');
    await expect(page.getByRole('button', { name: '添加修改器', exact: true })).toBeDisabled();
    for (const [id, x] of [
      ['cutter-a', 1],
      ['cutter-b', 1.5],
    ] as const) {
      await mcp.edit('object_create', {
        id,
        name: id,
        type: 'box',
        dimensions: [2, 2, 2],
        position: [x, 0, 0],
        visible: false,
      });
    }
    await page.getByRole('combobox', { name: '新增布尔修改器操作数', exact: true }).selectOption('cutter-a');
    await page.getByRole('button', { name: '添加修改器', exact: true }).click();
    await expect.poll(async () => modifierType(await mcp.project())).toBe('boolean');
    const source = stack(await mcp.project()).base;
    await page.locator('.modifier-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('boolean-before-desktop.png') });
    const first = await pixels(page);
    await page.getByRole('combobox', { name: '修改器 1 布尔操作数', exact: true }).selectOption('cutter-b');
    await expect
      .poll(async () => {
        const modifier = stack(await mcp.project()).modifiers[0];
        return modifier.type === 'boolean' ? modifier.operandId : null;
      })
      .toBe('cutter-b');
    await expect.poll(() => pixels(page)).not.toBe(first);
    const beforeOperandMove = await pixels(page);
    await mcp.edit('object_update', { id: 'cutter-b', patch: { position: [0.5, 0, 0] } });
    await expect.poll(() => pixels(page)).not.toBe(beforeOperandMove);
    for (const operation of ['union', 'intersect', 'subtract']) {
      await page.getByRole('combobox', { name: '修改器 1 布尔运算', exact: true }).selectOption(operation);
      await expect
        .poll(async () => {
          const modifier = stack(await mcp.project()).modifiers[0];
          return modifier.type === 'boolean' ? modifier.operation : null;
        })
        .toBe(operation);
    }
    expect(stack(await mcp.project()).base).toEqual(source);
    await page.screenshot({ path: info.outputPath('boolean-after-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.locator('.modifier-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('boolean-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const beforeBake = stack(await mcp.project());
    await page.getByRole('button', { name: '烘焙修改器', exact: true }).click();
    await expect
      .poll(
        async () => (await mcp.project()).objects.find((object) => object.id === 'subject')!.modeling?.kind,
      )
      .toBe('mesh');
    await mcp.edit('history_undo', {});
    expect(stack(await mcp.project())).toEqual(beforeBake);
    await page.reload();
    expect(stack(await mcp.project())).toEqual(beforeBake);
    expect(errors).toEqual([]);
  } finally {
    await mcp.client.close();
  }
});

test('bevel width, segments and profile remain editable and bake real rounded geometry', async ({
  page,
  request,
}, info) => {
  const mcp = await modelingClient(request);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await mcp.call('project_new', { name: '倒角修改器验收' });
    await mcp.edit('object_create', { id: 'subject', name: '倒角主体', type: 'box', dimensions: [2, 2, 2] });
    await page.goto('/');
    await page.getByRole('button', { name: '倒角主体', exact: true }).click();
    await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
    await page.getByRole('combobox', { name: '新增修改器类型', exact: true }).selectOption('bevel');
    await page.getByRole('button', { name: '添加修改器', exact: true }).click();
    await expect.poll(async () => modifierType(await mcp.project())).toBe('bevel');
    const base = stack(await mcp.project()).base;
    const before = await pixels(page);
    await fillNumber(page, '修改器 1 倒角宽度', 0.4);
    await fillNumber(page, '修改器 1 倒角段数', 5);
    await fillNumber(page, '修改器 1 倒角弧度比例', 0.7);
    await expect
      .poll(async () => {
        const modifier = stack(await mcp.project()).modifiers[0];
        return modifier.type === 'bevel' ? [modifier.width, modifier.segments, modifier.shape] : null;
      })
      .toEqual([0.4, 5, 0.7]);
    expect(stack(await mcp.project()).base).toEqual(base);
    await expect.poll(() => pixels(page)).not.toBe(before);
    await page.locator('.modifier-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('bevel-desktop.png') });
    const enabled = stack(await mcp.project()).modifiers[0];
    const enabledPixels = await pixels(page);
    await mcp.edit('modifier_set', { id: 'subject', modifier: { ...enabled, enabled: false } });
    await expect(page.getByRole('checkbox', { name: '启用修改器 1', exact: true })).not.toBeChecked();
    await expect.poll(() => pixels(page)).not.toBe(enabledPixels);
    await page.getByRole('checkbox', { name: '启用修改器 1', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '启用修改器 1', exact: true })).toBeChecked();
    await page.getByRole('button', { name: '烘焙修改器', exact: true }).click();
    await expect.poll(async () => (await mcp.project()).objects[0].modeling?.kind).toBe('mesh');
    const mesh = (await mcp.project()).objects[0].modeling;
    expect(mesh?.kind === 'mesh' ? mesh.faces.length : 0).toBeGreaterThan(42);
    expect(errors).toEqual([]);
  } finally {
    await mcp.client.close();
  }
});

test('five advanced modifiers share UI/MCP edits and load real OpenSubdiv geometry in the browser', async ({
  page,
  request,
}, info) => {
  const mcp = await modelingClient(request);
  const errors: string[] = [];
  const wasm: { url: string; status: number; bytes: number; header: string; sha256: string }[] = [];
  const wasmPending: Promise<void>[] = [];
  const workers: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', (worker) => workers.push(worker.url()));
  page.context().on('response', (response) => {
    if (!/\/opensubdiv(?:-[^/]+)?\.wasm$/.test(new URL(response.url()).pathname)) return;
    wasmPending.push(
      response
        .body()
        .then((body) => {
          wasm.push({
            url: response.url(),
            status: response.status(),
            bytes: body.length,
            header: body.subarray(0, 8).toString('hex'),
            sha256: createHash('sha256').update(body).digest('hex'),
          });
        })
        .catch((error: Error) => {
          errors.push(`OpenSubdiv response: ${error.message}`);
        }),
    );
  });
  try {
    await mcp.call('project_new', { name: '高级修改器参数验收' });
    await mcp.edit('object_create', { id: 'subject', name: '建模主体', type: 'box', dimensions: [2, 4, 2] });
    await mcp.edit('mesh_convert', { id: 'subject' });
    const source = (await mcp.project()).objects[0].modeling;
    await page.goto('/');
    await page.getByRole('button', { name: '建模主体', exact: true }).click();
    await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
    const cases: { type: MeshModifier['type']; field: string; value: number; property: string }[] = [
      { type: 'solidify', field: '厚度', value: 0.3, property: 'thickness' },
      { type: 'bend', field: '角度', value: 60, property: 'angle' },
      { type: 'twist', field: '角度', value: 90, property: 'angle' },
      { type: 'catmull-clark', field: '细分级别', value: 2, property: 'iterations' },
      { type: 'curve-array', field: '数量', value: 4, property: 'count' },
    ];
    for (const item of cases) {
      await page.getByRole('combobox', { name: '新增修改器类型', exact: true }).selectOption(item.type);
      await page.getByRole('button', { name: '添加修改器', exact: true }).click();
      await expect.poll(async () => modifierType(await mcp.project())).toBe(item.type);
      const before = await pixels(page);
      await fillNumber(page, `修改器 1 ${item.field}`, item.value);
      await expect
        .poll(
          async () =>
            (stack(await mcp.project()).modifiers[0] as unknown as Record<string, unknown>)[item.property],
        )
        .toBe(item.value);
      await expect.poll(() => pixels(page)).not.toBe(before);
      const current = stack(await mcp.project());
      expect(current.base).toEqual(source);
      if (item.type === 'catmull-clark') {
        await page.getByRole('combobox', { name: '修改器 1 边界处理', exact: true }).selectOption('smooth');
        await expect
          .poll(async () => {
            const modifier = stack(await mcp.project()).modifiers[0];
            return modifier.type === 'catmull-clark' ? modifier.boundary : null;
          })
          .toBe('smooth');
      }
      if (item.type === 'curve-array') {
        await page
          .getByRole('combobox', { name: '修改器 1 路径控制点', exact: true })
          .selectOption({ value: '1' });
        await expect(page.getByRole('combobox', { name: '修改器 1 路径控制点', exact: true })).toHaveValue(
          '1',
        );
        await fillNumber(page, '修改器 1 控制点坐标 Z', 3);
        await expect
          .poll(async () => {
            const modifier = stack(await mcp.project()).modifiers[0];
            return modifier.type === 'curve-array' ? modifier.points[1][2] : null;
          })
          .toBe(3);
        await page.getByRole('checkbox', { name: '修改器 1 闭合路径', exact: true }).click();
        await expect(page.getByRole('checkbox', { name: '修改器 1 闭合路径', exact: true })).toBeChecked();
        await page.getByRole('checkbox', { name: '修改器 1 跟随切线', exact: true }).click();
        await expect(
          page.getByRole('checkbox', { name: '修改器 1 跟随切线', exact: true }),
        ).not.toBeChecked();
        await page.getByRole('combobox', { name: '修改器 1 前进轴', exact: true }).selectOption('z');
        await expect
          .poll(async () => {
            const modifier = stack(await mcp.project()).modifiers[0];
            return modifier.type === 'curve-array' ? [modifier.closed, modifier.orient, modifier.axis] : null;
          })
          .toEqual([true, false, 'z']);
        await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
      }
      await page.locator('.modifier-panel').scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`${item.type}-desktop.png`) });
      const enabled = stack(await mcp.project()).modifiers[0];
      const enabledPixels = await pixels(page);
      await mcp.edit('modifier_set', { id: 'subject', modifier: { ...enabled, enabled: false } });
      await expect(page.getByRole('checkbox', { name: '启用修改器 1', exact: true })).not.toBeChecked();
      await expect.poll(() => pixels(page)).not.toBe(enabledPixels);
      await page.getByRole('button', { name: '删除修改器 1', exact: true }).click();
      await expect.poll(async () => (await mcp.project()).objects[0].modeling?.kind).toBe('mesh');
    }
    await Promise.all(wasmPending);
    await expect.poll(() => wasm.length).toBeGreaterThan(0);
    expect(
      wasm.every(
        (response) =>
          response.status === 200 && response.bytes > 10000 && response.header === '0061736d01000000',
      ),
    ).toBe(true);
    expect(workers.some((url) => url.includes('GeometryWorker'))).toBe(true);
    expect(errors).toEqual([]);
    await info.attach('opensubdiv-browser-responses', {
      body: JSON.stringify({ wasm, workers }, null, 2),
      contentType: 'application/json',
    });
    const colors = await page
      .locator('[data-testid="stage"] canvas')
      .evaluate((canvas: HTMLCanvasElement) => {
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = copy.getContext('2d')!;
        context.drawImage(canvas, 0, 0);
        const data = context.getImageData(0, 0, copy.width, copy.height).data;
        const values = new Set<number>();
        for (let index = 0; index < data.length; index += 4 * 31)
          values.add((data[index] << 16) + (data[index + 1] << 8) + data[index + 2]);
        return values.size;
      });
    expect(colors).toBeGreaterThan(20);
  } finally {
    await mcp.client.close();
  }
});

test('advanced modifier copy, reorder, disable, bake and undo retain source and fit mobile', async ({
  page,
  request,
}, info) => {
  const mcp = await modelingClient(request);
  try {
    await mcp.call('project_new', { name: '高级修改器生命周期' });
    await mcp.edit('object_create', {
      id: 'subject',
      name: '生命周期主体',
      type: 'box',
      dimensions: [2, 4, 2],
    });
    await page.goto('/');
    await page.getByRole('button', { name: '生命周期主体', exact: true }).click();
    for (const type of ['catmull-clark', 'twist']) {
      await page.getByRole('combobox', { name: '新增修改器类型', exact: true }).selectOption(type);
      await page.getByRole('button', { name: '添加修改器', exact: true }).click();
      await expect.poll(async () => modifierType(await mcp.project(), -1)).toBe(type);
    }
    const original = stack(await mcp.project());
    await page.getByRole('button', { name: '复制修改器 2', exact: true }).click();
    await expect.poll(async () => stack(await mcp.project()).modifiers.length).toBe(3);
    const copied = stack(await mcp.project());
    expect(copied.modifiers[2]).toEqual({ ...copied.modifiers[1], id: copied.modifiers[2].id });
    expect(new Set(copied.modifiers.map((modifier) => modifier.id)).size).toBe(3);
    await page.getByRole('button', { name: '上移修改器 2', exact: true }).click();
    await expect.poll(async () => stack(await mcp.project()).modifiers[0].type).toBe('twist');
    await page.getByRole('checkbox', { name: '启用修改器 3', exact: true }).click();
    await expect.poll(async () => stack(await mcp.project()).modifiers[2].enabled).toBe(false);
    await expect(page.getByRole('checkbox', { name: '启用修改器 3', exact: true })).not.toBeChecked();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.locator('.modifier-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('advanced-modifiers-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const beforeBake = stack(await mcp.project());
    expect(beforeBake.base).toEqual(original.base);
    await page.getByRole('button', { name: '烘焙修改器', exact: true }).click();
    await expect.poll(async () => (await mcp.project()).objects[0].modeling?.kind).toBe('mesh');
    await mcp.edit('history_undo', {});
    await expect(page.getByRole('button', { name: '烘焙修改器', exact: true })).toBeVisible();
    expect(stack(await mcp.project())).toEqual(beforeBake);
    await page.reload();
    expect(stack(await mcp.project())).toEqual(beforeBake);
  } finally {
    await mcp.client.close();
  }
});

test('mirror seam welding exposes exact thresholds and bakes a connected editable mesh', async ({
  page,
  request,
}, info) => {
  const mcp = await modelingClient(request);
  try {
    await mcp.call('project_new', { name: '镜像焊接验收' });
    await mcp.edit('object_create', { id: 'subject', name: '半边壳体', type: 'box' });
    await mcp.edit('mesh_set', {
      id: 'subject',
      mesh: {
        vertices: [
          [0, 0, -1],
          [1, 0, -1],
          [1, 2, -1],
          [0, 2, -1],
          [0, 0, 1],
          [1, 0, 1],
          [1, 2, 1],
          [0, 2, 1],
        ],
        faces: [
          [0, 3, 2, 1],
          [4, 5, 6, 7],
          [1, 2, 6, 5],
          [3, 7, 6, 2],
          [0, 1, 5, 4],
        ],
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: '半边壳体', exact: true }).click();
    await page.getByRole('combobox', { name: '新增修改器类型', exact: true }).selectOption('mirror');
    await page.getByRole('button', { name: '添加修改器', exact: true }).click();
    await fillNumber(page, '修改器 1 镜面位置', 0);
    await page.getByRole('checkbox', { name: '修改器 1 焊接接缝', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: '修改器 1 焊接距离', exact: true })).toHaveValue(
      '0.001',
    );
    const mirror = stack(await mcp.project()).modifiers[0];
    await mcp.edit('modifier_set', { id: 'subject', modifier: { ...mirror, weldThreshold: 0.000001 } });
    await expect(page.getByRole('spinbutton', { name: '修改器 1 焊接距离', exact: true })).toHaveValue(
      '0.000001',
    );
    await page.getByRole('checkbox', { name: '修改器 1 焊接接缝', exact: true }).click();
    await expect.poll(async () => 'weldThreshold' in stack(await mcp.project()).modifiers[0]).toBe(false);
    await page.getByRole('checkbox', { name: '修改器 1 焊接接缝', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '修改器 1 焊接接缝', exact: true })).toBeChecked();
    await fillNumber(page, '修改器 1 焊接距离', 0.000001);
    await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
    await page.locator('.modifier-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('welded-mirror-desktop.png') });
    await page.getByRole('button', { name: '烘焙修改器', exact: true }).click();
    await expect.poll(async () => (await mcp.project()).objects[0].modeling?.kind).toBe('mesh');
    const mesh = (await mcp.project()).objects[0].modeling;
    if (mesh?.kind !== 'mesh') throw new Error('Expected baked mesh');
    expect(mesh.vertices).toHaveLength(12);
    expect(mesh.faces).toHaveLength(10);
    const uses = new Map<string, number>();
    for (const face of mesh.faces)
      for (let index = 0; index < face.length; index++) {
        const edge = [face[index], face[(index + 1) % face.length]].sort((a, b) => a - b).join(':');
        uses.set(edge, (uses.get(edge) ?? 0) + 1);
      }
    expect([...uses.values()].every((count) => count === 2)).toBe(true);
  } finally {
    await mcp.client.close();
  }
});
