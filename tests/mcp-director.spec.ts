import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';
import { createObject } from '../shared/project';
import type {
  Command,
  CommandResponse,
  Project,
  RenderJob,
  SceneObject,
  Sequence,
  ShotCamera,
  Vec3,
} from '../shared/types';

const runFile = promisify(execFile);
const apiUrl = 'http://127.0.0.1:4180';

test('MCP director builds, previews, revises, restores and exports a ten-second white-model scene', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const connectionResponse = await request.get(`${apiUrl}/api/connection`);
  expect(connectionResponse.ok()).toBeTruthy();
  const connection = (await connectionResponse.json()) as { url: string; token: string };
  expect(new URL(connection.url).port).toBe('4180');
  const client = new Client({ name: 'director-acceptance', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  });
  let originalProjectId: string | undefined;
  let renderId: string | undefined;
  let renderFinished = false;
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-director-'));
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));

  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return test.step(`MCP ${name}`, async () => {
      try {
        const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
        const content = response.content as { type: string; text?: string }[];
        const text = content.find((item) => item.type === 'text')?.text;
        if (response.isError || !text) throw new Error(text ?? 'Missing JSON response');
        return JSON.parse(text) as T;
      } catch (error) {
        throw new Error(`MCP ${name}: ${(error as Error).message}`, { cause: error });
      }
    });
  }

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'project_new',
        'edit_batch',
        'scene_inspect',
        'preview_capture',
        'render_start',
        'render_status',
      ]),
    );
    originalProjectId = (await call<Project>('project_get')).id;
    const fresh = await call<Project>('project_new', { name: '导演闭环验收', template: 'empty' });
    expect(fresh.objects).toHaveLength(0);
    await page.goto('/');
    await expect(page.getByRole('button', { name: '导演闭环验收', exact: true })).toBeVisible({
      timeout: 30_000,
    });

    const objects: SceneObject[] = [];
    const addObject = (
      type: SceneObject['type'],
      id: string,
      name: string,
      position: Vec3,
      patch: Partial<SceneObject> = {},
    ) => {
      const object: SceneObject = { ...createObject(type, name), id, position, ...patch };
      objects.push(object);
      return object;
    };
    addObject('plane', 'accept-floor', '验收客厅地面', [0, -0.05, 0], { dimensions: [8, 0.05, 7] });
    addObject('wall', 'accept-wall', '验收后墙', [0, 0, -3], { dimensions: [8, 3, 0.15] });
    addObject('sofa', 'accept-sofa', '验收沙发', [0.2, 0, -2]);
    addObject('table', 'accept-table', '验收茶几', [0.2, 0, -0.95], { dimensions: [1.4, 0.45, 0.65] });
    const actorA = addObject('actor', 'accept-a', '验收 A', [-2.4, 0, 0.8], { rotation: [0, 100, 0] });
    actorA.actor!.lookAtId = 'accept-b';
    actorA.keyframes = [
      { id: 'accept-a-enter', time: 0, position: [-2.4, 0, 0.8], action: 'walk' },
      { id: 'accept-a-arrive', time: 2.2, position: [-0.7, 0, 0.2], action: 'idle', easing: 'smooth' },
      { id: 'accept-a-talk', time: 2.4, action: 'talk', pose: { rightArm: -25 } },
      { id: 'accept-a-stop', time: 4.5, action: 'idle', pose: { rightArm: 0 } },
    ];
    const actorB = addObject('actor', 'accept-b', '验收 B', [0.8, 0, 0], {
      rotation: [0, -80, 0],
      tone: '#adb4b4',
    });
    actorB.actor!.pose.headPitch = 20;
    actorB.actor!.pose.rightArm = -25;
    actorB.keyframes = [
      { id: 'accept-b-down', time: 0, pose: { headPitch: 20 }, lookAtId: null },
      { id: 'accept-b-hold', time: 5, pose: { headPitch: 20 }, lookAtId: null },
      { id: 'accept-b-look', time: 5.6, pose: { headPitch: 0 }, lookAtId: 'accept-a', easing: 'smooth' },
      { id: 'accept-b-phone', time: 7, pose: { rightArm: -25 } },
      { id: 'accept-b-reveal', time: 8.2, pose: { rightArm: -65 }, easing: 'smooth' },
    ];
    addObject('phone', 'accept-phone', '验收手机', [0, 0, 0], {
      rotation: [65, 0, 0],
      tone: '#565d60',
      attachment: { objectId: 'accept-b', bone: 'rightHand', offset: [0, -0.015, 0.045] },
    });
    const cameras: ShotCamera[] = [
      {
        id: 'accept-wide',
        name: '验收全景机位',
        position: [-4.6, 3, 6.8],
        target: [-1, 1, 0.15],
        fov: 46,
        locked: false,
        keyframes: [],
      },
      {
        id: 'accept-reaction',
        name: '验收反应机位',
        position: [-1.7, 1.62, 0.95],
        target: [0.8, 1.22, 0],
        fov: 32,
        locked: false,
        keyframes: [
          {
            id: 'accept-reaction-in',
            time: 3.5,
            position: [-1.7, 1.62, 0.95],
            target: [0.8, 1.22, 0],
            fov: 32,
            easing: 'linear',
          },
          {
            id: 'accept-reaction-out',
            time: 7,
            position: [-1.55, 1.6, 0.9],
            target: [0.8, 1.22, 0],
            fov: 32,
            easing: 'smooth',
          },
        ],
      },
      {
        id: 'accept-reveal',
        name: '验收揭示机位',
        position: [-0.9, 1.25, 1.9],
        target: [0.45, 1.05, -0.15],
        fov: 36,
        locked: false,
        keyframes: [
          {
            id: 'accept-reveal-in',
            time: 7,
            position: [-0.9, 1.25, 1.9],
            target: [0.45, 1.05, -0.15],
            fov: 36,
            easing: 'linear',
          },
          {
            id: 'accept-reveal-out',
            time: 10,
            position: [-0.65, 1.25, 1.4],
            target: [0.35, 1.2, -0.15],
            fov: 32,
            easing: 'smooth',
          },
        ],
      },
    ];
    const intervals = [
      [0, 3.5],
      [3.5, 7],
      [7, 10],
    ] as const;
    const commands: Command[] = [
      {
        type: 'project.settings',
        payload: { fps: 24, aspect: '9:16', resolution: 720, axisActorIds: ['accept-a', 'accept-b'] },
      },
      ...objects.map((object) => ({ type: 'object.create', payload: { ...object } })),
      ...cameras.map((camera) => ({ type: 'camera.create', payload: { ...camera } })),
      {
        type: 'beat.create',
        payload: {
          id: 'accept-dialogue',
          label: '质问',
          time: 2.4,
          endTime: 4.5,
          kind: 'dialogue',
          actorId: 'accept-a',
          text: '昨晚为什么不接我的电话？',
        },
      },
      {
        type: 'beat.create',
        payload: {
          id: 'accept-pause',
          label: '停顿十二帧',
          time: 4.5,
          endTime: 5,
          kind: 'pause',
          actorId: 'accept-b',
        },
      },
      {
        type: 'beat.create',
        payload: {
          id: 'accept-reaction-beat',
          label: '抬头反应',
          time: 5,
          endTime: 5.6,
          kind: 'reaction',
          actorId: 'accept-b',
        },
      },
      {
        type: 'beat.create',
        payload: {
          id: 'accept-reveal-beat',
          label: '揭示手机',
          time: 7,
          endTime: 8.2,
          kind: 'reveal',
          actorId: 'accept-b',
        },
      },
      ...cameras.map((camera, index) => ({
        type: 'shot.create',
        payload: {
          id: `accept-shot-${index}`,
          name: ['验收 01 全景', '验收 02 反应', '验收 03 揭示'][index],
          cameraId: camera.id,
          sourceIn: intervals[index]![0],
          sourceOut: intervals[index]![1],
          subjectIds: index === 0 ? ['accept-a', 'accept-b'] : ['accept-b'],
          hiddenIds: index < 2 ? ['accept-phone'] : [],
          intent: ['建立人物关系', '对白结束后停顿半秒再抬头', '保持表演连续并揭示手机'][index],
        },
      })),
      {
        type: 'sequence.update',
        payload: {
          id: fresh.activeSequenceId,
          patch: {
            name: '验收方案 A',
            clips: cameras.map((_camera, index) => ({
              id: `accept-clip-${index}`,
              shotId: `accept-shot-${index}`,
              sourceIn: intervals[index]![0],
              sourceOut: intervals[index]![1],
            })),
          },
        },
      },
    ];
    const assembled = await call<CommandResponse>('edit_batch', {
      commands,
      expectedRevision: fresh.revision,
      requestId: randomUUID(),
    });
    expect(assembled.project.revision).toBe(fresh.revision + 1);
    await expect(page.getByRole('button', { name: '验收 A', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.shot-card')).toHaveCount(3);
    const pause = assembled.project.beats.find((beat) => beat.id === 'accept-pause')!;
    expect((pause.endTime - pause.time) * assembled.project.settings.fps).toBe(12);
    const held = await call<{ objects: SceneObject[] }>('scene_inspect', { time: 4.99 });
    expect(held.objects.find((object) => object.id === 'accept-b')!.actor!.pose.headPitch).toBe(20);
    const reacted = await call<{ objects: SceneObject[] }>('scene_inspect', { time: 5.6 });
    expect(reacted.objects.find((object) => object.id === 'accept-b')!.actor!.pose.headPitch).toBe(0);

    const duplicateResponse = await call<CommandResponse>('sequence_duplicate', {
      id: fresh.activeSequenceId,
      newId: 'accept-alternate',
      name: '验收方案 B',
      expectedRevision: assembled.project.revision,
    });
    const alternate = duplicateResponse.results[0] as Sequence;
    const alternateShot = duplicateResponse.project.shots.find(
      (shot) => shot.id === alternate.clips[2]!.shotId,
    )!;
    expect(alternateShot.cameraId).not.toBe('accept-reveal');
    await call('project_update', {
      activeSequenceId: alternate.id,
      expectedRevision: duplicateResponse.project.revision,
    });
    await expect(page.getByRole('combobox', { name: '剪辑方案' })).toHaveValue(alternate.id);
    await page.locator('.shot-card').nth(2).click();
    await page.getByRole('button', { name: '当前帧', exact: true }).click();
    const fov = page.getByRole('spinbutton', { name: '视场角 °', exact: true });
    await fov.fill('40');
    await fov.press('Enter');
    await expect
      .poll(
        async () => {
          const project = await call<Project>('project_get');
          return project.cameras
            .find((camera) => camera.id === alternateShot.cameraId)
            ?.keyframes.find((frame) => frame.time === 7)?.fov;
        },
        { timeout: 30_000 },
      )
      .toBe(40);
    let edited = await call<Project>('project_get');
    edited = (
      await call<CommandResponse>('edit_batch', {
        expectedRevision: edited.revision,
        commands: [
          { type: 'object.update', payload: { id: 'accept-a', patch: { locked: true } } },
          { type: 'object.update', payload: { id: 'accept-b', patch: { locked: true } } },
        ],
      })
    ).project;
    const lockedObjects = structuredClone(edited.objects);
    const forbidden = await client.callTool({
      name: 'object_keyframe_set',
      arguments: {
        id: 'accept-a',
        keyframe: { time: 1, position: [99, 0, 0] },
        expectedRevision: edited.revision,
      },
    });
    expect(forbidden.isError).toBe(true);
    expect((await call<Project>('project_get')).revision).toBe(edited.revision);
    const lastCamera = edited.cameras.find((camera) => camera.id === alternateShot.cameraId)!;
    const changed = await call<CommandResponse>('camera_update', {
      id: lastCamera.id,
      expectedRevision: edited.revision,
      patch: { keyframes: lastCamera.keyframes.map((frame) => ({ ...frame, fov: frame.fov + 2 })) },
    });
    expect(changed.project.objects).toEqual(lockedObjects);
    expect(changed.project.cameras.filter((camera) => camera.id !== lastCamera.id)).toEqual(
      edited.cameras.filter((camera) => camera.id !== lastCamera.id),
    );
    const restored = await call<CommandResponse>('project_update', {
      activeSequenceId: fresh.activeSequenceId,
      expectedRevision: changed.project.revision,
    });
    expect(restored.project.cameras.find((camera) => camera.id === 'accept-reveal')).toEqual(cameras[2]);
    await expect(page.getByRole('combobox', { name: '剪辑方案' })).toHaveValue(fresh.activeSequenceId);

    const previews: string[] = [];
    for (const time of [0, 9.5]) {
      const preview = await test.step(`MCP preview_capture at ${time}s`, () =>
        client.callTool(
          { name: 'preview_capture', arguments: { time, width: 360, height: 640 } },
          undefined,
          { timeout: 90_000 },
        ));
      expect(preview.isError).not.toBe(true);
      const image = (preview.content as { type: string; mimeType?: string; data?: string }[]).find(
        (content) => content.type === 'image',
      );
      expect(image?.mimeType).toBe('image/png');
      const buffer = Buffer.from(image!.data!, 'base64');
      expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(buffer.readUInt32BE(16)).toBe(360);
      expect(buffer.readUInt32BE(20)).toBe(640);
      expect(buffer.length).toBeGreaterThan(10_000);
      previews.push(image!.data!);
      await testInfo.attach(`director-preview-${time}`, { body: buffer, contentType: 'image/png' });
      const colors = await page.evaluate(async (data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const unique = new Set<number>();
        for (let index = 0; index < pixels.length; index += 16)
          unique.add(
            (pixels[index]! >> 3) * 1024 + (pixels[index + 1]! >> 3) * 32 + (pixels[index + 2]! >> 3),
          );
        return unique.size;
      }, image!.data!);
      expect(colors).toBeGreaterThan(50);
    }
    expect(previews[0]).not.toBe(previews[1]);

    const job = await call<RenderJob>('render_start', {
      sequenceId: fresh.activeSequenceId,
      fps: 24,
      resolution: 720,
      aspect: '9:16',
      includeAudio: false,
      burnIn: false,
      requestId: randomUUID(),
    });
    renderId = job.id;
    expect(job.totalFrames).toBe(240);
    expect(job.projectRevision).toBe(restored.project.revision);
    let completed: RenderJob & { downloadUrl?: string } = job;
    await expect
      .poll(
        async () => {
          completed = await call<RenderJob & { downloadUrl?: string }>('render_status', { id: job.id });
          if (completed.status === 'failed' || completed.status === 'cancelled')
            throw new Error(completed.error ?? `Export ${completed.status}`);
          return completed.status;
        },
        { timeout: 150_000, intervals: [250, 500, 1000, 1500] },
      )
      .toBe('completed');
    renderFinished = true;
    expect(completed.frame).toBe(240);
    expect(completed.downloadUrl).toBeTruthy();
    const video = await request.get(completed.downloadUrl!);
    expect(video.ok(), `Video download returned HTTP ${video.status()}`).toBeTruthy();
    const videoPath = join(directory, 'director.mp4');
    await writeFile(videoPath, await video.body());
    const probe = await runFile('ffprobe', [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      videoPath,
    ]);
    const metadata = JSON.parse(probe.stdout) as {
      streams: {
        codec_type: string;
        codec_name: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        nb_frames?: string;
      }[];
      format: { duration: string };
    };
    const stream = metadata.streams.find((item) => item.codec_type === 'video')!;
    expect(stream.codec_name).toBe('h264');
    expect([stream.width, stream.height]).toEqual([720, 1280]);
    expect(stream.avg_frame_rate).toBe('24/1');
    expect(Number(stream.nb_frames)).toBe(240);
    expect(Number(metadata.format.duration)).toBeCloseTo(10, 2);
    expect(metadata.streams.some((item) => item.codec_type === 'audio')).toBe(false);
    await testInfo.attach('director-export-metadata', {
      body: probe.stdout,
      contentType: 'application/json',
    });
    expect(browserErrors).toEqual([]);
  } finally {
    if (renderId && !renderFinished) await call('render_cancel', { id: renderId }).catch(() => undefined);
    if (originalProjectId) await call('project_open', { id: originalProjectId }).catch(() => undefined);
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
