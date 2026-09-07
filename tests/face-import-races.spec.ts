import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createEmptyProject, createObject } from '../shared/project';
import { faceAnimationSchema, objectFace } from '../shared/face-animation';
import type { CommandResponse, Project } from '../shared/types';

declare global {
  interface Window {
    releaseCueFile?: () => void;
  }
}

for (const target of ['project', 'performance'] as const)
  test(`mouth-cue file import stays bound to its initial ${target} while file reading is pending`, async ({
    page,
    request,
  }, testInfo) => {
    const connection = await (await request.get('/api/connection')).json();
    const client = new Client({ name: 'face-import-race', version: '1' });
    const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return JSON.parse(
        (response.content as { type: string; text?: string }[]).find((item) => item.type === 'text')!.text!,
      ) as T;
    };
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(connection.url), {
          requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
        }),
      );
      const fixture = createEmptyProject('Cue import source');
      const actor = createObject('actor', 'Cue Actor');
      actor.id = 'cue-actor';
      actor.actor!.face = faceAnimationSchema.parse({});
      fixture.objects.push(actor);
      await call('project_import', { project: fixture });
      const initialized = await call<CommandResponse>('production_initialize');
      const source = initialized.project;
      await page.addInitScript(() => {
        const read = File.prototype.text;
        File.prototype.text = async function () {
          if (this.name === 'cue-import-race.json')
            await new Promise<void>((resolve) => {
              window.releaseCueFile = resolve;
            });
          return read.call(this);
        };
      });
      await page.goto('/');
      await page.locator('.tree-select').filter({ hasText: 'Cue Actor' }).click();
      const file = {
        id: 'imported-track',
        name: 'Imported cues',
        start: 0,
        end: 2,
        cues: [{ id: 'cue', start: 0, end: 1, viseme: 'D' }],
      };
      await page.getByLabel('导入口型轨道', { exact: true }).setInputFiles({
        name: 'cue-import-race.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(file)),
      });
      await expect.poll(() => page.evaluate(() => Boolean(window.releaseCueFile))).toBe(true);
      let destination: Project;
      if (target === 'project') {
        fixture.name = 'Cue import destination';
        destination = await call<Project>('project_import', { project: fixture });
        await expect(page.locator('.project-name')).toContainText('Cue import destination');
      } else {
        destination = (
          await call<CommandResponse>('performance_duplicate', {
            sceneId: source.production!.activeSceneId,
            id: source.production!.activePerformanceId,
            name: 'Destination take',
            newId: 'destination-take',
            projectId: source.id,
            expectedRevision: source.revision,
          })
        ).project;
        await expect(page.locator('footer .mono').last()).toHaveText(`r${destination.revision}`);
      }
      await page.evaluate(() => window.releaseCueFile!());
      await expect(page.getByRole('alert')).toContainText(
        target === 'project' ? '项目已切换' : '场景或表演版本已切换',
      );
      const unchanged = await call<Project>('project_get');
      expect(unchanged).toEqual(destination);
      expect(objectFace(unchanged.objects[0])?.clips ?? []).toEqual([]);
      if (target === 'performance')
        expect(
          unchanged.production!.scenes[0].performances.every(
            (take) => (take.tracks[0].actor?.face?.clips.length ?? 0) === 0,
          ),
        ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`cue-import-${target}-guard.png`) });
      await page.reload();
      await page.locator('.tree-select').filter({ hasText: 'Cue Actor' }).click();
      await page.getByLabel('导入口型轨道', { exact: true }).setInputFiles({
        name: 'cue-import-valid.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(file)),
      });
      await expect
        .poll(async () => objectFace((await call<Project>('project_get')).objects[0])?.clips[0]?.name)
        .toBe('Imported cues');
      await call('history_undo', { projectId: destination.id });
      expect(objectFace((await call<Project>('project_get')).objects[0])?.clips ?? []).toEqual([]);
      if (target === 'project') {
        const original = await call<Project>('project_open', { id: source.id });
        expect(original).toEqual(source);
      }
    } finally {
      await client.close();
    }
  });
