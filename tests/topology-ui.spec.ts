import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Project, Vec3 } from '../shared/types';
import { buildTopology } from '../shared/topology/adjacency';
import type { ComponentSelection } from '../shared/topology/types';
import { topologyCommandCases, topologyCube, topologySource } from './fixtures/topology-command-cases';

async function connect(request: APIRequestContext) {
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'topology-panel-browser', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  const operations: unknown[] = [];
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, name).not.toBe(true);
    const text = (result.content as { type: string; text?: string }[]).find((item) => item.type === 'text');
    operations.push({ name, args, success: true });
    return JSON.parse(text?.text ?? '{}') as T;
  };
  const project = () => call<Project>('project_get');
  const edit = async (name: string, args: Record<string, unknown>) => {
    const current = await project();
    return call(name, {
      ...args,
      projectId: current.id,
      expectedRevision: current.revision,
      requestId: crypto.randomUUID(),
    });
  };
  return { client, call, project, edit, operations };
}
async function number(page: Page, label: string, value: number) {
  const input = page.getByRole('spinbutton', { name: label, exact: true });
  await input.fill(String(value));
  await input.press('Enter');
}
async function vector(page: Page, label: string, value: Vec3) {
  for (const [axis, component] of value.entries())
    await number(page, `${label} ${['X', 'Y', 'Z'][axis]}`, component);
}
async function capture(page: Page, info: TestInfo, name: string) {
  const canvas = page.getByLabel('3D 场景视口', { exact: true });
  const pixels = await canvas.evaluate((source: HTMLCanvasElement) => {
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(source, 0, 0);
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data,
      colors = new Set<number>();
    for (let i = 0; i < data.length; i += 4) colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    return {
      colors: colors.size,
      width: copy.width,
      height: copy.height,
      png: source.toDataURL().split(',')[1],
    };
  });
  expect(pixels.colors).toBeGreaterThan(40);
  await info.attach(name, { body: Buffer.from(pixels.png, 'base64'), contentType: 'image/png' });
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  return { name, colors: pixels.colors, width: pixels.width, height: pixels.height };
}
const labels: Record<string, string> = {
  'topology.extrude': '挤出',
  'topology.inset': '内插',
  'topology.bevel': '倒角',
  'topology.split': '拆分',
  'topology.delete': '删除',
  'topology.merge': '合并顶点',
  'topology.fill': '填洞',
  'topology.bridge': '桥接',
  'topology.weld': '按距离焊接',
  'topology.dissolve': '融并',
  'topology.loop-cut': '环切',
  'topology.slide': '滑移',
  'topology.bisect': '平面切割',
  'topology.repair': '修复网格',
};

test('all 15 topology operations execute from structured Web controls with stable selection and undo', async ({
  page,
  request,
}, info) => {
  const mcp = await connect(request),
    errors: string[] = [],
    commands: unknown[] = [],
    pixels: unknown[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (req) => {
    if (
      (req.url().endsWith('/api/commands') || req.url().endsWith('/api/modeling/jobs')) &&
      req.method() === 'POST' &&
      req.postDataJSON().commands
    )
      commands.push(req.postDataJSON().commands);
  });
  try {
    await mcp.call('project_new', { name: '拓扑工具Web全操作验收', template: 'empty' });
    await mcp.edit('object_create', { id: 'target', type: 'box', name: '拓扑主体' });
    await page.goto('/');
    await page.getByRole('button', { name: '拓扑主体', exact: true }).click();
    for (const item of topologyCommandCases().filter((item) => item.type.startsWith('topology.'))) {
      for (const setup of item.setup ?? [])
        await mcp.edit(setup.type.replaceAll('.', '_').replaceAll('-', '_'), setup.payload);
      const beforeProject = await mcp.project(),
        before = topologySource(beforeProject);
      const payload = (
        typeof item.payload === 'function' ? item.payload(beforeProject) : item.payload
      ) as Record<string, unknown>;
      const selection = payload.selection as ComponentSelection | undefined;
      const panel = page.getByTestId('topology-panel');
      await expect(panel).toBeVisible();
      if (selection) {
        const kindLabel = { vertex: '顶点', edge: '边', face: '面' }[selection.kind];
        await panel.getByRole('button', { name: `${kindLabel}选择模式`, exact: true }).click();
        await page.getByRole('button', { name: '清空组件选择', exact: true }).click();
        const details = panel
          .locator('details')
          .filter({ has: page.locator('summary').filter({ hasText: /^组件列表$/ }) });
        if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
        const topology = buildTopology(before);
        const ids =
          selection.kind === 'vertex'
            ? topology.mesh.identity.vertexIds
            : selection.kind === 'face'
              ? topology.mesh.identity.faceIds
              : topology.edges.map((edge) => edge.id);
        for (const id of selection.ids)
          await panel
            .getByRole('checkbox', { name: `选择${kindLabel} ${ids.indexOf(id) + 1}`, exact: true })
            .check();
        await expect(panel.getByLabel('已选组件数量', { exact: true })).toContainText(
          `${selection.ids.length} /`,
        );
      }
      if (item.type === 'topology.transform') {
        await vector(page, '组件位移', payload.translation as Vec3);
        await page.getByRole('button', { name: '应用组件变换', exact: true }).click();
      } else {
        await page.getByRole('combobox', { name: '拓扑操作', exact: true }).selectOption(item.type);
        if (!selection && item.type !== 'topology.bisect')
          await page.getByRole('checkbox', { name: '作用于整个网格', exact: true }).check();
        const numbers: Record<string, Record<string, string>> = {
          'topology.extrude': { distance: '挤出距离' },
          'topology.inset': { thickness: '内插厚度', depth: '内插深度' },
          'topology.bevel': { width: '倒角宽度', segments: '倒角分段' },
          'topology.bridge': { segments: '桥接分段' },
          'topology.weld': { tolerance: '焊接距离' },
          'topology.loop-cut': { cuts: '环切数量' },
          'topology.slide': { amount: '滑移比例' },
          'topology.bisect': { offset: '切面偏移' },
        };
        for (const [key, label] of Object.entries(numbers[item.type] ?? {}))
          if (payload[key] !== undefined) await number(page, `拓扑${label}`, payload[key] as number);
        if (item.type === 'topology.delete')
          await page
            .getByRole('combobox', { name: '拓扑相连面处理', exact: true })
            .selectOption(payload.incidentFaces as string);
        if (item.type === 'topology.bisect') {
          await vector(page, '拓扑切面法线', payload.normal as Vec3);
          await page
            .getByRole('combobox', { name: '拓扑切割保留', exact: true })
            .selectOption(payload.keep as string);
          await page.getByRole('checkbox', { name: '拓扑切割封口', exact: true }).check();
        }
        await page.getByRole('button', { name: `执行${labels[item.type]}`, exact: true }).click();
      }
      await expect.poll(async () => (await mcp.project()).revision).toBe(beforeProject.revision + 1);
      expect(topologySource(await mcp.project())).not.toEqual(before);
      expect(await page.locator('.error-toast').count()).toBe(0);
      if (['topology.extrude', 'topology.bevel', 'topology.bridge', 'topology.bisect'].includes(item.type)) {
        await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
        pixels.push(await capture(page, info, item.type.replace('.', '-')));
      }
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(async () => topologySource(await mcp.project())).toEqual(before);
    }
    expect(errors).toEqual([]);
    expect(
      commands
        .flatMap((value) => value as { type: string }[])
        .filter((command) => command.type.startsWith('topology.')),
    ).toHaveLength(15);
    await info.attach('topology-web-evidence', {
      body: JSON.stringify({ operations: mcp.operations, commands, pixels, errors }, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await mcp.client.close();
  }
});

test('topology diagnostics select boundary issues and mobile controls fit each operation', async ({
  page,
  request,
}, info) => {
  const mcp = await connect(request);
  try {
    await mcp.call('project_new', { name: '拓扑移动诊断验收', template: 'empty' });
    await mcp.edit('object_create', { id: 'target', type: 'box', name: '诊断主体' });
    const mesh = topologyCube();
    mesh.faces.splice(3, 1);
    await mcp.edit('mesh_set', {
      id: 'target',
      mesh: { vertices: mesh.vertices, faces: mesh.faces, smooth: false },
    });
    await page.goto('/');
    await page.getByRole('button', { name: '诊断主体', exact: true }).click();
    const panel = page.getByTestId('topology-panel');
    await panel
      .locator('summary')
      .filter({ hasText: /^网格诊断$/ })
      .click();
    await page.getByRole('button', { name: '运行网格诊断', exact: true }).click();
    await expect(panel.getByRole('button', { name: '选择边界边', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '选择边界边', exact: true }).click();
    await expect(panel.getByLabel('已选组件数量', { exact: true })).toContainText('4 /');
    await page.getByRole('combobox', { name: '拓扑操作', exact: true }).selectOption('topology.fill');
    await page.getByRole('button', { name: '执行填洞', exact: true }).click();
    await expect.poll(async () => topologySource(await mcp.project()).faces.length).toBe(6);
    await expect(panel).toBeVisible();
    const diagnostics = panel
      .locator('details')
      .filter({ has: page.locator('summary').filter({ hasText: /^网格诊断$/ }) });
    const boundary = panel.getByRole('button', { name: '选择边界边', exact: true });
    await expect.poll(async () => (await boundary.count()) === 0 || (await boundary.isDisabled())).toBe(true);
    if ((await diagnostics.getAttribute('open')) === null) await diagnostics.locator('summary').click();
    await page.getByRole('button', { name: '运行网格诊断', exact: true }).click();
    await expect(diagnostics.getByText('封闭 · 法线一致 · 1 个连通体', { exact: true })).toBeVisible();
    await expect(boundary).toBeDisabled();
    await expect(boundary.locator('output')).toHaveText('0');
    const filled = await mcp.project();
    const inspected = await mcp.call<{ revision: number; diagnostics: { boundaryEdges: string[] } }>(
      'mesh_inspect',
      {
        projectId: filled.id,
        expectedRevision: filled.revision,
        expectedContext: {
          sceneId: filled.production?.activeSceneId ?? null,
          performanceId: filled.production?.activePerformanceId ?? null,
        },
        objectId: 'target',
        stage: 'source',
        kind: 'face',
        limit: 1,
      },
    );
    expect(inspected.revision).toBe(filled.revision);
    expect(inspected.diagnostics.boundaryEdges).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await panel.scrollIntoViewIfNeeded();
    for (const type of Object.keys(labels)) {
      await page.getByRole('combobox', { name: '拓扑操作', exact: true }).selectOption(type);
      const fields = await panel.locator('input,select,button').evaluateAll((elements) =>
        elements.map((element) => ({
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right,
        })),
      );
      expect(
        fields.every((field) => field.left >= 0 && field.right <= 390),
        type,
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), type).toBe(390);
    }
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('topology-mobile-controls.png') });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.getByRole('button', { name: '更多视口工具', exact: true }).click();
    await page.getByRole('menuitem', { name: '聚焦选中对象', exact: true }).click();
    await capture(page, info, 'topology-mobile-stage');
  } finally {
    await mcp.client.close();
  }
});
