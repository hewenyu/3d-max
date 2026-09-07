import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Project } from '../shared/types';

const exec = promisify(execFile);
test('audio trim and fades persist through UI/MCP and native preview preserves volume above one', async ({
  page,
  request,
}, testInfo) => {
  const directory = testInfo.outputPath('artifacts');
  await mkdir(directory, { recursive: true });
  await exec('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=48000:duration=6',
    `${directory}/tone.wav`,
  ]);
  await page.addInitScript(() => {
    const stats = { gains: [] as number[], sources: 0 };
    Object.assign(window, { fadeVerification: stats });
    const source = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function (...args) {
      stats.sources++;
      return source.apply(this, args);
    };
    const target = AudioParam.prototype.setTargetAtTime;
    AudioParam.prototype.setTargetAtTime = function (value, start, constant) {
      stats.gains.push(value);
      return target.call(this, value, start, constant);
    };
  });
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'audio-fade-acceptance', version: '1' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const call = async <T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[]).find(
      (item) => item.type === 'text',
    )!.text!;
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as T;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    const fresh = await call<Project>('project_new', { name: 'Audio fade acceptance', template: 'empty' });
    const asset = await call('asset_import', {
      name: 'Fade tone.wav',
      dataBase64: (await readFile(`${directory}/tone.wav`)).toString('base64'),
    });
    await call('edit_batch', {
      commands: [
        { type: 'object.create', payload: { id: 'actor', type: 'actor' } },
        { type: 'camera.create', payload: { id: 'camera', position: [2, 2, 4], target: [0, 1, 0] } },
        { type: 'shot.create', payload: { id: 'shot', cameraId: 'camera', sourceIn: 0, sourceOut: 4 } },
        {
          type: 'sequence.update',
          payload: {
            id: fresh.activeSequenceId,
            patch: { clips: [{ id: 'edit', shotId: 'shot', sourceIn: 0, sourceOut: 4 }] },
          },
        },
        {
          type: 'audio.create',
          payload: {
            id: 'tone',
            name: 'Fade tone',
            url: asset.url,
            start: 0,
            duration: 4,
            sourceIn: 0,
            volume: 1.5,
          },
        },
      ],
    });
    await page.goto('/');
    await page.getByRole('button', { name: '导演', exact: true }).click();
    const number = async (label: string, value: number) => {
      const input = page.getByRole('spinbutton', { name: label, exact: true });
      await input.fill(String(value));
      await input.press('Enter');
    };
    await number('Fade tone 音频源入点', 1);
    await number('Fade tone 音频淡入', 2);
    await number('Fade tone 音频淡出', 2);
    await page.getByRole('combobox', { name: 'Fade tone 音频淡化曲线' }).selectOption('equalPower');
    await expect
      .poll(async () => (await call<Project>('project_get')).audio[0])
      .toMatchObject({ sourceIn: 1, fadeIn: 2, fadeOut: 2, fadeCurve: 'equalPower', volume: 1.5 });
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(() =>
          Math.max(
            ...(window as unknown as { fadeVerification: { gains: number[] } }).fadeVerification.gains,
          ),
        ),
      )
      .toBeGreaterThan(1.3);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const stats = await page.evaluate(
      () =>
        (window as unknown as { fadeVerification: { gains: number[]; sources: number } }).fadeVerification,
    );
    expect(stats.sources).toBeGreaterThan(0);
    expect(stats.gains.some((gain) => gain > 0 && gain < 0.5)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.getByRole('combobox', { name: 'Fade tone 音频淡化曲线' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${directory}/mobile-audio-fades.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors).toEqual([]);
    await writeFile(
      `${directory}/report.json`,
      JSON.stringify({ stats, project: await call('project_get'), errors }, null, 2),
    );
  } finally {
    await client.close();
  }
});
