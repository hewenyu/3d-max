import { expect, test } from '@playwright/test';
import type { Project, RenderJob } from '../shared/types';

test('director publishes a film, invited reviewers discuss exact frames and revoked/view-only access is enforced', async ({
  page,
  request,
  browser,
}, testInfo) => {
  const created = await request.post('/api/project/new', {
    data: { name: '团队审片验收', template: 'empty' },
  });
  const project = (await created.json()) as Project;
  const setup = await request.post('/api/commands', {
    data: {
      projectId: project.id,
      expectedRevision: project.revision,
      commands: [
        { type: 'project.settings', payload: { fps: 24, aspect: '16:9' } },
        {
          type: 'object.create',
          payload: {
            id: 'subject',
            type: 'box',
            position: [0, 0.5, 0],
            keyframes: [
              { id: 'a', time: 0, position: [-1, 0.5, 0] },
              { id: 'b', time: 2, position: [1, 0.5, 0] },
            ],
          },
        },
        { type: 'camera.create', payload: { id: 'camera', position: [0, 2, 5], target: [0, 0.5, 0] } },
        { type: 'shot.create', payload: { id: 'shot', cameraId: 'camera', sourceIn: 0, sourceOut: 2 } },
        {
          type: 'sequence.update',
          payload: {
            id: project.activeSequenceId,
            patch: { name: '审片剪辑', clips: [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 2 }] },
          },
        },
      ],
    },
  });
  expect(setup.ok(), await setup.text()).toBe(true);
  const started = await request.post('/api/renders', {
    data: { fps: 24, resolution: 720, aspect: '16:9', includeAudio: false },
  });
  const job = (await started.json()) as RenderJob;
  await expect
    .poll(async () => {
      const current = (await (await request.get(`/api/renders/${job.id}`)).json()) as RenderJob;
      if (current.status === 'failed') throw new Error(current.error);
      return current.status;
    })
    .toBe('completed');
  await page.goto('/');
  await page.locator('.project-name').click();
  await page.getByRole('button', { name: '团队审片', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '团队审片', exact: true });
  await dialog.getByText('发布成片版本', { exact: true }).click();
  await dialog.getByRole('combobox', { name: '发布成片', exact: true }).selectOption(job.id);
  await dialog.getByRole('textbox', { name: '审片版本标题', exact: true }).fill('第一场 / 导演审片');
  await dialog.getByRole('button', { name: '发布审片版本', exact: true }).click();
  const ownerVideo = dialog.getByLabel('审片视频', { exact: true });
  await expect(ownerVideo).toBeVisible();
  await dialog.getByText('审片成员', { exact: true }).click();
  await dialog.getByRole('textbox', { name: '审片成员姓名', exact: true }).fill('摄影指导');
  await dialog.getByRole('button', { name: '创建邀请', exact: true }).click();
  const invite = dialog.getByRole('textbox', { name: '审片邀请链接', exact: true });
  await expect(invite).toHaveValue(/#invite=/);
  const reviewUrl = await invite.inputValue();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const readOnlyContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const reviewer = await context.newPage();
    await reviewer.goto(reviewUrl);
    if (testInfo.config.metadata.builtFrontend)
      expect(new URL(reviewer.url()).origin).toBe(new URL(reviewUrl).origin);
    await expect(reviewer.getByRole('heading', { name: '第一场 / 导演审片', exact: true })).toBeVisible();
    expect(new URL(reviewer.url()).hash).toBe('');
    const video = reviewer.getByLabel('审片视频', { exact: true });
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
      .toBeGreaterThanOrEqual(3);
    await video.evaluate((element: HTMLVideoElement) => {
      element.currentTime = 1.25;
      element.pause();
    });
    await reviewer.getByRole('textbox', { name: '审片意见内容', exact: true }).fill('此帧提前切到人物反应。');
    await reviewer.getByRole('button', { name: '提交意见', exact: true }).click();
    await expect(dialog.getByText('此帧提前切到人物反应。', { exact: true })).toBeVisible();
    await expect(dialog.locator('.review-comment-meta').first()).toContainText('摄影指导');
    await expect(dialog.locator('.review-comment-meta').first()).toContainText('00:01:06');
    await dialog.getByRole('button', { name: '回复审片意见', exact: true }).click();
    await dialog
      .getByRole('textbox', { name: '审片意见内容', exact: true })
      .fill('已记录，下一版本缩短切点。');
    await dialog.getByRole('button', { name: '提交意见', exact: true }).click();
    await expect(reviewer.getByText('已记录，下一版本缩短切点。', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '解决意见', exact: true }).click();
    await expect(reviewer.locator('.review-thread').first()).toContainText('已解决');
    await reviewer.getByRole('button', { name: '00:01:06', exact: true }).first().click();
    expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(1.25, 2);
    await reviewer.screenshot({ path: testInfo.outputPath('review-desktop.png') });
    await reviewer.setViewportSize({ width: 390, height: 844 });
    await reviewer.screenshot({ path: testInfo.outputPath('review-mobile.png') });
    expect(await reviewer.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await dialog.getByRole('textbox', { name: '审片成员姓名', exact: true }).fill('制片查看');
    await dialog.getByRole('combobox', { name: '审片成员权限', exact: true }).selectOption('viewer');
    await dialog.getByRole('button', { name: '创建邀请', exact: true }).click();
    await expect(invite).not.toHaveValue(reviewUrl);
    const viewer = await readOnlyContext.newPage();
    await viewer.goto(await invite.inputValue());
    await expect(viewer.getByLabel('审片视频', { exact: true })).toBeVisible();
    await expect(viewer.getByRole('textbox', { name: '审片意见内容', exact: true })).toHaveCount(0);
    const download = viewer.waitForEvent('download');
    await viewer.getByRole('link', { name: '下载 MP4', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.mp4$/);
    await dialog.getByRole('button', { name: '撤销 摄影指导 的审片访问', exact: true }).click();
    await expect(reviewer.getByRole('alert')).toContainText('revoked');
    await expect(reviewer.getByLabel('审片视频', { exact: true })).toHaveCount(0);
    await expect(viewer.getByLabel('审片视频', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('review-owner-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.locator('.modal-content').evaluate((element) => element.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('review-owner-mobile.png') });
    const header = await dialog.locator('header').boundingBox();
    const selector = await dialog.getByRole('combobox', { name: '审片版本', exact: true }).boundingBox();
    expect(selector!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  } finally {
    await context.close();
    await readOnlyContext.close();
  }
});
