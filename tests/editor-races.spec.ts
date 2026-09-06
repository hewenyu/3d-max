import { expect, test, type Page, type Route } from '@playwright/test';
import { createDemoProject } from '../shared/project';
import { applyCommands } from '../shared/commands';
import { sampleCamera, sampleObject } from '../shared/timeline';
import type { Command, Project } from '../shared/types';

interface ReviewWindow extends Window {
  emitReviewProject(project: Project): void;
  reviewSources: number;
}

function project(name: string) {
  return { ...createDemoProject(), name, id: `review-${name}`, revision: 0 };
}

async function mockEditor(
  page: Page,
  initial: Project,
  intercept?: (route: Route, path: string) => Promise<boolean>,
) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.addInitScript(() => {
    const target = window as unknown as ReviewWindow;
    const instances = new Set<EventTarget>();
    target.reviewSources = 0;
    window.EventSource = class extends EventTarget {
      onopen = null;
      onerror = null;
      constructor() {
        super();
        instances.add(this);
        target.reviewSources = instances.size;
      }
      close() {
        instances.delete(this);
        target.reviewSources = instances.size;
      }
    } as unknown as typeof EventSource;
    target.emitReviewProject = (value) => {
      for (const instance of instances)
        instance.dispatchEvent(new MessageEvent('project', { data: JSON.stringify(value) }));
    };
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path !== '/api/assets')
      writes.push({ path, body: request.postDataJSON() });
    if (await intercept?.(route, path)) return;
    if (path === '/api/project') return route.fulfill({ json: initial });
    if (path === '/api/history') return route.fulfill({ json: { canUndo: false, canRedo: false } });
    if (path === '/api/commands') return route.fulfill({ json: { project: initial, results: [] } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as ReviewWindow).reviewSources > 0);
  return writes;
}

async function emit(page: Page, value: Project) {
  await page.evaluate((next) => (window as unknown as ReviewWindow).emitReviewProject(next), value);
  await expect(page.locator('.project-name')).toContainText(value.name);
}

async function settle(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

test('a delayed initial project response cannot revive the project superseded by SSE', async ({ page }) => {
  const a = project('A');
  const b = project('B');
  const held: Route[] = [];
  await mockEditor(page, a, async (route, path) => {
    if (path !== '/api/project') return false;
    held.push(route);
    return true;
  });
  await emit(page, b);
  expect(held.length).toBeGreaterThan(0);
  for (const route of held) await route.fulfill({ json: a });
  await settle(page);
  await expect(page.locator('.project-name')).toContainText('B');
});

test('a delayed project replacement response cannot overwrite a later SSE switch', async ({ page }) => {
  const a = project('A');
  const b = project('B');
  const c = project('C');
  let replacement: Route | undefined;
  await mockEditor(page, a, async (route, path) => {
    if (path !== '/api/project/new') return false;
    replacement = route;
    return true;
  });
  await expect(page.locator('.project-name')).toContainText('A');
  await page.locator('.project-name').click();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect.poll(() => Boolean(replacement)).toBeTruthy();
  await emit(page, b);
  await emit(page, c);
  await replacement!.fulfill({ json: b });
  await settle(page);
  await expect(page.locator('.project-name')).toContainText('C');
});

test('a delayed recovery response cannot overwrite a later SSE switch', async ({ page }) => {
  const a = project('A');
  const b = project('B');
  let recovering = false;
  let recovery: Route | undefined;
  await mockEditor(page, a, async (route, path) => {
    if (path === '/api/commands') {
      recovering = true;
      await route.fulfill({ status: 409, json: { error: { message: 'Revision changed' } } });
      return true;
    }
    if (path === '/api/project' && recovering) {
      recovery = route;
      return true;
    }
    return false;
  });
  await expect(page.locator('.project-name')).toContainText('A');
  await page.getByRole('button', { name: '资产', exact: true }).click();
  await page.getByRole('button', { name: '立方体', exact: true }).click();
  await expect.poll(() => Boolean(recovery)).toBeTruthy();
  await emit(page, b);
  await recovery!.fulfill({ json: a });
  await settle(page);
  await expect(page.locator('.project-name')).toContainText('B');
});

for (const kind of ['model', 'audio'] as const) {
  test(`${kind} upload stays bound to the project where import started`, async ({ page }) => {
    const a = project('A');
    const b = project('B');
    let upload: Route | undefined;
    const writes = await mockEditor(page, a, async (route, path) => {
      if (path !== '/api/assets') return false;
      upload = route;
      return true;
    });
    await expect(page.locator('.project-name')).toContainText('A');
    if (kind === 'model') await page.getByRole('button', { name: '资产', exact: true }).click();
    else await page.getByRole('button', { name: '导演', exact: true }).click();
    const input = page.locator(
      kind === 'model' ? '.scene-panel input[type=file]' : '.inspector input[type=file]',
    );
    await input.setInputFiles({
      name: kind === 'model' ? 'review.glb' : 'review.wav',
      mimeType: kind === 'model' ? 'model/gltf-binary' : 'audio/wav',
      buffer: Buffer.from('review fixture'),
    });
    await expect.poll(() => Boolean(upload)).toBeTruthy();
    await emit(page, b);
    await upload!.fulfill({
      json: { id: 'review-asset', url: '/api/assets/review/file', name: 'review', duration: 2 },
    });
    await expect(page.getByRole('alert')).toContainText(
      kind === 'model' ? '项目已切换，未导入上一项目的模型' : '项目已切换，未导入上一项目的音频',
    );
    expect(writes.filter((write) => write.path === '/api/commands')).toEqual([]);
    await expect(page.locator('.project-name')).toContainText('B');
  });
}

test('an import queued before a project switch is checked again before execution', async ({ page }) => {
  const a = project('A');
  const b = project('B');
  let firstCommand: Route | undefined;
  const writes = await mockEditor(page, a, async (route, path) => {
    if (path === '/api/commands') {
      firstCommand = route;
      return true;
    }
    if (path === '/api/assets') {
      await route.fulfill({ json: { id: 'review-asset', url: '/api/assets/review/file', name: 'review' } });
      return true;
    }
    return false;
  });
  await expect(page.locator('.project-name')).toContainText('A');
  await page.getByRole('button', { name: '资产', exact: true }).click();
  await page.getByRole('button', { name: '立方体', exact: true }).click();
  await expect.poll(() => Boolean(firstCommand)).toBeTruthy();
  await page
    .locator('.scene-panel input[type=file]')
    .setInputFiles({ name: 'review.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('review') });
  await settle(page);
  await emit(page, b);
  await firstCommand!.fulfill({ json: { project: a, results: [] } });
  await expect(page.getByRole('alert')).toContainText('项目已切换，未导入上一项目的模型');
  expect(writes.filter((write) => write.path === '/api/commands')).toHaveLength(1);
  await expect(page.locator('.project-name')).toContainText('B');
});

test('undo waits for a pending edit and uses the resulting revision', async ({ page }) => {
  const a = project('A');
  let firstCommand: Route | undefined;
  const writes = await mockEditor(page, a, async (route, path) => {
    if (path === '/api/commands') {
      firstCommand = route;
      return true;
    }
    if (path === '/api/history/undo') {
      await route.fulfill({ json: { ...a, revision: 2 } });
      return true;
    }
    return false;
  });
  await expect(page.locator('.project-name')).toContainText('A');
  await page.getByRole('button', { name: '资产', exact: true }).click();
  await page.getByRole('button', { name: '立方体', exact: true }).click();
  await expect.poll(() => Boolean(firstCommand)).toBeTruthy();
  await page.keyboard.press('Control+z');
  await settle(page);
  expect(writes.filter((write) => write.path === '/api/history/undo')).toHaveLength(0);
  await firstCommand!.fulfill({ json: { project: { ...a, revision: 1 }, results: [] } });
  await expect.poll(() => writes.filter((write) => write.path === '/api/history/undo').length).toBe(1);
  expect(writes.find((write) => write.path === '/api/history/undo')!.body).toEqual({
    projectId: a.id,
    expectedRevision: 1,
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const kind of ['object', 'camera'] as const)
  for (const mode of ['base', 'keyframe'] as const) {
    test(`${kind} ${mode} edits merge separate axes after pending edits complete`, async ({ page }) => {
      const a = project('A');
      let state = a;
      let held: { route: Route; result: ReturnType<typeof applyCommands> } | undefined;
      const submitted: Command[][] = [];
      await mockEditor(page, a, async (route, path) => {
        if (path !== '/api/commands') return false;
        const body = route.request().postDataJSON() as { commands: Command[] };
        submitted.push(body.commands);
        const result = applyCommands(state, body.commands);
        state = result.project;
        if (submitted.length === 1) held = { route, result };
        else await route.fulfill({ json: result });
        return true;
      });
      await expect(page.locator('.project-name')).toContainText('A');
      if (kind === 'object') await page.getByRole('button', { name: '沙发', exact: true }).click();
      if (mode === 'keyframe') await page.getByRole('button', { name: '当前帧', exact: true }).click();
      const label = kind === 'object' ? '位置 · m' : '机位 · m';
      const x = page.getByRole('spinbutton', { name: `${label} X`, exact: true });
      const y = page.getByRole('spinbutton', { name: `${label} Y`, exact: true });
      await x.fill('3');
      await x.press('Enter');
      await expect.poll(() => Boolean(held)).toBeTruthy();
      await y.fill('2');
      await y.press('Enter');
      await settle(page);
      expect(submitted).toHaveLength(1);
      await held!.route.fulfill({ json: held!.result });
      await expect.poll(() => submitted.length).toBe(2);
      const entity =
        kind === 'object'
          ? sampleObject(
              state.objects.find((item) => item.id === 'sofa')!,
              0,
            )
          : sampleCamera(
              state.cameras.find((item) => item.id === 'camera-wide')!,
              0,
            );
      expect(entity.position.slice(0, 2)).toEqual([3, 2]);
      if (mode === 'keyframe') expect(entity.keyframes).toHaveLength(1);
      await expect(page.getByRole('alert')).toHaveCount(0);
    });
  }

for (const mode of ['base', 'keyframe'] as const) {
  test(`actor ${mode} pose and action edits retain earlier queued changes`, async ({ page }) => {
    const a = project('A');
    let state = a;
    let held: { route: Route; result: ReturnType<typeof applyCommands> } | undefined;
    let submitted = 0;
    await mockEditor(page, a, async (route, path) => {
      if (path !== '/api/commands') return false;
      const body = route.request().postDataJSON() as { commands: Command[] };
      const result = applyCommands(state, body.commands);
      state = result.project;
      submitted++;
      if (submitted === 1) held = { route, result };
      else await route.fulfill({ json: result });
      return true;
    });
    await expect(page.locator('.project-name')).toContainText('A');
    await page.getByRole('button', { name: 'B / 陈默', exact: true }).click();
    if (mode === 'keyframe') await page.getByRole('button', { name: '当前帧', exact: true }).click();
    const pitch = page.getByRole('spinbutton', { name: '头部俯仰', exact: true });
    const yaw = page.getByRole('spinbutton', { name: '头部转向', exact: true });
    await pitch.fill('30');
    await pitch.press('Enter');
    await expect.poll(() => Boolean(held)).toBeTruthy();
    await yaw.fill('40');
    await yaw.press('Enter');
    await page.getByRole('combobox', { name: '角色动作', exact: true }).selectOption('talk');
    await settle(page);
    expect(submitted).toBe(1);
    await held!.route.fulfill({ json: held!.result });
    await expect.poll(() => submitted).toBe(3);
    const target = state.objects.find((item) => item.id === 'actor-b')!;
    const actor = (mode === 'base' ? target : sampleObject(target, 0)).actor!;
    expect(actor.pose.headPitch).toBe(30);
    expect(actor.pose.headYaw).toBe(40);
    expect(actor.action).toBe('talk');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
