import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { applyCommands } from '../shared/commands';
import { createEmptyProject } from '../shared/project';
import type { CommandResponse, Project, RenderJob } from '../shared/types';
import type { WorkspaceCommand, WorkspaceState } from '../shared/workspace';
import type { ViewportInspection } from '../shared/viewport';

interface Session {
  id: string;
  connected: boolean;
  state: WorkspaceState;
}
interface ToolContent {
  type: string;
  text?: string;
  data?: string;
}

function fixture() {
  const project = createEmptyProject('Workspace parity');
  return applyCommands(project, [
    { type: 'project.settings', payload: { aspect: '16:9', fps: 24 } },
    {
      type: 'object.create',
      payload: { id: 'actor', type: 'actor', name: 'Workspace actor', position: [-1, 0, 0] },
    },
    {
      type: 'object.create',
      payload: {
        id: 'cube',
        type: 'box',
        name: 'Workspace cube',
        position: [1, 0, 0],
        dimensions: [1.2, 1.8, 1.2],
      },
    },
    { type: 'object.keyframe.set', payload: { id: 'cube', keyframe: { time: 0, position: [1, 0, 0] } } },
    { type: 'object.keyframe.set', payload: { id: 'cube', keyframe: { time: 2, position: [2, 0, 0] } } },
    {
      type: 'actor.constraint.set',
      payload: {
        id: 'actor',
        constraint: {
          id: 'contact',
          effector: 'rightHand',
          start: 0.2,
          end: 1.8,
          target: { kind: 'world', position: [-0.55, 1.1, 0.2] },
        },
      },
    },
    {
      type: 'camera.create',
      payload: { id: 'camera-a', name: 'Camera A', position: [4, 3, 6], target: [0, 1, 0], fov: 43 },
    },
    {
      type: 'camera.create',
      payload: { id: 'camera-b', name: 'Camera B', position: [-4, 2, 4], target: [0, 1, 0], fov: 43 },
    },
    {
      type: 'shot.create',
      payload: { id: 'shot-a', name: 'Shot A', cameraId: 'camera-a', sourceIn: 0, sourceOut: 2 },
    },
    {
      type: 'shot.create',
      payload: { id: 'shot-b', name: 'Shot B', cameraId: 'camera-b', sourceIn: 0, sourceOut: 2 },
    },
    {
      type: 'sequence.update',
      payload: {
        id: project.activeSequenceId,
        patch: {
          clips: [
            { id: 'clip-a', shotId: 'shot-a', sourceIn: 0, sourceOut: 1 },
            { id: 'clip-b', shotId: 'shot-b', sourceIn: 1, sourceOut: 2 },
          ],
        },
      },
    },
    {
      type: 'sequence.create',
      payload: {
        id: 'alternate',
        name: 'Alternate',
        clips: [{ id: 'alt-clip', shotId: 'shot-b', sourceIn: 0, sourceOut: 0.75 }],
      },
    },
  ]).project;
}

async function connect(request: APIRequestContext) {
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'workspace-acceptance', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  const raw = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await raw(name, args);
    const content = response.content as ToolContent[];
    const text = content.find((item) => item.type === 'text')?.text;
    if (response.isError || !text) throw new Error(`${name}: ${text ?? 'No JSON result'}`);
    return JSON.parse(text) as T;
  };
  return { client, raw, call };
}

async function imagePixels(page: Page, data: string) {
  return page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<number>();
    for (let index = 0; index < pixels.length; index += 16)
      colors.add((pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2]);
    return { width: canvas.width, height: canvas.height, colors: colors.size };
  }, data);
}

for (const size of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`connected workspace MCP matches actual Web state and pixels at ${size.width}px`, async ({
    page,
    request,
    context,
  }, testInfo) => {
    test.setTimeout(240000);
    const { client, raw, call } = await connect(request);
    const original = await call<Project>('project_get');
    let project = await call<Project>('project_import', { project: fixture() });
    let second: Page | undefined;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const observations: unknown[] = [];
    try {
      const previous = new Set((await call<Session[]>('workspace_list')).map((item) => item.id));
      await page.setViewportSize(size);
      await page.goto('/');
      await expect(page.getByRole('button', { name: project.name, exact: true })).toBeVisible();
      let workspaceId = '';
      await expect
        .poll(async () => {
          const found = (await call<Session[]>('workspace_list')).find(
            (item) =>
              !previous.has(item.id) &&
              item.connected &&
              item.state.projectId === project.id &&
              !item.state.viewport.loading,
          );
          workspaceId = found?.id ?? '';
          return workspaceId;
        })
        .not.toBe('');
      const guard = () => ({ workspaceId, projectId: project.id, expectedRevision: project.revision });
      const get = () => call<WorkspaceState>('workspace_get', guard());
      const apply = async (command: WorkspaceCommand, requestId = randomUUID()) => {
        const state = await call<WorkspaceState>('workspace_apply', { ...guard(), requestId, command });
        observations.push({ command, state });
        return state;
      };
      const capture = async (overlays: boolean) => {
        const result = await raw('viewport_capture', { ...guard(), overlays });
        expect(result.isError).not.toBe(true);
        const image = (result.content as ToolContent[]).find((item) => item.type === 'image')?.data;
        expect(image).toBeTruthy();
        const pixels = await imagePixels(page, image!);
        expect(pixels.colors).toBeGreaterThan(80);
        return image!;
      };
      await apply({ type: 'selection', ids: ['cube'] });
      expect((await get()).selection).toEqual(['cube']);
      if (size.width === 390) await apply({ type: 'panels', mobilePanel: 'right' });
      await expect(page.getByLabel('对象名称', { exact: true })).toHaveValue('Workspace cube');
      await apply({ type: 'panels', inspectorMode: 'keyframe' });
      expect((await get()).panels.inspectorMode).toBe('keyframe');
      await apply({ type: 'panels', mobilePanel: null, inspectorMode: 'base' });
      await apply({ type: 'selection', ids: ['actor'], mode: 'add' });
      expect((await get()).selection).toEqual(['cube', 'actor']);
      await apply({ type: 'selection', ids: ['actor'], mode: 'remove' });
      expect((await get()).selection).toEqual(['cube']);
      await apply({ type: 'settings', tool: 'rotate', snap: true, helpers: false, safeFrame: false });
      expect((await get()).settings).toEqual({
        tool: 'rotate',
        snap: true,
        helpers: false,
        safeFrame: false,
      });
      await apply({ type: 'observation', view: 'edit', position: [7, 5, 8], target: [0, 1, 0], fov: 52 });
      const editImage = await capture(false);
      const actualCanvas = await page
        .locator('[data-testid="stage"] canvas')
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL('image/png').split(',')[1]);
      expect(editImage).toBe(actualCanvas);
      const camera = (await get()).observation.edit;
      expect(camera.fov).toBe(52);
      expect(camera.position[0]).toBeCloseTo(7, 6);
      await apply({ type: 'observation', pan: [0.5, 0, 0], orbit: { azimuth: 55, polar: 65 }, dolly: 1.1 });
      expect(await capture(false)).not.toBe(editImage);
      await apply({ type: 'view', mode: 'top' });
      await apply({ type: 'focus', ids: ['cube', 'actor'] });
      const top = await get();
      expect(top.view).toBe('top');
      expect(top.observation.top.zoom).toBeGreaterThan(0);
      expect(await capture(false)).not.toBe(editImage);
      const savedTop = top.observation.top;
      await apply({ type: 'view', mode: 'edit' });
      await apply({ type: 'view', mode: 'top' });
      const restoredTop = (await get()).observation.top;
      restoredTop.position.forEach((value, index) => expect(value).toBeCloseTo(savedTop.position[index], 9));
      restoredTop.target.forEach((value, index) => expect(value).toBeCloseTo(savedTop.target[index], 9));
      expect(restoredTop.zoom).toBeCloseTo(savedTop.zoom, 9);
      await apply({ type: 'view', mode: 'camera' });
      await apply({ type: 'settings', safeFrame: true });
      expect(await capture(true)).not.toBe(await capture(false));
      await apply({ type: 'transport', time: 0.5 });
      let state = await apply({ type: 'transport', stepFrames: 1 });
      expect(state.transport.time).toBeCloseTo(0.5 + 1 / 24, 6);
      expect(state.transport.sourceTime).toBeCloseTo(state.transport.time, 6);
      const inspection = await call<ViewportInspection & { state: WorkspaceState }>('viewport_inspect', {
        ...guard(),
        objectIds: ['actor', 'cube'],
      });
      expect(inspection.objects).toHaveLength(2);
      expect(inspection.constraints.find((item) => item.objectId === 'actor')!.results[0].id).toBe('contact');
      expect(inspection.objects.find((item) => item.id === 'cube')!.worldPosition[0]).toBeGreaterThan(1);
      await apply({ type: 'transport', muted: true, loop: true, action: 'play' });
      await expect.poll(async () => (await get()).transport.time).toBeGreaterThan(0.7);
      state = await apply({ type: 'transport', action: 'pause', loop: false });
      expect(state.transport.playing).toBe(false);
      expect(state.transport.muted).toBe(true);
      state = await apply({ type: 'clip', clipId: 'clip-b' });
      expect(state.transport.time).toBe(1);
      expect(state.selection).toEqual(['camera-b']);
      expect(state.panels.inspectorTab).toBe('shot');
      await apply({ type: 'panels', mobilePanel: null });
      await page.screenshot({ path: testInfo.outputPath('workspace.png') });
      await apply({
        type: 'comparison',
        leftSequenceId: project.activeSequenceId,
        rightSequenceId: 'alternate',
        time: 1.2,
      });
      state = await get();
      expect(state.comparison?.time).toBe(1.2);
      await expect(page.locator('[data-testid="compare-B"]')).toContainText('末帧');
      state = await apply({ type: 'comparison', swap: true, time: 0, action: 'play' });
      expect(state.comparison?.leftSequenceId).toBe('alternate');
      await expect.poll(async () => (await get()).comparison!.time).toBeGreaterThan(0.1);
      await apply({ type: 'comparison', action: 'pause', time: 0.5 });
      await page.screenshot({ path: testInfo.outputPath('comparison.png') });
      await apply({ type: 'dialog', name: null });
      await apply({ type: 'cut_review', time: 1.1, checked: ['eyeline', 'props'] });
      expect((await get()).cutReview).toEqual({ time: 1, checked: ['eyeline', 'props'] });
      await expect(page.getByLabel('注视方向', { exact: true })).toBeChecked();
      await page.getByLabel('动作阶段', { exact: true }).check();
      expect((await get()).cutReview?.checked).toContain('action');
      await apply({ type: 'dialog', name: null });
      await page.getByRole('button', { name: '自由视角', exact: true }).click();
      expect((await get()).view).toBe('edit');
      if (size.width === 390) await apply({ type: 'panels', mobilePanel: 'left' });
      await page.getByRole('button', { name: 'Workspace actor', exact: true }).click();
      expect((await get()).selection).toEqual(['actor']);
      await apply({ type: 'panels', mobilePanel: null });
      const canvasBounds = await page.locator('[data-testid="stage"] canvas').boundingBox();
      await page.mouse.move(
        canvasBounds!.x + canvasBounds!.width / 2,
        canvasBounds!.y + canvasBounds!.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        canvasBounds!.x + canvasBounds!.width / 2 + 45,
        canvasBounds!.y + canvasBounds!.height / 2 + 15,
        { steps: 8 },
      );
      await page.mouse.up();
      const userView = (await get()).observation.edit;
      const savedCameras = structuredClone(project.cameras);
      const savedView = await call<CommandResponse>('camera_update', {
        id: 'camera-a',
        patch: userView,
        projectId: project.id,
        expectedRevision: project.revision,
        requestId: randomUUID(),
      });
      project = savedView.project;
      expect(project.cameras.find((item) => item.id === 'camera-a')).toMatchObject(userView);
      await expect
        .poll(
          async () =>
            (await call<Session[]>('workspace_list')).find((item) => item.id === workspaceId)?.state
              .projectRevision,
        )
        .toBe(project.revision);
      project = await call<Project>('history_undo', {
        projectId: project.id,
        expectedRevision: project.revision,
      });
      expect(project.cameras).toEqual(savedCameras);
      await expect
        .poll(
          async () =>
            (await call<Session[]>('workspace_list')).find((item) => item.id === workspaceId)?.state
              .projectRevision,
        )
        .toBe(project.revision);
      const stale = await get();
      await apply({ type: 'settings', snap: false });
      const conflict = await raw('workspace_apply', {
        ...guard(),
        expectedWorkspaceRevision: stale.revision,
        requestId: randomUUID(),
        command: { type: 'selection', ids: [] },
      });
      expect(conflict.isError).toBe(true);
      expect((await get()).selection).toEqual(['actor']);
      const bad = await raw('workspace_apply', {
        ...guard(),
        requestId: randomUUID(),
        command: { type: 'selection', ids: ['absent'] },
      });
      expect(bad.isError).toBe(true);
      const requestId = randomUUID();
      const originalResult = await apply({ type: 'transport', stepFrames: 1 }, requestId);
      const replay = await apply({ type: 'transport', stepFrames: 1 }, requestId);
      expect(replay).toEqual(originalResult);
      const beforeSecond = new Set((await call<Session[]>('workspace_list')).map((item) => item.id));
      second = await context.newPage();
      await second.goto('/');
      let secondId = '';
      await expect
        .poll(async () => {
          secondId =
            (await call<Session[]>('workspace_list')).find(
              (item) => !beforeSecond.has(item.id) && item.connected && !item.state.viewport.loading,
            )?.id ?? '';
          return secondId;
        })
        .not.toBe('');
      await apply({ type: 'selection', ids: ['cube'] });
      const other = await call<WorkspaceState>('workspace_get', { ...guard(), workspaceId: secondId });
      expect(other.selection).toEqual([]);
      expect((await get()).selection).toEqual(['cube']);
      await second.close();
      second = undefined;
      await expect
        .poll(
          async () =>
            (await call<Session[]>('workspace_list')).find((item) => item.id === secondId)?.connected,
        )
        .toBe(false);
      const beforeReload = workspaceId;
      const reloadIds = new Set((await call<Session[]>('workspace_list')).map((item) => item.id));
      await page.reload();
      await expect
        .poll(async () => {
          workspaceId =
            (await call<Session[]>('workspace_list')).find(
              (item) => !reloadIds.has(item.id) && item.connected && !item.state.viewport.loading,
            )?.id ?? '';
          return workspaceId;
        })
        .not.toBe('');
      expect((await get()).selection).toEqual([]);
      expect(
        (await call<Session[]>('workspace_list')).find((item) => item.id === beforeReload)?.connected,
      ).toBe(false);
      const beforeReconnect = workspaceId;
      const reconnectIds = new Set((await call<Session[]>('workspace_list')).map((item) => item.id));
      await page.route(
        '**/api/workspaces/*/state',
        (route) =>
          route.fulfill({
            status: 404,
            json: { error: { code: 'WORKSPACE_NOT_FOUND', message: 'Registry restart test' } },
          }),
        { times: 1 },
      );
      await expect
        .poll(async () => {
          workspaceId =
            (await call<Session[]>('workspace_list')).find(
              (item) => !reconnectIds.has(item.id) && item.connected && !item.state.viewport.loading,
            )?.id ?? '';
          return workspaceId;
        })
        .not.toBe('');
      expect(
        (await call<Session[]>('workspace_list')).find((item) => item.id === beforeReconnect)?.connected,
      ).toBe(false);
      expect(
        (await call<Session[]>('workspace_list')).filter(
          (item) => item.connected && item.state.projectId === project.id,
        ),
      ).toHaveLength(1);
      expect((await get()).projectRevision).toBe(project.revision);
      const job = await call<RenderJob>('render_start', {
        projectId: project.id,
        expectedRevision: project.revision,
        sequenceId: project.activeSequenceId,
        resolution: 720,
        fps: 12,
        includeAudio: false,
        requestId: randomUUID(),
      });
      await expect
        .poll(async () => (await call<RenderJob>('render_status', { id: job.id })).status, {
          timeout: 120000,
        })
        .toBe('completed');
      await apply({ type: 'video', jobId: job.id, action: 'open' });
      state = await apply({
        type: 'video',
        action: 'pause',
        time: 0.5,
        muted: true,
        volume: 0.4,
        playbackRate: 0.5,
      });
      expect(state.media?.jobId).toBe(job.id);
      expect(state.media?.time).toBeCloseTo(0.5, 1);
      expect(state.media?.paused).toBe(true);
      expect(state.media?.volume).toBe(0.4);
      const fullscreen = await raw('workspace_apply', {
        ...guard(),
        requestId: randomUUID(),
        command: { type: 'fullscreen', enabled: true, target: 'video' },
      });
      if (fullscreen.isError) {
        expect(
          JSON.parse((fullscreen.content as ToolContent[]).find((item) => item.type === 'text')!.text!).error
            .code,
        ).toBe('FULLSCREEN_REJECTED');
        expect((await get()).fullscreen).toBe(false);
      } else {
        expect((await get()).fullscreenTarget).toBe('video');
        await apply({ type: 'fullscreen', enabled: false, target: 'video' });
      }
      const video = page.getByLabel('已导出白模视频', { exact: true });
      expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(
        state.media!.time,
        5,
      );
      await apply({ type: 'video', action: 'play' });
      await expect.poll(async () => (await get()).media!.time).toBeGreaterThan(0.65);
      await apply({ type: 'video', action: 'pause' });
      await page.screenshot({ path: testInfo.outputPath('video.png') });
      await apply({ type: 'video', action: 'close' });
      expect((await get()).media).toBeNull();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await call<Project>('project_get')).toEqual(project);
      const replacement = await call<Project>('project_new', {
        name: 'Workspace context switch',
        template: 'empty',
      });
      await expect(page.getByRole('button', { name: replacement.name, exact: true })).toBeVisible();
      const wrongProject = await raw('workspace_apply', {
        ...guard(),
        requestId: randomUUID(),
        command: { type: 'selection', ids: [] },
      });
      expect(wrongProject.isError).toBe(true);
      expect(errors).toEqual([]);
      await writeFile(testInfo.outputPath('workspace-evidence.json'), JSON.stringify(observations, null, 2));
    } finally {
      await second?.close();
      await call('project_open', { id: original.id });
      await client.close();
    }
  });
}
