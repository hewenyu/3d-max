import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Project } from '../shared/types';

for (const [name, width, height] of [
  ['desktop', 1440, 1000],
  ['mobile', 390, 844],
] as const) {
  test(`${name} orbit changes the observation view without changing saved cameras or photographed pixels`, async ({
    page,
    request,
  }, testInfo) => {
    const created = await request.post('/api/project/new', {
      data: { name: 'Observation and shot camera independence', template: 'demo' },
    });
    expect(created.ok()).toBe(true);
    const project = (await created.json()) as Project;
    const connection = await (await request.get('/api/connection')).json();
    const client = new Client({ name: 'camera-view-independence', version: '1' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const preview = async (label: string) => {
      const result = await client.callTool({
        name: 'preview_capture',
        arguments: { time: 0, width: 1280, height: 720 },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const image = (result.content as { type: string; data?: string }[]).find(
        (item) => item.type === 'image',
      );
      expect(image?.data).toBeTruthy();
      const bytes = Buffer.from(image!.data!, 'base64');
      await writeFile(testInfo.outputPath(`${name}-${label}.png`), bytes);
      return hash(bytes);
    };
    const canvas = page.locator('[data-testid="stage"] canvas');
    const capture = () => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    const displayedTime = () =>
      page.locator('.transport-time').evaluate((element) => element.firstChild?.textContent?.trim());
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(connection.url), {
          requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
        }),
      );
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await expect(page.locator('.project-name')).toHaveText(project.name);
      await page.getByRole('button', { name: '摄影机', exact: true }).click();
      await expect
        .poll(() =>
          canvas.evaluate((element: HTMLCanvasElement) => {
            const sample = document.createElement('canvas');
            sample.width = 100;
            sample.height = 100;
            const context = sample.getContext('2d')!;
            context.drawImage(element, 0, 0, 100, 100);
            const values = context.getImageData(0, 0, 100, 100).data;
            const colors = new Set<number>();
            for (let index = 0; index < values.length; index += 4)
              colors.add((values[index] << 16) | (values[index + 1] << 8) | values[index + 2]);
            return colors.size;
          }),
        )
        .toBeGreaterThan(30);
      const shotBefore = await capture();
      const previewBefore = await preview('mcp-before');
      const before = (await (await request.get('/api/project')).json()) as Project;
      const timeBefore = await displayedTime();
      await page.screenshot({ path: testInfo.outputPath(`${name}-shot-before.png`) });
      await page.getByRole('button', { name: '自由视角', exact: true }).click();
      await expect.poll(capture).not.toBe(shotBefore);
      const observationBefore = await capture();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width * 0.65, box!.y + box!.height * 0.45);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.62, { steps: 24 });
      await page.mouse.up();
      await expect.poll(capture).not.toBe(observationBefore);
      const observationAfter = await capture();
      await page.screenshot({ path: testInfo.outputPath(`${name}-observation-orbit.png`) });
      const afterOrbit = (await (await request.get('/api/project')).json()) as Project;
      expect(afterOrbit).toEqual(before);
      expect(await displayedTime()).toBe(timeBefore);
      await page.getByRole('button', { name: '摄影机', exact: true }).click();
      await expect.poll(capture).toBe(shotBefore);
      const previewAfter = await preview('mcp-after');
      expect(previewAfter).toBe(previewBefore);
      await page.screenshot({ path: testInfo.outputPath(`${name}-shot-after.png`) });
      await page.reload();
      await page.getByRole('button', { name: '摄影机', exact: true }).click();
      await expect.poll(capture).toBe(shotBefore);
      expect((await (await request.get('/api/project')).json()) as Project).toEqual(before);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(errors).toEqual([]);
      await writeFile(
        testInfo.outputPath('view-independence.json'),
        JSON.stringify(
          {
            viewport: { name, width, height },
            projectId: before.id,
            revision: before.revision,
            observationBefore: hash(observationBefore),
            observationAfter: hash(observationAfter),
            shotBeforeAndAfter: hash(shotBefore),
            previewBefore,
            previewAfter,
            savedProjectUnchanged: true,
            reloadPreservedShotPixels: true,
            errors,
          },
          null,
          2,
        ),
      );
    } finally {
      await client.close();
    }
  });
}
