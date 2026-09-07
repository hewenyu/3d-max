import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FaceAnalysisResult, MorphCatalog } from '../shared/face-analysis';
import type { Project } from '../shared/types';

const exec = promisify(execFile);
function morphAsset() {
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0]);
  const deltas = new Float32Array([0, 0, 0, 0, 0, 0, 0.4, -0.6, 0, -0.4, -0.6, 0]);
  const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
  const data = Buffer.concat([
    Buffer.from(positions.buffer),
    Buffer.from(deltas.buffer),
    Buffer.from(indices.buffer),
  ]);
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'MorphFace', mesh: 0 }],
    buffers: [
      { byteLength: data.length, uri: `data:application/octet-stream;base64,${data.toString('base64')}` },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 48 },
      { buffer: 0, byteOffset: 96, byteLength: 12 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-0.5, 0, 0], max: [0.5, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3', min: [-0.4, -0.6, 0], max: [0.4, 0, 0] },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    meshes: [
      {
        name: 'MorphFace',
        weights: [0],
        extras: { targetNames: ['jawOpen'] },
        primitives: [{ attributes: { POSITION: 0 }, indices: 2, targets: [{ POSITION: 1 }] }],
      },
    ],
  };
}

test('real Chinese audio drives editable face cues through UI/MCP, morph bindings and H264 export', async ({
  page,
  request,
}, testInfo) => {
  const directory = testInfo.outputPath('artifacts');
  await mkdir(directory, { recursive: true });
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'face-acceptance', version: '1.0.0' });
  const errors: string[] = [];
  const journal: unknown[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const call = async <T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    journal.push({ name, arguments: args, isError: Boolean(result.isError) });
    const text = (result.content as { type: string; text?: string }[]).find(
      (item) => item.type === 'text',
    )?.text;
    if (result.isError) throw new Error(`${name}: ${text}`);
    return (text ? JSON.parse(text) : result) as T;
  };
  const number = async (label: string, value: number) => {
    const input = page.getByRole('spinbutton', { name: label, exact: true });
    await input.fill(String(value));
    await input.press('Enter');
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    const catalog = await call('actor_face_catalog');
    expect(catalog.lipsync.available).toBe(true);
    const fresh = await call<Project>('project_new', {
      name: 'Face + Phonetic Lip Sync QA',
      template: 'empty',
    });
    const audio = await call('asset_import', {
      name: '中文对白.wav',
      dataBase64: (await readFile(new URL('./fixtures/face-dialogue-zh.wav', import.meta.url))).toString(
        'base64',
      ),
    });
    const model = await call('asset_import', {
      name: 'morph.gltf',
      dataBase64: Buffer.from(JSON.stringify(morphAsset())).toString('base64'),
    });
    await call('edit_batch', {
      commands: [
        { type: 'project.settings', payload: { fps: 24, resolution: 720, aspect: '16:9' } },
        { type: 'object.create', payload: { id: 'face-actor', type: 'actor', name: '对白角色' } },
        {
          type: 'object.create',
          payload: {
            id: 'morph-model',
            type: 'model',
            name: '形变模型',
            assetUrl: model.url,
            position: [3, 1, 0],
            dimensions: [0.5, 0.5, 0.5],
          },
        },
        {
          type: 'audio.create',
          payload: {
            id: 'dialogue',
            name: '中文对白',
            url: audio.url,
            start: 1,
            sourceIn: 0,
            duration: 5,
            sync: 'source',
          },
        },
        {
          type: 'camera.create',
          payload: {
            id: 'face-camera',
            name: '对白近景',
            position: [0.16, 1.63, 1.25],
            target: [0, 1.62, 0],
            fov: 25,
          },
        },
        {
          type: 'camera.create',
          payload: {
            id: 'morph-camera',
            name: '形变近景',
            position: [3, 1.25, 1.7],
            target: [3, 1.25, 0],
            fov: 30,
          },
        },
        {
          type: 'shot.create',
          payload: {
            id: 'face-shot',
            name: '表情与对白',
            cameraId: 'face-camera',
            sourceIn: 0,
            sourceOut: 8,
            hiddenIds: ['morph-model'],
          },
        },
        {
          type: 'shot.create',
          payload: {
            id: 'morph-shot',
            name: '形变',
            cameraId: 'morph-camera',
            sourceIn: 0,
            sourceOut: 8,
            hiddenIds: ['face-actor'],
          },
        },
        {
          type: 'sequence.update',
          payload: {
            id: fresh.activeSequenceId,
            patch: { clips: [{ id: 'face-edit', shotId: 'face-shot', sourceIn: 0, sourceOut: 8 }] },
          },
        },
        {
          type: 'actor.face.set',
          payload: {
            id: 'face-actor',
            face: {
              base: {},
              keys: [
                { id: 'neutral', time: 0, values: { smile: 0, browDown: 0, jawOpen: 0 } },
                { id: 'happy', time: 2, values: { smile: 0.8, browDown: 0, jawOpen: 0 } },
                { id: 'reaction', time: 4, values: { smile: 0.1, browDown: 0.7 } },
                { id: 'blink-open', time: 6.4, values: { blinkLeft: 0, blinkRight: 0 } },
                { id: 'blink-close', time: 6.55, values: { blinkLeft: 1, blinkRight: 1 } },
                { id: 'blink-end', time: 6.7, values: { blinkLeft: 0, blinkRight: 0 } },
              ],
              clips: [],
            },
          },
        },
      ],
    });
    let project = await call<Project>('project_get');
    const analysis = await call<FaceAnalysisResult>('actor_face_lipsync_analyze', {
      objectId: 'face-actor',
      audioId: 'dialogue',
      recognizer: 'phonetic',
      linkTiming: true,
      projectId: project.id,
      expectedRevision: project.revision,
    });
    expect(analysis.engine).toBe('Rhubarb Lip Sync');
    expect(analysis.clip.cues.length).toBeGreaterThan(8);
    expect(new Set(analysis.clip.cues.map((cue) => cue.viseme)).size).toBeGreaterThan(3);
    expect((await call<Project>('project_get')).revision).toBe(project.revision);
    await call('edit_batch', {
      commands: analysis.commands,
      projectId: analysis.projectId,
      expectedRevision: analysis.revision,
      expectedContext: analysis.context,
      requestId: randomUUID(),
    });
    const morph = await call<MorphCatalog>('model_morph_catalog', { objectId: 'morph-model' });
    expect(morph.meshes[0]!.targets).toEqual(['jawOpen']);
    await call('model_morph_bindings_set', {
      id: 'morph-model',
      bindings: [{ channel: 'jawOpen', target: 'jawOpen', mesh: morph.meshes[0]!.mesh }],
    });
    await call('actor_face_key_set', {
      id: 'morph-model',
      keyframe: { time: 0, values: { jawOpen: 0 }, easing: 'linear' },
    });
    await call('actor_face_key_set', { id: 'morph-model', keyframe: { time: 2, values: { jawOpen: 1 } } });
    await page.goto('/');
    await page.locator('.tree-select').filter({ hasText: '对白角色' }).click();
    await expect(page.getByRole('checkbox', { name: '启用面部表演' })).toBeChecked();
    await page.getByRole('combobox', { name: '面部通道组' }).selectOption('眼睛与视线');
    await number('视线水平', 0.35);
    await expect
      .poll(
        async () =>
          (await call<Project>('project_get')).objects.find((item) => item.id === 'face-actor')!.actor!.face!
            .base.gazeX,
      )
      .toBe(0.35);
    await page.getByRole('combobox', { name: '口型形状' }).selectOption('B');
    await expect
      .poll(
        async () =>
          (await call<Project>('project_get')).objects.find((item) => item.id === 'face-actor')!.actor!.face!
            .clips[0]!.cues[0]!.viseme,
      )
      .toBe('B');
    await page.getByRole('button', { name: '分析口型', exact: true }).click();
    await expect(page.locator('.face-status')).toContainText('个口型片段', { timeout: 180000 });
    await page.locator('.tree-select').filter({ hasText: '形变模型' }).click();
    await expect(page.getByRole('combobox', { name: '模型形变目标' })).toHaveValue('jawOpen');
    await page.locator('.tree-select').filter({ hasText: '对白角色' }).click();
    await page.getByRole('checkbox', { name: '启用面部表演' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${directory}/desktop-face.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.getByRole('combobox', { name: '口型轨道', exact: true }).scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        scroll: document.querySelector('.app')!.scrollLeft,
      })),
    ).toEqual({ document: 390, scroll: 0 });
    await page.screenshot({ path: `${directory}/mobile-face.png` });
    const hashes: Record<string, string> = {};
    for (const [shotId, at, label] of [
      ['face-shot', 0, 'neutral'],
      ['face-shot', 3.6, 'speech'],
      ['face-shot', 6.55, 'blink'],
      ['morph-shot', 0, 'morph-neutral'],
      ['morph-shot', 2, 'morph-open'],
    ] as const) {
      const result = await client.callTool({
        name: 'preview_capture',
        arguments: { shotId, time: at, width: 1280, height: 720 },
      });
      expect(result.isError).not.toBe(true);
      const image = (result.content as { type: string; data?: string }[]).find(
        (item) => item.type === 'image',
      );
      expect(image?.data).toBeTruthy();
      const bytes = Buffer.from(image!.data!, 'base64');
      await writeFile(`${directory}/${label}.png`, bytes);
      hashes[label] = createHash('sha256').update(bytes).digest('hex');
    }
    expect(hashes.neutral).not.toBe(hashes.speech);
    expect(hashes.speech).not.toBe(hashes.blink);
    expect(hashes['morph-neutral']).not.toBe(hashes['morph-open']);
    project = await call<Project>('project_get');
    const job = await call('render_start', {
      projectId: project.id,
      expectedRevision: project.revision,
      shotId: 'face-shot',
      fps: 24,
      resolution: 720,
      includeAudio: true,
    });
    await expect
      .poll(
        async () => {
          const status = await call('render_status', { id: job.id });
          if (status.status === 'failed') throw new Error(status.error);
          return status.status;
        },
        { timeout: 120000, intervals: [1000, 2000] },
      )
      .toBe('completed');
    const completed = await call('render_status', { id: job.id });
    await writeFile(`${directory}/face-lipsync.mp4`, await (await request.get(completed.downloadUrl)).body());
    const probe = JSON.parse(
      (
        await exec('ffprobe', [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          `${directory}/face-lipsync.mp4`,
        ])
      ).stdout,
    );
    expect(
      probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video'),
    ).toMatchObject({ codec_name: 'h264', width: 1280, height: 720, nb_frames: '192' });
    expect(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio')).toBe(true);
    expect(errors).toEqual([]);
    await writeFile(
      `${directory}/report.json`,
      JSON.stringify(
        { projectId: project.id, revision: project.revision, analysis, hashes, video: probe, errors },
        null,
        2,
      ),
    );
    await writeFile(`${directory}/project.json`, JSON.stringify(project, null, 2));
  } finally {
    await writeFile(`${directory}/mcp-operations.json`, JSON.stringify(journal, null, 2));
    await client.close();
  }
});
