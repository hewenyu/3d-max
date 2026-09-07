import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Project, RenderJob, RenderOptions } from '../shared/types';

const run = promisify(execFile);

test('actual failed shot and sequence exports retry the latest project without leaking scope into later exports', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180000);
  const created = await request.post('/api/project/new', {
    data: { name: `重试范围验收 ${Date.now()}`, template: 'empty' },
  });
  expect(created.ok()).toBe(true);
  let project = (await created.json()) as Project;
  const invalidAsset = await request.post('/api/assets', {
    multipart: {
      file: {
        name: 'broken-scene.gltf',
        mimeType: 'model/gltf+json',
        buffer: Buffer.from(
          JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [99] }], scene: 0 }),
        ),
      },
    },
  });
  expect(invalidAsset.ok()).toBe(true);
  const asset = await invalidAsset.json();
  const edit = await request.post('/api/commands', {
    data: {
      projectId: project.id,
      expectedRevision: project.revision,
      commands: [
        { type: 'project.settings', payload: { aspect: '16:9', fps: 24, resolution: 720 } },
        { type: 'object.create', payload: { id: 'subject', type: 'sphere' } },
        { type: 'object.create', payload: { id: 'broken', type: 'model', assetUrl: asset.url } },
        { type: 'camera.create', payload: { id: 'camera', position: [0, 1, 5], target: [0, 0.5, 0] } },
        {
          type: 'shot.create',
          payload: { id: 'shot', cameraId: 'camera', name: '重试单镜头', sourceIn: 0, sourceOut: 0.5 },
        },
        {
          type: 'sequence.update',
          payload: {
            id: project.activeSequenceId,
            patch: {
              name: '重试完整序列',
              clips: [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 0.5 }],
            },
          },
        },
      ],
    },
  });
  expect(edit.ok(), await edit.text()).toBe(true);
  project = (await edit.json()).project;
  const failed: RenderJob[] = [];
  for (const scope of [{ shotId: 'shot' }, { sequenceId: project.activeSequenceId }]) {
    const started = await request.post('/api/renders', {
      data: {
        ...scope,
        projectId: project.id,
        expectedRevision: project.revision,
        fps: 24,
        resolution: 720,
        aspect: '16:9',
        includeAudio: false,
      },
    });
    expect(started.ok()).toBe(true);
    const job = (await started.json()) as RenderJob;
    await expect
      .poll(async () => (await (await request.get(`/api/renders/${job.id}`)).json()).status, {
        timeout: 60000,
      })
      .toBe('failed');
    failed.push(await (await request.get(`/api/renders/${job.id}`)).json());
  }
  const repaired = await request.post('/api/commands', {
    data: {
      projectId: project.id,
      expectedRevision: project.revision,
      commands: [
        { type: 'object.delete', payload: { id: 'broken' } },
        { type: 'object.update', payload: { id: 'subject', patch: { position: [0.25, 0, 0] } } },
      ],
    },
  });
  expect(repaired.ok()).toBe(true);
  project = (await repaired.json()).project;
  const sent: RenderOptions[] = [];
  const successful: RenderJob[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '导出视频', exact: true }).click();
  const submit = async (action: () => Promise<unknown>, expected: 'shot' | 'sequence') => {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/renders',
    );
    await action();
    const response = await responsePromise;
    const payload = response.request().postDataJSON() as RenderOptions;
    sent.push(payload);
    expect(response.ok(), await response.text()).toBe(true);
    expect(Boolean(payload.shotId)).toBe(expected === 'shot');
    expect(Boolean(payload.sequenceId)).toBe(expected === 'sequence');
    expect(payload.projectId).toBe(project.id);
    expect(payload.expectedRevision).toBe(project.revision);
    const job = (await response.json()) as RenderJob;
    let completed = job;
    await expect
      .poll(
        async () => {
          const current = (await (await request.get(`/api/renders/${job.id}`)).json()) as RenderJob;
          completed = current;
          if (current.status === 'failed') throw new Error(current.error);
          return current.status;
        },
        { timeout: 60000 },
      )
      .toBe('completed');
    expect(completed.projectRevision).toBe(project.revision);
    expect(completed.status).toBe('completed');
    successful.push(completed);
    return completed;
  };
  const failedCard = (job: RenderJob) =>
    page
      .locator('.render-job')
      .filter({ has: page.locator('.render-job-name', { hasText: job.name }) })
      .filter({ hasText: '失败' });
  await submit(
    () => failedCard(failed[0]).getByRole('button', { name: '用当前项目版本重试导出', exact: true }).click(),
    'shot',
  );
  await submit(() => page.getByRole('button', { name: /开始导出/ }).click(), 'sequence');
  await submit(
    () => failedCard(failed[1]).getByRole('button', { name: '用当前项目版本重试导出', exact: true }).click(),
    'sequence',
  );
  await page.getByRole('combobox', { name: '导出范围', exact: true }).selectOption('shot');
  const final = await submit(() => page.getByRole('button', { name: /开始导出/ }).click(), 'shot');
  await page.screenshot({ path: testInfo.outputPath('recovered-export-scopes.png') });
  const video = testInfo.outputPath('retry-current-shot.mp4');
  await writeFile(video, await (await request.get(`/api/renders/${final.id}/file`)).body());
  const probe = JSON.parse(
    (
      await run('ffprobe', [
        '-v',
        'error',
        '-count_frames',
        '-show_entries',
        'stream=codec_name,width,height,avg_frame_rate,nb_read_frames',
        '-of',
        'json',
        video,
      ])
    ).stdout,
  );
  expect(probe.streams[0]).toMatchObject({
    codec_name: 'h264',
    width: 1280,
    height: 720,
    avg_frame_rate: '24/1',
    nb_read_frames: '12',
  });
  const switched = await request.post('/api/project/new', {
    data: { name: '重试上下文切换', template: 'empty' },
  });
  expect(switched.ok()).toBe(true);
  await expect(
    failedCard(failed[0]).getByRole('button', { name: '用当前项目版本重试导出', exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
  await writeFile(
    testInfo.outputPath('retry-verification.json'),
    JSON.stringify(
      { failed, successful, sent, projectId: project.id, repairedRevision: project.revision, probe },
      null,
      2,
    ),
  );
});
