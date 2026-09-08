import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/app';
import type { Project, CommandResponse } from '../shared/types';
import type { ModelingJob } from '../shared/modeling-jobs';
import {
  exerciseModelingCatalog,
  modelingGuard,
  modelingServiceNames,
  modelingServiceSeed,
  waitModelingJob,
  type ModelingCall,
  type ModelingHttp,
} from './fixtures/modeling-service-cases';

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'whiteframe-modeling-services-'));
  const config = {
    port: 0,
    dataDir,
    distDir: join(dataDir, 'dist'),
    appUrl: 'http://127.0.0.1:5173',
    apiUrl: 'http://127.0.0.1:4173',
    token: 'modeling-service-test',
  };
  const service = createApp(config);
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  config.apiUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const client = new Client({ name: 'modeling-service-integration', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${config.apiUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
    }),
  );
  const success = new Set<string>();
  const raw = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    const part = (response.content as { type: string; text?: string }[]).find((item) => item.type === 'text');
    assert.ok(part?.text, `${name} requires structured JSON`);
    return { isError: response.isError, value: JSON.parse(part.text) };
  };
  const call: ModelingCall = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const response = await raw(name, args);
    assert.ok(!response.isError, `${name}: ${JSON.stringify(response.value)}`);
    success.add(name);
    return response.value as T;
  };
  const http: ModelingHttp = async <T>(path: string, body?: Record<string, unknown>, method?: string) => {
    const response = await fetch(`${config.apiUrl}${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(value)}`);
    return value as T;
  };
  return {
    call,
    raw,
    http,
    client,
    success,
    apiUrl: config.apiUrl,
    close: async () => {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('all eleven modeling MCP services execute actual geometry and expose equivalent HTTP state without a browser', async () => {
  const f = await fixture();
  try {
    const tools = (await f.client.listTools()).tools;
    for (const name of modelingServiceNames) assert.ok(tools.some((tool) => tool.name === name));
    const evidence = await exerciseModelingCatalog(f.call, f.http);
    assert.equal(evidence.services.length, 11);
    assert.deepEqual(
      modelingServiceNames.filter((name) => !f.success.has(name)),
      [],
    );
  } finally {
    await f.close();
  }
});

test('MCP worker queue permits reads and user edits; stale work fails and request conflicts match HTTP', async () => {
  const f = await fixture();
  try {
    const project = await modelingServiceSeed(f.call);
    const input = {
      ...modelingGuard(project),
      requestId: 'concurrent',
      commands: [{ type: 'topology.bevel', payload: { id: 'target', width: 0.15, segments: 16 } }],
    };
    const active = await f.call<ModelingJob>('modeling_job_start', input);
    const queued = await f.call<ModelingJob>('modeling_job_start', { ...input, requestId: 'queued' });
    assert.equal(queued.status, 'queued');
    assert.equal((await f.call<ModelingJob>('modeling_job_start', input)).id, active.id);
    const changedInput = {
      ...input,
      commands: [{ type: 'object.update', payload: { id: 'target', patch: { name: 'Conflict' } } }],
    };
    const mcpError = await f.raw('modeling_job_start', changedInput);
    assert.equal(mcpError.isError, true);
    assert.equal(mcpError.value.error.code, 'IDEMPOTENCY_CONFLICT');
    const httpConflict = await fetch(`${f.apiUrl}/api/modeling/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changedInput),
    });
    assert.equal(httpConflict.status, 409);
    assert.deepEqual(await httpConflict.json(), mcpError.value);
    assert.deepEqual(await f.http('/api/project'), project);
    assert.equal((await f.call<ModelingJob>('modeling_job_status', { id: active.id })).status, 'running');
    const edited = (
      await f.call<CommandResponse>('edit_batch', {
        ...modelingGuard(project),
        commands: [
          { type: 'object.update', payload: { id: 'target', patch: { name: 'User edit during worker' } } },
        ],
      })
    ).project;
    const cancelled = await f.call<ModelingJob>('modeling_job_cancel', { id: queued.id });
    assert.equal(cancelled.status, 'cancelled');
    const failed = await waitModelingJob(f.call, active.id);
    assert.equal(failed.status, 'failed');
    assert.ok(['REVISION_CONFLICT', 'SNAPSHOT_CONFLICT'].includes(failed.error?.code ?? ''));
    assert.deepEqual(await f.call<Project>('project_get'), edited);
    const stale = await f.raw('modeling_job_start', { ...input, requestId: 'stale' });
    assert.equal(stale.isError, true);
    assert.equal(stale.value.error.code, 'REVISION_CONFLICT');
    const staleRead = await f.raw('mesh_inspect', { ...modelingGuard(project), objectId: 'target' });
    assert.equal(staleRead.value.error.code, 'REVISION_MISMATCH');
    const undone = await f.call<Project>('history_undo', {
      projectId: edited.id,
      expectedRevision: edited.revision,
    });
    assert.deepEqual(undone.objects, project.objects);
    assert.equal((await f.call<ModelingJob>('modeling_job_status', { id: active.id })).status, 'failed');
  } finally {
    await f.close();
  }
});

test('MCP rejects invalid context and missing job IDs and cancels active loading without project changes', async () => {
  const f = await fixture();
  try {
    const project = await modelingServiceSeed(f.call);
    const input = {
      ...modelingGuard(project),
      requestId: 'cancel-active',
      commands: [{ type: 'topology.bevel', payload: { id: 'target', width: 0.1, segments: 16 } }],
    };
    const wrongContext = await f.raw('modeling_job_start', {
      ...input,
      expectedContext: { sceneId: 'missing', performanceId: null },
    });
    assert.equal(wrongContext.isError, true);
    assert.equal(wrongContext.value.error.code, 'CONTEXT_CONFLICT');
    const missing = await f.raw('modeling_job_status', { id: 'not-a-job' });
    assert.equal(missing.value.error.code, 'NOT_FOUND');
    const started = await f.call<ModelingJob>('modeling_job_start', input);
    await waitModelingJob(f.call, started.id, (job) => job.status === 'running');
    assert.equal((await f.call<ModelingJob>('modeling_job_cancel', { id: started.id })).status, 'cancelled');
    assert.deepEqual(await f.call<Project>('project_get'), project);
    assert.deepEqual(await f.http('/api/project'), project);
    assert.equal((await f.http<ModelingJob>(`/api/modeling/jobs/${started.id}`)).status, 'cancelled');
  } finally {
    await f.close();
  }
});

test('worker-backed legacy export preserves HTTP 422 and the same structured MCP failure for empty geometry', async () => {
  const f = await fixture();
  try {
    const project = await f.call<Project>('project_new', { name: 'Empty export error', template: 'empty' });
    const input = { ...modelingGuard(project), scope: 'scene' };
    const mcp = await f.raw('model_export', input);
    assert.equal(mcp.isError, true);
    assert.equal(mcp.value.error.code, 'EMPTY_EXPORT');
    const response = await fetch(`${f.apiUrl}/api/modeling/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), mcp.value);
    assert.deepEqual(await f.call<Project>('project_get'), project);
  } finally {
    await f.close();
  }
});
