import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Document, NodeIO } from '@gltf-transform/core';
import { BoxGeometry } from 'three';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Project } from '../shared/types';

async function connect(request: APIRequestContext) {
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'model-assets-web', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, name).not.toBe(true);
    const text = (response.content as { type: string; text?: string }[]).find((item) => item.type === 'text');
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
  return { client, call, project, edit };
}
async function sourceGlb(morph = false) {
  const document = new Document(),
    buffer = document.createBuffer(),
    geometry = new BoxGeometry(2, 2, 2);
  const position = geometry.getAttribute('position'),
    normal = geometry.getAttribute('normal'),
    uv = geometry.getAttribute('uv');
  const primitive = document
    .createPrimitive()
    .setAttribute(
      'POSITION',
      document.createAccessor().setType('VEC3').setArray(Float32Array.from(position.array)).setBuffer(buffer),
    )
    .setAttribute(
      'NORMAL',
      document.createAccessor().setType('VEC3').setArray(Float32Array.from(normal.array)).setBuffer(buffer),
    )
    .setAttribute(
      'TEXCOORD_0',
      document.createAccessor().setType('VEC2').setArray(Float32Array.from(uv.array)).setBuffer(buffer),
    )
    .setIndices(
      document
        .createAccessor()
        .setType('SCALAR')
        .setArray(Uint16Array.from(geometry.index!.array))
        .setBuffer(buffer),
    )
    .setMaterial(document.createMaterial('Original material').setBaseColorFactor([0.15, 0.6, 0.4, 1]));
  const mesh = document.createMesh('Original mesh').addPrimitive(primitive);
  if (morph) {
    primitive.addTarget(
      document
        .createPrimitiveTarget()
        .setAttribute(
          'POSITION',
          document
            .createAccessor()
            .setType('VEC3')
            .setArray(new Float32Array(position.array.length))
            .setBuffer(buffer),
        ),
    );
    mesh.setWeights([0]);
  }
  document
    .getRoot()
    .setDefaultScene(
      document
        .createScene('Original scene')
        .addChild(document.createNode('Original node').setMesh(mesh).setTranslation([2, 1, 0])),
    );
  geometry.dispose();
  return Buffer.from(await new NodeIO().writeBinary(document));
}
async function upload(request: APIRequestContext, bytes: Buffer, name: string) {
  const response = await request.post('/api/assets', {
    multipart: { file: { name, mimeType: 'model/gltf-binary', buffer: bytes } },
  });
  expect(response.status()).toBe(201);
  return response.json() as Promise<{ id: string; name: string; url: string }>;
}
async function number(page: Page, label: string, value: number) {
  const input = page.getByRole('spinbutton', { name: label, exact: true });
  await input.fill(String(value));
  await input.press('Enter');
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function completedExport(page: Page) {
  return page.waitForResponse(async (response) => {
    if (!/\/api\/modeling\/jobs\/[^/]+$/.test(response.url()) || response.status() !== 200) return false;
    const job = await response.json();
    return job.kind === 'export' && job.status === 'completed';
  });
}

test('GLB conversion reviews real omitted attributes, blocks stale apply, retains original and exports selected or scene geometry', async ({
  page,
  request,
}, info) => {
  const mcp = await connect(request),
    errors: string[] = [],
    exports: unknown[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await mcp.call('project_new', { name: 'GLB流转完整验收', template: 'empty' });
    const bytes = await sourceGlb(),
      original = await upload(request, bytes, 'original-cube.glb');
    await mcp.edit('object_create', {
      id: 'model',
      type: 'model',
      name: '导入模型',
      assetUrl: original.url,
      dimensions: [3, 3, 3],
    });
    await mcp.edit('object_create', { id: 'visible', type: 'box', name: '场景方块', position: [6, 0, 0] });
    await mcp.edit('object_create', {
      id: 'hidden',
      type: 'box',
      name: '隐藏方块',
      position: [-6, 0, 0],
      visible: false,
    });
    await page.goto('/');
    await page.getByRole('button', { name: '导入模型', exact: true }).click();
    const panel = page.getByTestId('model-assets-panel');
    await panel.getByRole('button', { name: '预览网格转换', exact: true }).click();
    await expect(panel.getByRole('button', { name: '应用网格转换', exact: true })).toBeEnabled();
    await expect(panel.getByText('NORMAL, TEXCOORD_0', { exact: false })).toBeVisible();
    await expect(
      panel.getByText('材质和贴图保留在原始模型中，转换结果使用白模材质。', { exact: true }),
    ).toBeVisible();
    expect((await mcp.project()).objects.find((object) => object.id === 'model')!.modeling).toBeUndefined();
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('model-conversion-review-desktop.png') });
    await mcp.edit('object_update', { id: 'model', patch: { name: '已修改模型' } });
    await expect(panel.getByText('项目已更新，转换预览已过期', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '应用网格转换', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: '预览网格转换', exact: true }).click();
    await expect(panel.getByRole('button', { name: '应用网格转换', exact: true })).toBeEnabled();
    const source = (await mcp.project()).objects.find((object) => object.id === 'model')!;
    await panel.getByRole('button', { name: '应用网格转换', exact: true }).click();
    await expect
      .poll(async () => (await mcp.project()).objects.find((object) => object.id === 'model')!.modeling?.kind)
      .toBe('mesh');
    expect(digest(await (await request.get(original.url)).body())).toBe(digest(bytes));
    expect((await mcp.project()).objects.find((object) => object.id === 'model')!.sourceAssetUrl).toBe(
      original.url,
    );
    await expect(panel.getByRole('link', { name: '原始模型', exact: true })).toHaveAttribute(
      'href',
      original.url,
    );
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect
      .poll(async () => (await mcp.project()).objects.find((object) => object.id === 'model'))
      .toEqual(source);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect
      .poll(async () => (await mcp.project()).objects.find((object) => object.id === 'model')!.modeling?.kind)
      .toBe('mesh');
    await mcp.edit('object_keyframe_set', { id: 'model', keyframe: { time: 0, position: [0, 0, 0] } });
    await mcp.edit('object_keyframe_set', { id: 'model', keyframe: { time: 2, position: [3, 0, 0] } });
    await number(page, 'GLB 导出源时间', 2);
    await panel.getByRole('textbox', { name: 'GLB 文件名称', exact: true }).fill('conversion-roundtrip');
    await panel.getByRole('textbox', { name: 'GLB 文件名称', exact: true }).press('Enter');
    const revision = (await mcp.project()).revision;
    const responsePromise = completedExport(page);
    await panel.getByRole('button', { name: '导出 GLB', exact: true }).click();
    const exported = (await (await responsePromise).json()).result;
    exports.push(exported);
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('link', { name: '下载 conversion-roundtrip.glb', exact: true }).click();
    const download = await downloadPromise,
      output = await readFile((await download.path())!);
    expect(download.suggestedFilename()).toBe('conversion-roundtrip.glb');
    expect(output.subarray(0, 4).toString()).toBe('glTF');
    expect(digest(output)).toBe(exported.sha256);
    const glb = await new NodeIO().readBinary(output),
      mesh = glb.getRoot().listMeshes()[0];
    expect(glb.getRoot().listMeshes()).toHaveLength(1);
    expect(mesh.getExtras().whiteframeObjectId).toBe('model');
    const positions = mesh.listPrimitives()[0].getAttribute('POSITION')!;
    const x = Array.from({ length: positions.getCount() }, (_, index) => positions.getElement(index, [])[0]);
    expect((Math.min(...x) + Math.max(...x)) / 2).toBeCloseTo(3, 5);
    expect((await mcp.project()).revision).toBe(revision);
    await panel.getByRole('combobox', { name: 'GLB 导出范围', exact: true }).selectOption('scene');
    for (const includeHidden of [false, true]) {
      await panel.getByRole('checkbox', { name: 'GLB 包含隐藏对象', exact: true }).setChecked(includeHidden);
      const responsePromise = completedExport(page);
      await panel.getByRole('button', { name: '导出 GLB', exact: true }).click();
      const result = (await (await responsePromise).json()).result;
      exports.push(result);
      expect(result.objectIds.sort()).toEqual(
        (includeHidden ? ['model', 'visible', 'hidden'] : ['model', 'visible']).sort(),
      );
      const document = await new NodeIO().readBinary(await (await request.get(result.url)).body());
      expect(document.getRoot().listMeshes()).toHaveLength(includeHidden ? 3 : 2);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await panel.getByTestId('model-export-result').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('glb-export-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const bounds = await panel.locator('input,select,button,a').evaluateAll((elements) =>
      elements.map((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
      })),
    );
    expect(bounds.every((bounds) => bounds.left >= 0 && bounds.right <= 390)).toBe(true);
    expect(errors).toEqual([]);
    expect(await page.locator('.error-toast').count()).toBe(0);
    await info.attach('model-assets-evidence', {
      body: JSON.stringify({ original: { ...original, sha256: digest(bytes) }, exports, errors }, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await mcp.client.close();
  }
});

test('asset conversion can be cancelled while queued behind real geometry computation and then retried', async ({
  page,
  request,
}, info) => {
  const mcp = await connect(request);
  let blockerId: string | undefined;
  try {
    await mcp.call('project_new', { name: '模型任务取消验收', template: 'empty' });
    const original = await upload(request, await sourceGlb(), 'cancel-source.glb');
    await mcp.edit('object_create', {
      id: 'model',
      type: 'model',
      name: '待转换模型',
      assetUrl: original.url,
    });
    await mcp.edit('object_create', { id: 'blocker', type: 'box', name: '后台计算对象' });
    await page.goto('/');
    await page.getByRole('button', { name: '待转换模型', exact: true }).click();
    const project = await mcp.project();
    const surface = {
      kind: 'surface',
      operation: 'sweep',
      segments: 128,
      profileSegments: 16,
      path: { closed: false, points: [{ position: [0, 0, 0] }, { position: [0, 0, 4] }] },
      profile: {
        outer: {
          closed: true,
          points: [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ].map((position) => ({ position })),
        },
        holes: [],
      },
    };
    const blockerResponse = await request.post('/api/modeling/jobs', {
      data: {
        projectId: project.id,
        expectedRevision: project.revision,
        expectedContext: {
          sceneId: project.production?.activeSceneId ?? null,
          performanceId: project.production?.activePerformanceId ?? null,
        },
        requestId: crypto.randomUUID(),
        kind: 'commands',
        commands: Array.from({ length: 12 }, () => ({
          type: 'surface.set',
          payload: { id: 'blocker', surface },
        })),
      },
    });
    expect(blockerResponse.status()).toBe(202);
    blockerId = (await blockerResponse.json()).id;
    const panel = page.getByTestId('model-assets-panel');
    const started = page.waitForResponse(
      (response) => response.url().endsWith('/api/modeling/jobs') && response.status() === 202,
    );
    await panel.getByRole('button', { name: '预览网格转换', exact: true }).click();
    const job = await (await started).json();
    expect(job.kind).toBe('conversion');
    await expect(panel.getByRole('status')).toContainText('排队中');
    await page.screenshot({ path: info.outputPath('asset-job-queued.png') });
    await panel.getByRole('button', { name: '取消模型处理', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('模型处理已取消');
    const cancelled = await (await request.get(`/api/modeling/jobs/${job.id}`)).json();
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.result).toBeUndefined();
    await request.post(`/api/modeling/jobs/${blockerId}/cancel`);
    blockerId = undefined;
    expect(await mcp.project()).toEqual(project);
    await panel.getByRole('button', { name: '预览网格转换', exact: true }).click();
    await expect(panel.getByRole('button', { name: '应用网格转换', exact: true })).toBeEnabled();
    await info.attach('asset-job-cancellation', {
      body: JSON.stringify({ job, cancelled }, null, 2),
      contentType: 'application/json',
    });
  } finally {
    if (blockerId) await request.post(`/api/modeling/jobs/${blockerId}/cancel`);
    await mcp.client.close();
  }
});

test('unsupported morph model shows concrete conversion diagnostics and remains unchanged', async ({
  page,
  request,
}, info) => {
  const mcp = await connect(request);
  try {
    await mcp.call('project_new', { name: '模型不兼容诊断', template: 'empty' });
    const original = await upload(request, await sourceGlb(true), 'morph-source.glb');
    await mcp.edit('object_create', { id: 'morph', type: 'model', name: '形态模型', assetUrl: original.url });
    await page.goto('/');
    await page.getByRole('button', { name: '形态模型', exact: true }).click();
    const before = await mcp.project(),
      panel = page.getByTestId('model-assets-panel');
    await panel.getByRole('button', { name: '预览网格转换', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('含形态键的模型不支持静态网格转换。');
    expect(await mcp.project()).toEqual(before);
    await expect(panel.getByRole('button', { name: '应用网格转换', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await panel.getByRole('alert').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('glb-unsupported-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  } finally {
    await mcp.client.close();
  }
});
