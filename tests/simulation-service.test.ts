import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/app';
import { simulateProject } from '../server/simulation-service';
import { Store } from '../server/store';
import type { CommandResponse, Project } from '../shared/types';

function bodies(store: Store) {
  store.newProject('Physics integration', 'empty');
  return store.commands({
    commands: [
      {
        type: 'object.create',
        payload: { id: 'floor', type: 'box', position: [0, -0.5, 0], dimensions: [10, 0.5, 10] },
      },
      { type: 'physics.body.set', payload: { id: 'floor', body: { mode: 'static' } } },
      {
        type: 'object.create',
        payload: { id: 'ball', type: 'sphere', position: [0, 2, 0], dimensions: [1, 1, 1] },
      },
      { type: 'physics.body.set', payload: { id: 'ball', body: { mode: 'dynamic', shape: 'sphere' } } },
    ],
  }).project;
}

test('physics HTTP and real MCP commands share editable state and durable idempotency', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'whiteframe-simulation-api-'));
  const config = {
    port: 0,
    dataDir,
    distDir: join(dataDir, 'dist'),
    appUrl: 'http://127.0.0.1:5173',
    apiUrl: 'http://127.0.0.1:4173',
    token: 'simulation-test-secret',
  };
  const service = createApp(config);
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  config.apiUrl = url;
  const client = new Client({ name: 'physics-test', version: '1' });
  try {
    const project = bodies(service.store);
    const request = {
      projectId: project.id,
      expectedRevision: project.revision,
      requestId: 'physics-bake-once',
      options: { duration: 1.5, fps: 24 },
    };
    const response = await fetch(`${url}/api/simulation/bake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const baked = (await response.json()) as CommandResponse;
    const ball = baked.project.objects.find((object) => object.id === 'ball')!;
    assert.equal(ball.keyframes.length, 37);
    assert.ok(ball.keyframes.at(-1)!.position![1] < 0.1);
    assert.equal(ball.rotationInterpolation, 'quaternion');
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      }),
    );
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'simulation_bake'));
    assert.ok(tools.tools.some((tool) => tool.name === 'actor_clip_set'));
    assert.ok(tools.tools.some((tool) => tool.name === 'camera_optics_set'));
    const replay = await client.callTool({ name: 'simulation_bake', arguments: request });
    assert.ok(!replay.isError, JSON.stringify(replay));
    const text = (replay.content as { type: string; text?: string }[]).find(
      (item) => item.type === 'text',
    )!.text!;
    assert.equal((JSON.parse(text) as CommandResponse).replayed, true);
    assert.equal(service.store.project().revision, baked.project.revision);
    const conflict = await client.callTool({
      name: 'simulation_bake',
      arguments: { ...request, options: { duration: 2, fps: 24 } },
    });
    assert.equal(conflict.isError, true);
    const saved = new Store(dataDir, config.token);
    try {
      const restored = await simulateProject(saved, request);
      assert.equal(restored.replayed, true);
      assert.deepEqual(restored.project, baked.project);
    } finally {
      saved.close();
    }
  } finally {
    await client.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('physics rejects concurrent edits and preserves inactive takes and locks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-simulation-races-'));
  const store = new Store(directory);
  try {
    bodies(store);
    const before = store.project();
    const pending = simulateProject(store, {
      options: { duration: 0.5 },
      projectId: before.id,
      expectedRevision: before.revision,
    });
    store.commands({ commands: [{ type: 'project.update', payload: { name: 'Concurrent edit' } }] });
    await assert.rejects(pending, { code: 'REVISION_CONFLICT' });
    assert.equal(store.project().objects.find((object) => object.id === 'ball')!.keyframes.length, 0);
    store.commands({ commands: [{ type: 'production.initialize', payload: {} }] });
    const project = store.project();
    const sceneId = project.production!.activeSceneId;
    const takeId = project.production!.activePerformanceId;
    store.commands({
      commands: [
        {
          type: 'performance.duplicate',
          payload: { sceneId, id: takeId, newId: 'sim-take', name: 'Simulation' },
        },
      ],
    });
    const baked = await simulateProject(store, { options: { duration: 0.5 } });
    const original = baked.project.production!.scenes[0]!.performances.find((take) => take.id === takeId)!;
    assert.equal(original.tracks.find((track) => track.objectId === 'ball')!.keyframes.length, 0);
    store.commands({
      commands: [
        { type: 'performance.update', payload: { sceneId, id: 'sim-take', patch: { locked: true } } },
      ],
    });
    const locked: Project = store.project();
    await assert.rejects(
      simulateProject(store, { options: { duration: 0.25, gravity: [0, 0, 0] } }),
      /Performance is locked/,
    );
    assert.deepEqual(store.project(), locked);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
