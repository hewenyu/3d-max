import { createHash } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Project } from '../shared/types';
import type { SurfaceData } from '../shared/surfaces/schema';
import type { WorkspaceState } from '../shared/workspace';

async function connect(request: APIRequestContext) {
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'surface-ui-acceptance', version: '1.0.0' });
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
    expect(text?.type).toBe('text');
    operations.push({ tool: name, arguments: args, success: true });
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

function source(project: Project): SurfaceData {
  const modeling = project.objects.find((object) => object.id === 'subject')?.modeling;
  const base = modeling?.kind === 'stack' ? modeling.base : modeling;
  expect(base?.kind).toBe('surface');
  return base as SurfaceData;
}

async function number(page: Page, label: string, value: number) {
  const input = page.getByRole('spinbutton', { name: label, exact: true });
  await input.fill(String(value));
  await input.press('Enter');
  await expect(input).toHaveValue(String(value));
}

async function capture(page: Page, info: TestInfo, name: string) {
  const image = await page
    .getByLabel('3D 场景视口', { exact: true })
    .evaluate((canvas: HTMLCanvasElement) => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d')!;
      context.drawImage(canvas, 0, 0);
      const data = context.getImageData(0, 0, copy.width, copy.height).data;
      const colors = new Set<number>();
      for (let i = 0; i < data.length; i += 4) colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      return {
        png: canvas.toDataURL().split(',')[1],
        width: canvas.width,
        height: canvas.height,
        colors: colors.size,
      };
    });
  expect(image.colors).toBeGreaterThan(40);
  await info.attach(`${name}-canvas`, { body: Buffer.from(image.png, 'base64'), contentType: 'image/png' });
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  const hash = createHash('sha256').update(Buffer.from(image.png, 'base64')).digest('hex');
  return { name, width: image.width, height: image.height, colors: image.colors, sha256: hash };
}

test('surface Web controls retain editable curves, holes and loft sections across MCP, undo and reopen', async ({
  page,
  request,
}, info) => {
  const mcp = await connect(request);
  const errors: string[] = [];
  const pixels: unknown[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await mcp.call('project_new', { name: '曲面造型完整验收', template: 'empty' });
    await mcp.edit('object_create', { id: 'subject', type: 'box', name: '曲面主体' });
    await page.goto('/');
    await page.getByRole('button', { name: '曲面主体', exact: true }).click();
    await page.getByRole('combobox', { name: '建模类型', exact: true }).selectOption('surface-sweep');
    await page.getByRole('button', { name: '创建几何体', exact: true }).click();
    await expect(async () => {
      expect(source(await mcp.project()).operation).toBe('sweep');
    }).toPass({ timeout: 15000 });
    await mcp.edit('modifier_add', {
      id: 'subject',
      modifier: { id: 'surface-array', type: 'array', count: 2, offset: [1.4, 0, 0] },
    });
    const initialStack = (await mcp.project()).objects.find((object) => object.id === 'subject')!.modeling;
    expect(initialStack?.kind).toBe('stack');
    const panel = page.getByTestId('surface-panel');
    await expect(panel).toBeVisible();
    await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
    pixels.push(await capture(page, info, 'sweep-initial-desktop'));
    const before = source(await mcp.project());
    await number(page, '曲面路径分段', 18);
    await number(page, '曲面厚度', 0.025);
    await number(page, '扫掠路径出切线向量 Y', 1.7);
    expect(source(await mcp.project())).toEqual(before);
    await page.getByRole('button', { name: '应用曲面参数', exact: true }).click();
    await expect.poll(async () => source(await mcp.project()).segments).toBe(18);
    const changed = source(await mcp.project());
    const changedStack = (await mcp.project()).objects.find((object) => object.id === 'subject')!.modeling;
    expect(changedStack?.kind === 'stack' && changedStack.modifiers).toEqual(
      initialStack?.kind === 'stack' && initialStack.modifiers,
    );
    expect(changed.operation === 'sweep' && changed.path.points[0].outTangent?.[1]).toBe(1.7);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => source(await mcp.project())).toEqual(before);
    await expect(page.getByRole('spinbutton', { name: '曲面路径分段', exact: true })).toHaveValue('12');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => source(await mcp.project())).toEqual(changed);
    await page.getByRole('button', { name: '扫掠路径插入控制点', exact: true }).click();
    await page.getByRole('button', { name: '应用曲面参数', exact: true }).click();
    await expect
      .poll(async () => {
        const surface = source(await mcp.project());
        return surface.operation === 'sweep' ? surface.path.points.length : 0;
      })
      .toBe(3);
    await panel.getByRole('tab', { name: '截面', exact: true }).click();
    await page.getByRole('button', { name: '添加截面孔洞', exact: true }).click();
    await page.getByRole('button', { name: '应用曲面参数', exact: true }).click();
    await expect
      .poll(async () => {
        const surface = source(await mcp.project());
        return surface.operation === 'sweep' ? surface.profile.holes.length : 0;
      })
      .toBe(1);
    const holeProject = await mcp.project();
    await expect
      .poll(async () =>
        (await mcp.call<{ connected: boolean; state: WorkspaceState }[]>('workspace_list')).some(
          (workspace) =>
            workspace.connected &&
            workspace.state.projectId === holeProject.id &&
            workspace.state.projectRevision === holeProject.revision &&
            !workspace.state.viewport.loading,
        ),
      )
      .toBe(true);
    await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
    pixels.push(await capture(page, info, 'sweep-hole-desktop'));
    const holeSource = source(await mcp.project());
    await mcp.edit('surface_set', { id: 'subject', surface: { ...holeSource, segments: 20 } });
    await expect(page.getByRole('spinbutton', { name: '曲面路径分段', exact: true })).toHaveValue('20');
    await number(page, '曲面路径分段', 22);
    await mcp.edit('surface_set', { id: 'subject', surface: { ...holeSource, segments: 24 } });
    await expect(panel.getByText('外部更新', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '应用曲面参数', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '还原曲面参数', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: '曲面路径分段', exact: true })).toHaveValue('24');
    await panel.getByRole('button', { name: '旋转', exact: true }).click();
    await number(page, '曲面旋转角度', 270);
    await number(page, '曲面起始角度', 15);
    await page.getByRole('combobox', { name: '旋转母线控制点', exact: true }).selectOption('1');
    await number(page, '旋转母线控制点坐标 R', 1.2);
    await page.getByRole('button', { name: '应用曲面参数', exact: true }).click();
    await expect.poll(async () => source(await mcp.project()).operation).toBe('revolve');
    const revolved = source(await mcp.project());
    expect(
      revolved.operation === 'revolve' && [
        revolved.angle,
        revolved.startAngle,
        revolved.profile.points[1].position[0],
      ],
    ).toEqual([270, 15, 1.2]);
    await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
    pixels.push(await capture(page, info, 'revolve-desktop'));
    await panel.getByRole('button', { name: '放样', exact: true }).click();
    await page.getByRole('combobox', { name: '放样插值', exact: true }).selectOption('linear');
    await page.getByRole('combobox', { name: '放样截面', exact: true }).selectOption('1');
    await number(page, '放样截面位置 X', 0.3);
    await number(page, '放样截面旋转 Y', 10);
    await page.getByRole('button', { name: '应用曲面参数', exact: true }).click();
    await expect.poll(async () => source(await mcp.project()).operation).toBe('loft');
    await page.getByRole('button', { name: '插入放样截面', exact: true }).click();
    await page.getByRole('button', { name: '应用曲面参数', exact: true }).click();
    await expect
      .poll(async () => {
        const surface = source(await mcp.project());
        return surface.operation === 'loft' ? surface.sections.length : 0;
      })
      .toBe(4);
    await page.getByRole('button', { name: '聚焦选中对象', exact: true }).click();
    pixels.push(await capture(page, info, 'loft-desktop'));
    const saved = source(await mcp.project());
    const projectId = (await mcp.project()).id;
    await page.reload();
    await page.getByRole('button', { name: '曲面主体', exact: true }).click();
    expect(source(await mcp.project())).toEqual(saved);
    await expect(page.getByRole('combobox', { name: '放样插值', exact: true })).toHaveValue('linear');
    await mcp.call('project_new', { name: '临时切换', template: 'empty' });
    await mcp.call('project_open', { id: projectId });
    await page.getByRole('button', { name: '曲面主体', exact: true }).click();
    expect(source(await mcp.project())).toEqual(saved);
    expect(errors).toEqual([]);
    await info.attach('surface-ui-evidence', {
      body: JSON.stringify(
        { pixels, operations: mcp.operations, projectId, finalSource: saved, errors },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  } finally {
    await mcp.client.close();
  }
});

test('surface mobile controls apply valid drafts, preserve failures and fit all three operation modes', async ({
  page,
  request,
}, info) => {
  const mcp = await connect(request);
  const errors: string[] = [];
  const pixels: unknown[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await mcp.call('project_new', { name: '曲面移动端验收', template: 'empty' });
    await mcp.edit('object_create', { id: 'subject', type: 'box', name: '移动曲面' });
    await page.goto('/');
    await page.getByRole('button', { name: '移动曲面', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.getByRole('combobox', { name: '建模类型', exact: true }).selectOption('surface-sweep');
    await page.getByRole('button', { name: '创建几何体', exact: true }).click();
    await expect(async () => {
      expect(source(await mcp.project()).operation).toBe('sweep');
    }).toPass({ timeout: 15000 });
    const panel = page.getByTestId('surface-panel');
    for (const [operation, label] of [
      ['sweep', '扫掠'],
      ['revolve', '旋转'],
      ['loft', '放样'],
    ] as const) {
      if (operation !== 'sweep') {
        await panel.getByRole('button', { name: label, exact: true }).click();
        await page.getByRole('button', { name: '应用曲面参数', exact: true }).click();
        await expect.poll(async () => source(await mcp.project()).operation).toBe(operation);
      }
      await number(page, '曲面轮廓分段', 5);
      await page.getByRole('button', { name: '应用曲面参数', exact: true }).click();
      await expect.poll(async () => source(await mcp.project()).profileSegments).toBe(5);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`${operation}-mobile-controls.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      const fields = await panel.locator('input,select,button').evaluateAll((elements) =>
        elements.map((element) => ({
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right,
        })),
      );
      expect(fields.every((field) => field.left >= 0 && field.right <= 390)).toBe(true);
      await page.getByRole('button', { name: '属性面板', exact: true }).click();
      await page.getByRole('button', { name: '更多视口工具', exact: true }).click();
      await page.getByRole('menuitem', { name: '聚焦选中对象', exact: true }).click();
      pixels.push(await capture(page, info, `${operation}-mobile-stage`));
      await page.getByRole('button', { name: '属性面板', exact: true }).click();
    }
    const valid = source(await mcp.project());
    await number(page, '曲面路径分段', 0);
    await page.getByRole('button', { name: '应用曲面参数', exact: true }).click();
    await expect(page.locator('.error-toast')).toBeVisible();
    expect(source(await mcp.project())).toEqual(valid);
    await expect(page.getByRole('spinbutton', { name: '曲面路径分段', exact: true })).toHaveValue('0');
    await page.getByRole('button', { name: '还原曲面参数', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: '曲面路径分段', exact: true })).toHaveValue(
      String(valid.segments),
    );
    expect(errors).toEqual([]);
    await info.attach('surface-mobile-evidence', {
      body: JSON.stringify({ pixels, operations: mcp.operations, errors }, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await mcp.client.close();
  }
});
