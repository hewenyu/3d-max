import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/app';
import { Store } from '../server/store';
import type { CommandResponse } from '../shared/types';

test('modifier MCP edits persist, replay idempotently and undo as one transaction', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'whiteframe-modifier-api-'));
  const config = {
    port: 0,
    dataDir,
    distDir: join(dataDir, 'dist'),
    appUrl: 'http://127.0.0.1:5173',
    apiUrl: 'http://127.0.0.1:4173',
    token: 'modifier-test-secret',
  };
  const service = createApp(config);
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  config.apiUrl = url;
  const client = new Client({ name: 'modifier-integration', version: '1' });
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    const text = (result.content as { type: string; text?: string }[]).find((item) => item.type === 'text')!;
    return JSON.parse(text.text!) as T;
  };
  try {
    const original = service.store.newProject('Modifier test', 'empty');
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      }),
    );
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      'modifier_add',
      'modifier_set',
      'modifier_remove',
      'modifier_reorder',
      'modifier_bake',
    ])
      assert.ok(names.includes(name));
    await call('object_create', {
      id: 'box',
      type: 'box',
      name: 'Source box',
      projectId: original.id,
      expectedRevision: original.revision,
    });
    const before = service.store.project();
    const args = {
      id: 'box',
      modifier: { id: 'row', type: 'array', offset: [3, 0, 0], count: 3 },
      projectId: before.id,
      expectedRevision: before.revision,
      requestId: 'same-modifier',
    };
    const applied = await call<CommandResponse>('modifier_add', args);
    assert.equal(applied.project.objects[0].modeling!.kind, 'stack');
    const retry = await call<CommandResponse>('modifier_add', args);
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.project, applied.project);
    const persisted = new Store(dataDir, config.token);
    try {
      assert.deepEqual(persisted.project(), applied.project);
    } finally {
      persisted.close();
    }
    await call('history_undo', { projectId: before.id, expectedRevision: applied.project.revision });
    assert.deepEqual(service.store.project().objects, before.objects);
    await call('history_redo', { projectId: before.id, expectedRevision: service.store.project().revision });
    assert.deepEqual(service.store.project().objects, applied.project.objects);
    const invalid = await client.callTool({
      name: 'modifier_set',
      arguments: {
        ...args,
        requestId: 'invalid-zero',
        expectedRevision: service.store.project().revision,
        modifier: { ...args.modifier, offset: [0, 0, 0] },
      },
    });
    assert.equal(invalid.isError, true);
    assert.deepEqual(service.store.project().objects, applied.project.objects);
  } finally {
    await client.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
