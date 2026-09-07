import { expect, test } from '@playwright/test';
import type { Command, Project } from '../shared/types';

test('timeline beat and key markers keep shot-bound takes across cuts, repeats and retiming; clicks select their editing context', async ({
  page,
  request,
}, testInfo) => {
  let project = (await (
    await request.post('/api/project/new', { data: { name: 'Timeline context', template: 'empty' } })
  ).json()) as Project;
  const edit = async (commands: Command[]) => {
    const response = await request.post('/api/commands', { data: { commands, projectId: project.id } });
    expect(response.ok(), await response.text()).toBe(true);
    project = (await response.json()).project;
  };
  await edit([
    {
      type: 'object.create',
      payload: {
        id: 'actor',
        type: 'actor',
        name: 'Actor A',
        keyframes: [{ id: 'a-key', time: 1, position: [1, 0, 0] }],
      },
    },
    {
      type: 'motion.events.set',
      payload: {
        id: 'actor',
        events: [{ id: 'a-event', time: 0.5, kind: 'projectile', position: [0, 1, 0] }],
      },
    },
    {
      type: 'beat.create',
      payload: { id: 'a-beat', label: 'Take A beat', time: 1, endTime: 1.5, kind: 'dialogue' },
    },
    {
      type: 'camera.create',
      payload: {
        id: 'cam',
        name: 'Camera',
        position: [3, 2, 5],
        target: [0, 1, 0],
        keyframes: [
          { id: 'camera-key', time: 1.5, position: [3, 2, 4], target: [0, 1, 0], fov: 45, easing: 'linear' },
        ],
      },
    },
    { type: 'shot.create', payload: { id: 'shot-a', name: 'Shot A', cameraId: 'cam', sourceOut: 4 } },
    { type: 'production.initialize', payload: {} },
  ]);
  const sceneA = project.production!.activeSceneId;
  const takeA = project.production!.activePerformanceId;
  await edit([
    {
      type: 'performance.duplicate',
      payload: { sceneId: sceneA, id: takeA, newId: 'take-b', name: 'Take B' },
    },
    {
      type: 'beat.update',
      payload: { id: 'a-beat', patch: { label: 'Take B beat', time: 2, endTime: 2.5 } },
    },
    {
      type: 'object.update',
      payload: { id: 'actor', patch: { keyframes: [{ id: 'b-key', time: 2, position: [2, 0, 0] }] } },
    },
    { type: 'shot.create', payload: { id: 'shot-b', name: 'Shot B', cameraId: 'cam', sourceOut: 4 } },
    {
      type: 'motion.events.set',
      payload: {
        id: 'actor',
        events: [{ id: 'b-event', time: 1.75, kind: 'collision', position: [0, 1, 0] }],
      },
    },
    { type: 'scene.create', payload: { id: 'scene-c', performanceId: 'take-c', name: 'Set C' } },
    {
      type: 'object.create',
      payload: {
        id: 'other',
        type: 'box',
        name: 'Object C',
        keyframes: [{ id: 'c-key', time: 3, position: [3, 0, 0] }],
      },
    },
    { type: 'beat.create', payload: { id: 'c-beat', label: 'Set C beat', time: 3, endTime: 3.5 } },
    {
      type: 'motion.events.set',
      payload: { id: 'other', events: [{ id: 'c-event', time: 3, kind: 'explosion', position: [0, 1, 0] }] },
    },
    { type: 'shot.create', payload: { id: 'shot-c', name: 'Shot C', cameraId: 'cam', sourceOut: 4 } },
    {
      type: 'sequence.update',
      payload: {
        id: project.activeSequenceId,
        patch: {
          clips: [
            { id: 'clip-a', shotId: 'shot-a', sourceIn: 0, sourceOut: 4 },
            { id: 'clip-b', shotId: 'shot-b', sourceIn: 0, sourceOut: 4 },
            { id: 'clip-c', shotId: 'shot-c', sourceIn: 0, sourceOut: 4 },
            { id: 'repeat-a', shotId: 'shot-a', sourceIn: 0, sourceOut: 4 },
          ],
        },
      },
    },
    {
      type: 'clip.retime',
      payload: {
        sequenceId: project.activeSequenceId,
        clipId: 'clip-b',
        retiming: {
          audio: 'mute',
          segments: [{ duration: 8, fromSpeed: 0.5, toSpeed: 0.5, easing: 'constant' }],
        },
        cameraTiming: { mode: 'independent', sourceIn: 0, rate: 1 },
      },
    },
  ]);
  await page.goto('/');
  const markers = page.locator('.beat-marker');
  await expect(markers).toHaveText(['Take A beat', 'Take B beat', 'Set C beat', 'Take A beat']);
  await expect(page.locator('.timeline-event')).toHaveCount(4);
  const event = page.locator('.timeline-event[data-clip-id="clip-b"][data-event-id="b-event"]');
  expect(
    await event.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left)),
  ).toBeCloseTo((7.5 / 20) * 100, 5);
  await expect(event).toHaveAttribute('title', 'Actor A / 碰撞 / 00:01:18');
  const expected = [
    { clip: 'clip-a', key: 'a-key', edit: 1 },
    { clip: 'clip-b', key: 'b-key', edit: 8 },
    { clip: 'clip-c', key: 'c-key', edit: 15 },
    { clip: 'repeat-a', key: 'a-key', edit: 17 },
  ];
  for (const item of expected) {
    const marker = page.locator(
      `.timeline-diamond[data-clip-id="${item.clip}"][data-keyframe-id="${item.key}"]`,
    );
    await expect(marker).toHaveCount(1);
    expect(
      await marker.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left)),
    ).toBeCloseTo((item.edit / 20) * 100, 5);
  }
  const camera = page.locator('.timeline-diamond[data-clip-id="clip-b"][data-keyframe-id="camera-key"]');
  expect(
    await camera.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left)),
  ).toBeCloseTo((5.5 / 20) * 100, 5);
  await page.locator('.beat-marker[data-clip-id="clip-b"]').click();
  await expect
    .poll(async () => (await (await request.get('/api/project')).json()).production.activePerformanceId)
    .toBe('take-b');
  await expect(page.locator('.transport-time')).toContainText('00:08:00');
  await expect(markers).toHaveText(['Take A beat', 'Take B beat', 'Set C beat', 'Take A beat']);
  await page.locator('.timeline-diamond[data-clip-id="clip-c"][data-keyframe-id="c-key"]').click();
  await expect
    .poll(async () => (await (await request.get('/api/project')).json()).production.activeSceneId)
    .toBe('scene-c');
  await expect(page.locator('.transport-time')).toContainText('00:15:00');
  await page.locator('.beat-marker[data-clip-id="repeat-a"]').click();
  await expect
    .poll(async () => (await (await request.get('/api/project')).json()).production.activePerformanceId)
    .toBe(takeA);
  await expect(page.locator('.transport-time')).toContainText('00:17:00');
  await expect(markers).toHaveText(['Take A beat', 'Take B beat', 'Set C beat', 'Take A beat']);
  await event.click();
  await expect
    .poll(async () => (await (await request.get('/api/project')).json()).production.activePerformanceId)
    .toBe('take-b');
  await expect(page.locator('.transport-time')).toContainText('00:07:12');
  await expect(page.getByRole('combobox', { name: '运动事件', exact: true })).toHaveValue('b-event');
  await expect(page.getByRole('textbox', { name: '对象名称', exact: true })).toHaveValue('Actor A');
  await expect(page.getByRole('combobox', { name: '事件类型', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('timeline-context.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.timeline-event[data-clip-id="clip-c"][data-event-id="c-event"]').click();
  await expect(page.getByRole('textbox', { name: '对象名称', exact: true })).toHaveValue('Object C');
  await expect(page.getByRole('combobox', { name: '运动事件', exact: true })).toHaveValue('c-event');
  await expect(page.getByRole('combobox', { name: '事件类型', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const labelsCoverEvents = await page.evaluate(() => {
    const label = [...document.querySelectorAll('.track-label')].find(
      (item) => item.textContent === '运动事件',
    )!;
    const box = label.getBoundingClientRect();
    const row = document.querySelector('.event-track')!.getBoundingClientRect();
    const labels = document.querySelector('.track-labels')!.getBoundingClientRect();
    return {
      covered: labels.bottom >= row.bottom - 1,
      hit: document.elementFromPoint(box.left + 15, box.top + box.height / 2) === label,
    };
  });
  expect(labelsCoverEvents).toEqual({ covered: true, hit: true });
  await page.screenshot({ path: testInfo.outputPath('timeline-context-mobile.png') });
});
