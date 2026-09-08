import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PerspectiveCamera, Vector3 } from 'three';
import type { Project, CommandResponse } from '../shared/types';
import type { WorkspaceCommand, WorkspaceState } from '../shared/workspace';
import type { MeshData } from '../shared/modeling';

test('production source preparation cancels a changed selection and permits retry after a worker load failure', async ({
  page,
  request,
}) => {
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'component-source-cancellation', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    return JSON.parse((response.content as { text?: string }[]).find((item) => item.text)!.text!) as T;
  };
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let sourceRequested = false;
  try {
    let project = await call<Project>('project_new', { name: '组件源取消验收', template: 'empty' });
    for (const [name, payload] of [
      ['object_create', { id: 'source', name: '准备中的网格', type: 'box', dimensions: [2, 2, 2] }],
      ['mesh_convert', { id: 'source' }],
      ['object_create', { id: 'other', name: '切换目标', type: 'box', position: [4, 0, 0] }],
    ] as const) {
      project = (
        await call<CommandResponse>(name, {
          ...payload,
          projectId: project.id,
          expectedRevision: project.revision,
          requestId: crypto.randomUUID(),
        })
      ).project;
    }
    await page.route('**/*ComponentSourceWorker*', async (route) => {
      sourceRequested = true;
      await held;
      await route.continue().catch(() => undefined);
    });
    await page.goto('/');
    let workspaceId = '';
    await expect
      .poll(async () => {
        const sessions =
          await call<{ id: string; connected: boolean; state: WorkspaceState }[]>('workspace_list');
        workspaceId =
          sessions.find(
            (session) =>
              session.connected && session.state.projectId === project.id && !session.state.viewport.loading,
          )?.id ?? '';
        return workspaceId;
      })
      .not.toBe('');
    const guard = { workspaceId, projectId: project.id, expectedRevision: project.revision };
    const pending = client.callTool({
      name: 'workspace_apply',
      arguments: {
        ...guard,
        requestId: crypto.randomUUID(),
        command: { type: 'components', objectId: 'source', mode: 'face' },
      },
    });
    await expect(page.getByText('正在准备组件', { exact: true })).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await page.getByRole('button', { name: '切换目标', exact: true }).click();
    const response = await pending;
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('superseded');
    expect(sourceRequested).toBe(true);
    release!();
    await expect
      .poll(() => page.workers().filter((worker) => worker.url().includes('ComponentSourceWorker')).length)
      .toBe(0);
    const state = await call<WorkspaceState>('workspace_get', guard);
    expect(state.selection).toEqual(['other']);
    expect(state.components?.mode).toBe('object');
    expect(state.components?.selection).toBe(null);
    expect(state.viewport.loading).toBe(false);
    expect((await call<Project>('project_get')).revision).toBe(project.revision);
    await page.unroute('**/*ComponentSourceWorker*');
    let failOnce = true;
    await page.route('**/*ComponentSourceWorker*', async (route) => {
      if (failOnce) {
        failOnce = false;
        await route.abort('failed');
      } else await route.continue();
    });
    await page.getByRole('button', { name: '准备中的网格', exact: true }).click();
    await page.getByRole('button', { name: '重新准备组件', exact: true }).click();
    await expect(page.getByTestId('topology-panel')).toBeVisible();
    const recovered = await call<WorkspaceState>('workspace_apply', {
      ...guard,
      requestId: crypto.randomUUID(),
      command: { type: 'components', objectId: 'source', mode: 'face' },
    });
    expect(recovered.components?.mode).toBe('face');
    expect(recovered.viewport.loading).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    release?.();
    await client.close();
  }
});

test('component viewport picks polygons, vertices and edges; box/lasso/xray and MCP edits share stable state', async ({
  page,
  request,
}, info) => {
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'component-workspace-validation', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const content = response.content as { type: string; text?: string }[];
    return JSON.parse(content.find((item) => item.type === 'text')!.text!) as T;
  };
  let project = await call<Project>('project_new', { name: '组件视口验收', template: 'empty' });
  const edit = async (name: string, args: Record<string, unknown>) => {
    const result = await call<CommandResponse>(name, {
      ...args,
      projectId: project.id,
      expectedRevision: project.revision,
      requestId: crypto.randomUUID(),
    });
    project = result.project;
    return result;
  };
  const errors: string[] = [];
  const workerUrls: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', (worker) => workerUrls.push(worker.url()));
  try {
    await edit('object_create', { id: 'subject', name: '拓扑主体', type: 'box', dimensions: [2, 2, 2] });
    await edit('mesh_convert', { id: 'subject' });
    const mesh = project.objects[0].modeling as MeshData;
    expect(mesh.identity).toBeTruthy();
    const namespace = mesh.identity!.namespace;
    await page.goto('/');
    await expect(page.getByRole('button', { name: '拓扑主体', exact: true })).toBeVisible();
    let workspaceId = '';
    await expect
      .poll(async () => {
        const sessions =
          await call<{ id: string; connected: boolean; state: WorkspaceState }[]>('workspace_list');
        workspaceId =
          sessions.find(
            (item) => item.connected && item.state.projectId === project.id && !item.state.viewport.loading,
          )?.id ?? '';
        return workspaceId;
      })
      .not.toBe('');
    const guard = () => ({ workspaceId, projectId: project.id, expectedRevision: project.revision });
    const state = () => call<WorkspaceState>('workspace_get', guard());
    const apply = (command: WorkspaceCommand) =>
      call<WorkspaceState>('workspace_apply', { ...guard(), requestId: crypto.randomUUID(), command });
    await apply({ type: 'selection', ids: ['subject'] });
    await apply({ type: 'observation', view: 'edit', position: [4, 3, 6], target: [0, 1, 0], fov: 43 });
    await apply({ type: 'components', mode: 'face' });
    expect(workerUrls.some((url) => url.includes('ComponentSourceWorker'))).toBe(true);
    expect((await state()).viewport.loading).toBe(false);
    const canvas = page.getByLabel('3D 场景视口', { exact: true });
    const bounds = (await canvas.boundingBox())!;
    const camera = new PerspectiveCamera(43, bounds.width / bounds.height, 0.05, 300);
    camera.position.set(4, 3, 6);
    camera.lookAt(0, 1, 0);
    camera.updateMatrixWorld(true);
    const projectPoint = (point: [number, number, number]) => {
      const ndc = new Vector3(...point).project(camera);
      return {
        x: bounds.x + ((ndc.x + 1) / 2) * bounds.width,
        y: bounds.y + ((1 - ndc.y) / 2) * bounds.height,
      };
    };
    const front = projectPoint([0, 1, 1]);
    await page.mouse.click(front.x, front.y);
    await expect
      .poll(async () => (await state()).components?.selection?.ids)
      .toEqual([mesh.identity!.faceIds[1]]);
    const selectedPixels = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const faceSelection = (await state()).components!.selection!;
    await edit('topology_extrude', { id: 'subject', selection: faceSelection, distance: 0.3 });
    await expect
      .poll(
        async () =>
          (await call<{ state: WorkspaceState }[]>('workspace_list')).find(
            (item) => item.state.projectId === project.id,
          )?.state.projectRevision,
      )
      .toBe(project.revision);
    expect((await state()).components!.selection!.ids).toEqual(faceSelection.ids);
    await expect
      .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL()))
      .not.toBe(selectedPixels);
    project = await call<Project>('history_undo', {
      projectId: project.id,
      expectedRevision: project.revision,
    });
    await expect
      .poll(
        async () =>
          (await call<{ state: WorkspaceState }[]>('workspace_list')).find(
            (item) => item.state.projectId === project.id,
          )?.state.projectRevision,
      )
      .toBe(project.revision);
    await apply({ type: 'components', mode: 'vertex', tool: 'pick' });
    const corner = projectPoint([1, 2, 1]);
    await page.mouse.click(corner.x, corner.y);
    await expect
      .poll(async () => (await state()).components?.selection?.ids)
      .toEqual([mesh.identity!.vertexIds[6]]);
    const secondCorner = projectPoint([-1, 0, 1]);
    await page.keyboard.down('Shift');
    await page.mouse.click(secondCorner.x, secondCorner.y);
    await page.keyboard.up('Shift');
    await expect
      .poll(async () => (await state()).components?.selection?.ids)
      .toEqual([mesh.identity!.vertexIds[6], mesh.identity!.vertexIds[4]]);
    await page.keyboard.down('Control');
    await page.mouse.click(corner.x, corner.y);
    await page.keyboard.up('Control');
    await expect
      .poll(async () => (await state()).components?.selection?.ids)
      .toEqual([mesh.identity!.vertexIds[4]]);
    await apply({ type: 'components', mode: 'edge', tool: 'pick' });
    const edge = projectPoint([0, 2, 1]);
    await page.mouse.click(edge.x, edge.y);
    await expect.poll(async () => (await state()).components?.selection?.ids.length).toBe(1);
    await apply({ type: 'components', mode: 'vertex', tool: 'box', xray: true });
    const projected = mesh.vertices.map(projectPoint);
    const left = Math.min(...projected.map((point) => point.x)) - 15;
    const right = Math.max(...projected.map((point) => point.x)) + 15;
    const top = Math.min(...projected.map((point) => point.y)) - 15;
    const bottom = Math.max(...projected.map((point) => point.y)) + 15;
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await state()).components?.selection?.ids.length).toBe(8);
    await apply({
      type: 'components',
      selection: { namespace, kind: 'vertex', ids: [], operation: 'replace' },
      xray: false,
    });
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 8 });
    await page.mouse.up();
    const visibleCount = (await state()).components!.selection!.ids.length;
    expect(visibleCount).toBeGreaterThan(0);
    expect(visibleCount).toBeLessThan(8);
    await apply({
      type: 'components',
      tool: 'lasso',
      xray: true,
      selection: { namespace, kind: 'vertex', ids: [], operation: 'replace' },
    });
    await page.mouse.move(left, top);
    await page.mouse.down();
    for (const [x, y] of [
      [right, top],
      [right, bottom],
      [left, bottom],
      [left, top],
    ])
      await page.mouse.move(x, y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await state()).components?.selection?.ids.length).toBe(8);
    await apply({
      type: 'components',
      mode: 'face',
      tool: 'pick',
      xray: false,
      normals: true,
      boundaries: true,
      selection: { namespace, kind: 'face', ids: [mesh.identity!.faceIds[1]], operation: 'replace' },
    });
    const colors = await canvas.evaluate((element: HTMLCanvasElement) => {
      const copy = document.createElement('canvas');
      copy.width = element.width;
      copy.height = element.height;
      const context = copy.getContext('2d')!;
      context.drawImage(element, 0, 0);
      const data = context.getImageData(0, 0, copy.width, copy.height).data;
      let accent = 0;
      const colors = new Set<number>();
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] > data[index + 1] * 1.15 && data[index + 1] > data[index + 2] * 1.1) accent++;
        if (index % 124 === 0) colors.add((data[index] << 16) | (data[index + 1] << 8) | data[index + 2]);
      }
      return { accent, colors: colors.size };
    });
    expect(colors.accent).toBeGreaterThan(100);
    expect(colors.colors).toBeGreaterThan(30);
    const beforeDrag = structuredClone((project.objects[0].modeling as MeshData).vertices);
    const beforeRevision = project.revision;
    const gizmoScale =
      (camera.position.distanceTo(new Vector3(0, 1, 1)) *
        Math.min(1.9 * Math.tan((43 * Math.PI) / 360), 7) *
        0.8) /
      4;
    const handle = projectPoint([gizmoScale * 0.65, 1, 1]);
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 70, handle.y, { steps: 12 });
    await expect.poll(() => workerUrls.some((url) => url.includes('ComponentPreviewWorker'))).toBe(true);
    await page.mouse.move(handle.x + 85, handle.y, { steps: 12 });
    await page.screenshot({ path: info.outputPath('component-drag-preview.png') });
    expect((await call<Project>('project_get')).revision).toBe(beforeRevision);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    const cancelled = await call<Project>('project_get');
    expect(cancelled.revision).toBe(beforeRevision);
    expect((cancelled.objects[0].modeling as MeshData).vertices).toEqual(beforeDrag);
    expect((await state()).components!.selection!.ids).toEqual(faceSelection.ids);
    for (const reason of ['pointercancel', 'lostpointercapture']) {
      const previousWorkers = workerUrls.length;
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      await page.mouse.move(handle.x + 70, handle.y, { steps: 12 });
      await expect.poll(() => workerUrls.length).toBeGreaterThan(previousWorkers);
      await canvas.evaluate((element: HTMLCanvasElement, type: string) => {
        if (type === 'lostpointercapture') {
          if (!element.hasPointerCapture(1)) throw new Error('The live gizmo drag did not capture the mouse');
          element.releasePointerCapture(1);
        } else element.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
      }, reason);
      await page.mouse.up();
      const interrupted = await call<Project>('project_get');
      expect(interrupted.revision, reason).toBe(beforeRevision);
      expect((interrupted.objects[0].modeling as MeshData).vertices, reason).toEqual(beforeDrag);
      expect((await state()).components!.selection!.ids, reason).toEqual(faceSelection.ids);
    }
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 70, handle.y, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(async () => {
        project = await call<Project>('project_get');
        return project.revision;
      })
      .toBeGreaterThan(beforeRevision);
    const afterDrag = (project.objects[0].modeling as MeshData).vertices;
    const moving = new Set(mesh.faces[1]);
    for (let index = 0; index < beforeDrag.length; index++) {
      if (moving.has(index)) expect(afterDrag[index][0]).toBeGreaterThan(beforeDrag[index][0] + 0.1);
      else expect(afterDrag[index]).toEqual(beforeDrag[index]);
    }
    await page.screenshot({ path: info.outputPath('component-drag-committed.png') });
    project = await call<Project>('history_undo', {
      projectId: project.id,
      expectedRevision: project.revision,
    });
    expect((project.objects[0].modeling as MeshData).vertices).toEqual(beforeDrag);
    await expect
      .poll(
        async () =>
          (await call<{ state: WorkspaceState }[]>('workspace_list')).find(
            (item) => item.state.projectId === project.id,
          )?.state.projectRevision,
      )
      .toBe(project.revision);
    await page.screenshot({ path: info.outputPath('components-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath('components-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors).toEqual([]);
    await info.attach('component-state', {
      body: JSON.stringify(await state(), null, 2),
      contentType: 'application/json',
    });
  } finally {
    await client.close();
  }
});
