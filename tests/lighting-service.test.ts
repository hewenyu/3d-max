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
import { lightingCommandDefinitions } from '../shared/lighting-commands';
import { resolveLighting } from '../shared/lighting-plans';
import type { CommandResponse } from '../shared/types';

test('all lighting tools share HTTP state, SQLite history, revisions, locks and idempotent replay', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'whiteframe-lighting-api-'));
  const config = {
    port: 0,
    dataDir,
    distDir: join(dataDir, 'dist'),
    appUrl: 'http://127.0.0.1:5173',
    apiUrl: 'http://127.0.0.1:4173',
    token: 'lighting-test-secret',
  };
  const service = createApp(config);
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  config.apiUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const client = new Client({ name: 'lighting-integration', version: '1' });
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(
      (result.content as { type: string; text?: string }[]).find((item) => item.type === 'text')!.text!,
    ) as T;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${config.apiUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      }),
    );
    const catalog = (await client.listTools()).tools;
    for (const definition of lightingCommandDefinitions) {
      const tool = catalog.find((item) => item.name === definition.type.replaceAll('.', '_'));
      assert.ok(tool?.inputSchema.properties);
    }
    const original = service.store.project();
    const args = {
      id: 'key',
      name: 'Key',
      lighting: { intensity: 3, ambient: 0.2, azimuth: -90, elevation: 30 },
      expectedRevision: original.revision,
      requestId: 'lighting-create-once',
    };
    const created = await call<CommandResponse>('lighting_plan_create', args);
    const replay = await call<CommandResponse>('lighting_plan_create', args);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.project, created.project);
    await call('lighting_plan_duplicate', { id: 'key', newId: 'fill', name: 'Fill' });
    await call('lighting_plan_update', {
      id: 'fill',
      patch: { lighting: { ...args.lighting, ambient: 1.5 } },
    });
    await call('lighting_scene_bind', { planId: 'key' });
    const bound = await call<CommandResponse>('lighting_shot_bind', {
      shotId: original.shots[0].id,
      planId: 'fill',
    });
    assert.equal(resolveLighting(bound.project, bound.project.shots[0]).ambient, 1.5);
    const http = await (await fetch(`${config.apiUrl}/api/project`)).json();
    assert.deepEqual(http, bound.project);
    const restarted = new Store(dataDir, config.token);
    try {
      assert.deepEqual(restarted.project(), bound.project);
    } finally {
      restarted.close();
    }
    await call('history_undo', { projectId: original.id, expectedRevision: bound.project.revision });
    assert.equal(service.store.project().shots[0].lightingPlanId, undefined);
    await call('history_redo', {
      projectId: original.id,
      expectedRevision: service.store.project().revision,
    });
    assert.equal(service.store.project().shots[0].lightingPlanId, 'fill');
    await call('shot_update', { id: original.shots[0].id, patch: { locked: true } });
    const before = service.store.project();
    const locked = await client.callTool({
      name: 'lighting_plan_update',
      arguments: { id: 'fill', patch: { lighting: args.lighting } },
    });
    assert.equal(locked.isError, true);
    assert.match(JSON.stringify(locked), /LOCKED/);
    assert.deepEqual(service.store.project(), before);
    const stale = await client.callTool({
      name: 'lighting_plan_update',
      arguments: { id: 'fill', patch: { name: 'Stale' }, expectedRevision: 0 },
    });
    assert.equal(stale.isError, true);
    await call('shot_update', { id: original.shots[0].id, patch: { locked: false } });
    await call('lighting_shot_bind', { shotId: original.shots[0].id, planId: null });
    await call('lighting_plan_delete', { id: 'fill' });
    assert.equal(service.store.project().lightingPlans?.length, 1);
  } finally {
    await client.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
