import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Project } from '../shared/types';

function sound(): Buffer {
  const frames = 8000;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++)
    buffer.writeInt16LE(Math.round(Math.sin((frame / 8000) * 220 * Math.PI * 2) * 3000), 44 + frame * 2);
  return buffer;
}

test('director timing links edit through UI and real MCP, persist, reject locked batches and unlink without moving', async ({
  page,
  request,
}, testInfo) => {
  const directory = testInfo.outputPath('artifacts');
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'synchronization-acceptance', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  });
  const errors: string[] = [];
  const journal: unknown[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function call(name: string, args: Record<string, unknown> = {}, fails = false) {
    const result = await client.callTool({ name, arguments: args });
    const value = JSON.parse(
      (result.content as { type: string; text?: string }[]).find((item) => item.type === 'text')!.text!,
    );
    journal.push({ name, arguments: args, isError: result.isError ?? false, result: value });
    expect(Boolean(result.isError), JSON.stringify(value)).toBe(fails);
    return value;
  }
  const get = async (): Promise<Project> => call('project_get');
  try {
    await mkdir(directory, { recursive: true });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((item) => item.name)).toEqual(
      expect.arrayContaining(['sync_group_set', 'sync_group_move', 'sync_member_remove']),
    );
    const fresh = await call('project_new', { name: 'Synchronization QA', template: 'empty' });
    const upload = await request.post('/api/assets', {
      multipart: { file: { name: 'cue.wav', mimeType: 'audio/wav', buffer: sound() } },
    });
    expect(upload.ok()).toBeTruthy();
    const asset = await upload.json();
    await call('edit_batch', {
      commands: [
        {
          type: 'object.create',
          payload: {
            type: 'actor',
            id: 'actor',
            name: 'Actor',
            motionEvents: [{ id: 'impact', kind: 'impact', time: 6, position: [0, 1, 0] }],
          },
        },
        {
          type: 'actor.clip.set',
          payload: { id: 'actor', clip: { id: 'punch', action: 'punch', start: 5, end: 6 } },
        },
        {
          type: 'camera.create',
          payload: { id: 'camera', position: [3, 2, 5], target: [0, 0.9, 0], fov: 35 },
        },
        { type: 'shot.create', payload: { id: 'shot', cameraId: 'camera', sourceIn: 0, sourceOut: 12 } },
        {
          type: 'sequence.update',
          payload: {
            id: fresh.activeSequenceId,
            patch: { clips: [{ id: 'edit', shotId: 'shot', sourceIn: 0, sourceOut: 12 }] },
          },
        },
        {
          type: 'beat.create',
          payload: {
            id: 'dialogue',
            label: 'Dialogue',
            kind: 'dialogue',
            time: 2,
            endTime: 4,
            text: 'Move',
            actorId: 'actor',
          },
        },
        {
          type: 'audio.create',
          payload: { id: 'sound', name: 'Sound', url: asset.url, start: 2, duration: 1 },
        },
      ],
    });
    await page.goto('/');
    await expect(page.locator('[data-testid="stage"] canvas')).toBeVisible();
    await page.getByRole('button', { name: '导演', exact: true }).click();
    await page.getByText('新建同步组', { exact: true }).click();
    for (const label of ['Dialogue', 'Sound', 'Actor / punch', 'Actor / impact'])
      await page.getByRole('checkbox', { name: `关联 ${label}`, exact: true }).check();
    await page.getByRole('button', { name: '建立同步', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '同步组名称', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: '同步锚点 Dialogue', exact: true }).selectOption('end');
    await expect.poll(async () => (await get()).synchronization?.[0]?.members[0]?.anchor).toBe('end');
    const dialogue = page.locator('.beat-item.beat-dialogue');
    await dialogue.getByRole('spinbutton', { name: '结束', exact: true }).fill('6');
    await dialogue.getByRole('spinbutton', { name: '结束', exact: true }).press('Enter');
    await expect.poll(async () => (await get()).objects[0]!.actor!.animation!.clips[0]!.start).toBe(7);
    let state = await get();
    expect(state.audio[0]!.start).toBe(4);
    expect(state.objects[0]!.motionEvents![0]!.time).toBe(8);
    await page.getByRole('combobox', { name: '同步锚点 Sound', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${directory}/desktop-links.png` });
    await call('audio_update', { id: 'sound', patch: { start: 5 } });
    await expect(dialogue.getByRole('spinbutton', { name: '开始', exact: true })).toHaveValue('3');
    await expect(dialogue.getByRole('spinbutton', { name: '结束', exact: true })).toHaveValue('7');
    await call('object_update', { id: 'actor', patch: { locked: true } });
    state = await get();
    const failure = await call(
      'edit_batch',
      {
        commands: [
          { type: 'beat.update', payload: { id: 'dialogue', patch: { endTime: 8 } } },
          { type: 'audio.update', payload: { id: 'sound', patch: { start: 99 } } },
        ],
      },
      true,
    );
    expect(failure.code ?? failure.error?.code).toBe('LOCKED');
    expect(await get()).toEqual(state);
    await call('object_update', { id: 'actor', patch: { locked: false } });
    const beforeUnlink = await get();
    await page.getByRole('button', { name: '解除同步 Sound', exact: true }).click();
    await expect.poll(async () => (await get()).synchronization?.[0]?.members.length).toBe(3);
    await call('beat_update', { id: 'dialogue', patch: { endTime: 8 } });
    state = await get();
    expect(state.audio).toEqual(beforeUnlink.audio);
    expect(state.objects[0]!.actor!.animation!.clips[0]!.start).toBe(9);
    await page.reload();
    await page.getByRole('button', { name: '导演', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '同步锚点 Dialogue', exact: true })).toHaveValue('end');
    expect((await get()).synchronization).toEqual(state.synchronization);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '属性面板', exact: true }).click();
    await page.getByRole('combobox', { name: '同步锚点 Dialogue', exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: `${directory}/mobile-links.png` });
    expect(errors).toEqual([]);
    await writeFile(`${directory}/project.json`, JSON.stringify(state, null, 2));
    await writeFile(
      `${directory}/report.json`,
      JSON.stringify(
        {
          browserErrors: errors,
          checks: [
            'real MCP capability discovery',
            'UI creates editable links',
            'end anchors extend dialogue and shift actions/audio/events',
            'MCP updates UI',
            'locked batch rollback',
            'unlink preserves audio timing',
            'SQLite reload persistence',
            'desktop/mobile layout',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await writeFile(`${directory}/mcp-journal.json`, JSON.stringify(journal, null, 2));
    await client.close();
  }
});
