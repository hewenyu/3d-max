import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../server/app';
import { createEmptyProject, createObject } from '../shared/project';
import { actorAnimationSchema } from '../shared/actor-animation';
import { productionRenderFixture } from './fixtures/production-render';
import type { RenderService } from '../server/render';

type Capture = Awaited<ReturnType<RenderService['viewport']>>;
type Contacts = Awaited<ReturnType<RenderService['inspectConstraints']>>;

function toolValue<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const content = result.content.find((item) => item.type === 'text');
  if (content?.type !== 'text') throw new Error('MCP result omitted JSON');
  return JSON.parse(content.text) as T;
}

async function harness(appUrl: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'whiteframe-headless-viewport-'));
  const config = {
    port: 0,
    dataDir,
    distDir: join(dataDir, 'dist'),
    appUrl,
    apiUrl: 'http://127.0.0.1:1',
    token: 'headless-observation-test',
  };
  const service = createApp(config);
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  config.apiUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const client = new Client({ name: 'headless-observation', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${config.apiUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
    }),
  );
  return {
    ...service,
    client,
    callTool: async (input: Parameters<Client['callTool']>[0]) =>
      CallToolResultSchema.parse(await client.callTool(input)),
    post: (path: string, input: unknown) =>
      fetch(`${config.apiUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    async close() {
      await client.close();
      await service.close();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function contactProject() {
  const project = createEmptyProject('Headless director observation');
  project.settings.aspect = '16:9';
  const actor = createObject('actor', 'Performer');
  actor.id = 'performer';
  actor.actor!.animation = actorAnimationSchema.parse({
    constraints: [
      {
        id: 'touch',
        effector: 'rightHand',
        start: 0,
        end: 2,
        target: { kind: 'object', objectId: 'target', offset: [0.1, 0, 0] },
        tolerance: 0.025,
      },
      {
        id: 'unreachable',
        effector: 'leftHand',
        start: 0,
        end: 2,
        target: { kind: 'world', position: [20, 2, 0] },
        tolerance: 0.025,
      },
      {
        id: 'later',
        effector: 'rightFoot',
        start: 3,
        end: 4,
        target: { kind: 'world', position: [0, 0, 0] },
        tolerance: 0.025,
      },
    ],
  });
  const target = createObject('sphere', 'Contact point');
  target.id = 'target';
  target.position = [-0.3, 1.2, 0.25];
  target.rotation = [0, 90, 0];
  target.dimensions = [0.09, 0.09, 0.09];
  const moving = createObject('box', 'Moving marker');
  moving.id = 'moving';
  moving.position = [1, 0, 0];
  moving.dimensions = [0.3, 0.6, 0.3];
  moving.keyframes = [
    { id: 'start', time: 0, position: [1, 0, 0] },
    { id: 'end', time: 4, position: [2.5, 0, 0], easing: 'linear' },
  ];
  project.objects = [actor, target, moving];
  project.cameras = [
    {
      id: 'camera',
      name: 'Contact view',
      position: [4, 3, 6],
      target: [0, 1, 0],
      fov: 45,
      locked: false,
      keyframes: [],
    },
  ];
  project.shots = [
    {
      id: 'shot',
      name: 'Contact',
      cameraId: 'camera',
      sourceIn: 0,
      sourceOut: 4,
      intent: '',
      subjectIds: [actor.id],
      hiddenIds: [],
      beatId: null,
      locked: false,
    },
  ];
  project.sequences[0].clips = [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 4 }];
  return project;
}

async function inspectPixels(page: Page, first: string, second?: string) {
  return page.evaluate(
    async ({ first, second }) => {
      const read = async (url: string) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return {
          width: image.width,
          height: image.height,
          pixels: context.getImageData(0, 0, image.width, image.height).data,
        };
      };
      const left = await read(first);
      const right = second ? await read(second) : undefined;
      const colors = new Set<number>();
      let changed = 0;
      for (let index = 0; index < left.pixels.length; index += 4) {
        colors.add((left.pixels[index] << 16) | (left.pixels[index + 1] << 8) | left.pixels[index + 2]);
        if (
          right &&
          [0, 1, 2].some(
            (channel) => Math.abs(left.pixels[index + channel] - right.pixels[index + channel]) > 4,
          )
        )
          changed++;
      }
      return { width: left.width, height: left.height, colors: colors.size, changed };
    },
    { first, second },
  );
}

test('HTTP and MCP capture headless moving observation views and actual contact solver states', async ({
  page,
  baseURL,
}) => {
  const work = await harness(baseURL!);
  try {
    const project = work.store.importProject(contactProject());
    const identity = { projectId: project.id, expectedRevision: project.revision };
    expect(toolValue<unknown[]>(await work.callTool({ name: 'workspace_list', arguments: {} }))).toEqual([]);
    const input = {
      ...identity,
      context: { kind: 'source', sourceTime: 1 },
      view: 'edit',
      width: 640,
      height: 360,
      observation: { position: [4, 3, 6], target: [0.4, 1, 0], fov: 45 },
    };
    const response = await work.post('/api/viewport', input);
    expect(response.status).toBe(200);
    const first = (await response.json()) as Capture;
    expect(first.context.sourceTime).toBe(1);
    expect(first.observation.edit.position[0]).toBeCloseTo(4);
    first.observation.edit.target.forEach((value, index) => expect(value).toBeCloseTo([0.4, 1, 0][index]));
    const contacts = first.inspection.constraints.find((item) => item.objectId === 'performer')!.results;
    expect(contacts.map((item) => item.status)).toEqual(['solved', 'unreachable', 'inactive']);
    expect(contacts[0].error).toBeLessThan(0.025);
    expect(contacts[0].target![0]).toBeCloseTo(-0.3);
    expect(contacts[0].target![2]).toBeCloseTo(0.15);
    expect(contacts[1].error).toBeGreaterThan(10);
    expect(contacts[2].weight).toBe(0);
    const mcpCapture = await work.callTool({ name: 'scene_view_capture', arguments: input });
    const metadata = toolValue<Omit<Capture, 'dataUrl'>>(mcpCapture);
    expect(metadata.inspection.constraints).toEqual(first.inspection.constraints);
    const image = mcpCapture.content.find((item) => item.type === 'image');
    if (image?.type !== 'image') throw new Error('MCP omitted PNG image');
    expect(`data:image/png;base64,${image.data}`).toBe(first.dataUrl);
    const second = await work.render.viewport({ ...input, context: { kind: 'source', sourceTime: 1.8 } });
    const pixels = await inspectPixels(page, first.dataUrl!, second.dataUrl);
    expect(pixels).toMatchObject({ width: 640, height: 360 });
    expect(pixels.colors).toBeGreaterThan(100);
    expect(pixels.changed).toBeGreaterThan(100);
    await page.goto(first.dataUrl!);
    await page.screenshot({ path: 'test-results/headless-observation-desktop.png' });

    const inspectInput = {
      ...identity,
      context: { kind: 'source', sourceTime: 1 },
      objectIds: ['performer'],
    };
    const inspectedHttp = await work.post('/api/constraints/inspect', inspectInput);
    expect(inspectedHttp.status).toBe(200);
    const inspected = (await inspectedHttp.json()) as Contacts;
    expect(inspected.constraints).toEqual(first.inspection.constraints);
    expect(
      toolValue<Contacts>(
        await work.callTool({ name: 'contact_constraints_inspect', arguments: inspectInput }),
      ),
    ).toEqual(inspected);
    const later = await work.render.inspectConstraints({
      ...identity,
      context: { kind: 'source', sourceTime: 2.5 },
    });
    expect(later.constraints[0].results.every((item) => item.status === 'inactive')).toBe(true);

    const top = await work.render.viewport({
      ...input,
      view: 'top',
      width: 390,
      height: 844,
      observation: { target: [0.8, 0, 0], zoom: 2 },
      helpers: true,
    });
    const topPixels = await inspectPixels(page, top.dataUrl!);
    expect(topPixels).toMatchObject({ width: 390, height: 844 });
    expect(topPixels.colors).toBeGreaterThan(100);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(top.dataUrl!);
    await page.screenshot({ path: 'test-results/headless-observation-top-mobile.png' });
    const cameraInput = {
      ...identity,
      view: 'camera',
      context: { kind: 'shot', shotId: 'shot', time: 1 },
      width: 640,
      height: 360,
    };
    const camera = await work.render.viewport(cameraInput);
    const original = await work.render.preview({ shotId: 'shot', time: 1, width: 640, height: 360 });
    expect(camera.dataUrl).toBe(original.dataUrl);
    const overlay = await work.render.viewport({ ...cameraInput, safeFrame: true, overlays: true });
    expect((await inspectPixels(page, camera.dataUrl!, overlay.dataUrl)).changed).toBeGreaterThan(100);
    expect(work.store.project()).toEqual(project);
    expect(toolValue<unknown[]>(await work.callTool({ name: 'workspace_list', arguments: {} }))).toEqual([]);
  } finally {
    await work.close();
  }
});

test('headless views resolve production versions and preserve in-flight snapshots across project switches', async ({
  baseURL,
}) => {
  const work = await harness(baseURL!);
  try {
    const project = work.store.importProject(productionRenderFixture());
    const input = {
      projectId: project.id,
      expectedRevision: project.revision,
      context: { kind: 'sequence', time: 2.5 },
      width: 320,
      height: 180,
    };
    const alternate = await work.render.viewport(input);
    expect(alternate.context.performanceId).toBe('take-alternate');
    expect(alternate.inspection.context.performanceId).toBe('take-alternate');
    expect(
      alternate.inspection.objects.find((item) => item.id === 'shared-actor')!.worldPosition[0],
    ).toBeCloseTo(1.775);
    const pending = work.render.viewport({ ...input, context: { kind: 'shot', shotId: 'shot-3', time: 1 } });
    const replacement = work.store.newProject('Next project', 'empty');
    const captured = await pending;
    expect(captured.projectId).toBe(project.id);
    expect(captured.projectRevision).toBe(project.revision);
    expect(captured.context.sceneId).toBe('scene-second');
    expect(captured.inspection.context.sceneId).toBe('scene-second');
    expect(work.store.project()).toEqual(replacement);
    const conflict = await work.post('/api/viewport', input);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('PROJECT_CONFLICT');
    work.store.openProject(project.id);
    for (const invalid of [
      { ...input, expectedRevision: 99 },
      { ...input, view: 'top', observation: { fov: 45 } },
      { ...input, view: 'edit', observation: { zoom: 2 } },
      { ...input, view: 'camera', observation: { target: [0, 0, 0] } },
      { ...input, objectIds: ['missing'] },
    ]) {
      const http = await work.post('/api/viewport', invalid);
      expect(http.status).toBeGreaterThanOrEqual(400);
      const mcp = await work.callTool({ name: 'scene_view_capture', arguments: invalid });
      expect(mcp.isError).toBe(true);
      const content = mcp.content.find((item) => item.type === 'text');
      if (content?.type !== 'text') throw new Error('MCP error omitted JSON');
      expect(JSON.parse(content.text)).toEqual(await http.json());
    }
    expect(work.store.project()).toEqual(project);
  } finally {
    await work.close();
  }
});
