import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../server/app';
import { Store } from '../server/store';
import type { ScriptBreakdown } from '../shared/script-schema';
import type { CommandResponse } from '../shared/types';

function value<T>(result: CallToolResult) {
  assert.ok(!result.isError, JSON.stringify(result));
  const text = result.content.find((item) => item.type === 'text');
  assert.ok(text?.type === 'text');
  return JSON.parse(text.text) as T;
}

test('HTTP and MCP parse identically; one script import is idempotent, persisted and one undo step', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'whiteframe-script-api-'));
  const config = {
    port: 0,
    dataDir,
    distDir: join(dataDir, 'dist'),
    appUrl: 'http://127.0.0.1:5173',
    apiUrl: 'http://127.0.0.1:4173',
    token: 'script-test-secret',
  };
  const service = createApp(config);
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  config.apiUrl = url;
  const client = new Client({ name: 'script-integration', version: '1' });
  try {
    const original = service.store.newProject('Script test', 'empty');
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      }),
    );
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('script_parse'));
    assert.ok(names.includes('script_apply'));
    const input = {
      format: 'fountain',
      source: 'Title: Gate\n\nINT. ROOM - DAY\n\nA door opens.\n\n@ALICE\nCome in.',
    };
    const response = await fetch(`${url}/api/script/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    const parsed = (await response.json()) as ScriptBreakdown;
    assert.deepEqual(
      value<ScriptBreakdown>(
        (await client.callTool({ name: 'script_parse', arguments: input })) as CallToolResult,
      ),
      parsed,
    );
    assert.deepEqual(service.store.project(), original);
    const args = {
      breakdown: parsed,
      options: { prefix: 'service-script' },
      projectId: original.id,
      expectedRevision: original.revision,
      expectedContext: { sceneId: null, performanceId: null },
      requestId: 'script-once',
    };
    const applied = value<CommandResponse>(
      (await client.callTool({ name: 'script_apply', arguments: args })) as CallToolResult,
    );
    assert.equal(applied.project.revision, original.revision + 1);
    assert.equal(applied.project.production!.storyScenes.length, 1);
    assert.equal(applied.project.beats.length, 2);
    assert.equal(applied.project.activeSequenceId, 'service-script-sequence');
    const retry = value<CommandResponse>(
      (await client.callTool({ name: 'script_apply', arguments: args })) as CallToolResult,
    );
    assert.deepEqual(retry.project, applied.project);
    assert.deepEqual(retry.results, applied.results);
    assert.equal(retry.replayed, true);
    assert.deepEqual(service.store.project(), applied.project);
    const persisted = new Store(dataDir, config.token);
    try {
      assert.deepEqual(persisted.project(), applied.project);
    } finally {
      persisted.close();
    }
    const invalid = (await client.callTool({
      name: 'script_apply',
      arguments: {
        ...args,
        requestId: 'bad-scenes',
        expectedRevision: applied.project.revision,
        expectedContext: {
          sceneId: applied.project.production!.activeSceneId,
          performanceId: applied.project.production!.activePerformanceId,
        },
        options: { sceneIds: ['missing'] },
      },
    })) as CallToolResult;
    assert.equal(invalid.isError, true);
    assert.deepEqual(service.store.project(), applied.project);
    value(
      (await client.callTool({
        name: 'history_undo',
        arguments: { projectId: original.id, expectedRevision: applied.project.revision },
      })) as CallToolResult,
    );
    const undone = service.store.project();
    assert.equal(undone.production, undefined);
    assert.deepEqual(undone.objects, original.objects);
    assert.deepEqual(undone.shots, original.shots);
    value(
      (await client.callTool({
        name: 'history_redo',
        arguments: { projectId: original.id, expectedRevision: undone.revision },
      })) as CallToolResult,
    );
    assert.deepEqual(service.store.project().production, applied.project.production);
  } finally {
    await client.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
