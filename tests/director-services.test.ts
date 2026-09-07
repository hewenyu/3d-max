import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../server/app';
import { Store } from '../server/store';
import type { ContinuityReport } from '../shared/continuity-types';
import type { Project } from '../shared/types';

function toolValue<T>(result: CallToolResult): T {
  assert.ok(!result.isError, JSON.stringify(result));
  const content = result.content.find((item) => item.type === 'text');
  assert.ok(content?.type === 'text');
  return JSON.parse(content.text) as T;
}

test('HTTP and public MCP preserve continuity decisions and portable project history across restoration', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'whiteframe-director-api-'));
  const config = {
    port: 0,
    dataDir,
    distDir: join(dataDir, 'dist'),
    appUrl: 'http://127.0.0.1:5173',
    apiUrl: 'http://127.0.0.1:4173',
    token: 'director-integration-secret',
  };
  const service = createApp(config);
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  config.apiUrl = url;
  const client = new Client({ name: 'director-integration', version: '1' });
  const post = (path: string, data: unknown) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  try {
    const original = service.store.newProject('Director restoration', 'demo');
    const camera = original.cameras[0];
    const project = service.store.commands({
      commands: [
        {
          type: 'object.create',
          payload: {
            id: 'camera-obstruction',
            type: 'box',
            position: [camera.position[0], camera.position[1] - 10, camera.position[2]],
            dimensions: [20, 20, 20],
          },
        },
      ],
    }).project;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      }),
    );
    const tools = (await client.listTools()).tools.map((item) => item.name);
    for (const name of [
      'continuity_analyze',
      'continuity_ignore',
      'project_package_export',
      'project_package_import',
    ])
      assert.ok(tools.includes(name), name);
    const invalid = {
      commands: [
        {
          type: 'object.update',
          payload: {
            id: 'camera-obstruction',
            patch: {
              keyframes: [
                { id: 'same-a', time: 0 },
                { id: 'same-b', time: 0 },
              ],
            },
          },
        },
      ],
      projectId: project.id,
      expectedRevision: project.revision,
    };
    const invalidResponse = await post('/api/commands', invalid);
    assert.equal(invalidResponse.status, 400);
    assert.equal(
      ((await invalidResponse.json()) as { error: { code: string } }).error.code,
      'VALIDATION_ERROR',
    );
    const invalidMcp = await client.callTool({ name: 'edit_batch', arguments: invalid });
    assert.equal(invalidMcp.isError, true);
    const invalidText = (invalidMcp.content as { type: string; text?: string }[]).find(
      (item) => item.type === 'text',
    )!.text!;
    assert.equal(JSON.parse(invalidText).error.code, 'VALIDATION_ERROR');
    assert.deepEqual(service.store.project(), project);
    const invalidPayload = {
      ...invalid,
      commands: [
        {
          type: 'object.update',
          payload: { id: 'camera-obstruction', patch: { position: ['invalid', 0, 0] } },
        },
      ],
    };
    const invalidHttpPayload = await post('/api/commands', invalidPayload);
    assert.equal(invalidHttpPayload.status, 400);
    const expectedError = await invalidHttpPayload.json();
    assert.equal(expectedError.error.code, 'VALIDATION_ERROR');
    assert.ok(
      expectedError.error.details.some((issue: { path: unknown[] }) => issue.path.includes('position')),
    );
    const invalidMcpPayload = await client.callTool({ name: 'edit_batch', arguments: invalidPayload });
    assert.equal(invalidMcpPayload.isError, true);
    const payloadError = (invalidMcpPayload.content as { type: string; text?: string }[]).find(
      (item) => item.type === 'text',
    )!.text!;
    assert.deepEqual(JSON.parse(payloadError), expectedError);
    assert.deepEqual(service.store.project(), project);
    const options = {
      projectId: project.id,
      expectedRevision: project.revision,
      sequenceId: project.activeSequenceId,
      sampleRate: 2,
    };
    const response = await post('/api/continuity', options);
    assert.equal(response.status, 200, await response.clone().text());
    const report = (await response.json()) as ContinuityReport;
    assert.ok(report.findings.some((finding) => finding.rule === 'camera-collision'));
    const remote = toolValue<ContinuityReport>(
      (await client.callTool({
        name: 'continuity_analyze',
        arguments: options,
      })) as CallToolResult,
    );
    assert.deepEqual(remote, report);
    assert.deepEqual(service.store.project(), project);
    assert.equal((await post('/api/continuity', { ...options, expectedRevision: 0 })).status, 409);
    assert.equal((await post('/api/continuity', { ...options, projectId: 'other-project' })).status, 409);
    assert.equal((await post('/api/continuity', { ...options, maxSamples: 1 })).status, 400);
    const findingId = report.findings[0].id;
    const reason = 'Intentional cut approved during review';
    toolValue(
      (await client.callTool({
        name: 'continuity_ignore',
        arguments: {
          findingId,
          reason,
          projectId: project.id,
          expectedRevision: project.revision,
          requestId: 'review-once',
        },
      })) as CallToolResult,
    );
    const ignored = service.store.project();
    assert.deepEqual(ignored.continuity?.ignored, [{ findingId, reason }]);
    const reviewed = toolValue<ContinuityReport>(
      (await client.callTool({
        name: 'continuity_analyze',
        arguments: { ...options, expectedRevision: ignored.revision },
      })) as CallToolResult,
    );
    assert.equal(reviewed.findings.find((finding) => finding.id === findingId)?.ignored, true);
    const archive = toolValue<{ downloadUrl: string; assets: number; videos: number }>(
      (await client.callTool({
        name: 'project_package_export',
        arguments: { projectId: project.id, includeVideos: false },
      })) as CallToolResult,
    );
    const download = await fetch(archive.downloadUrl);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
    const bytes = Buffer.from(await download.arrayBuffer());
    service.store.newProject('Unrelated workspace', 'empty');
    const form = new FormData();
    form.append('file', new Blob([bytes]), 'director.whiteframe');
    const restore = await fetch(`${url}/api/packages/import`, { method: 'POST', body: form });
    assert.equal(restore.status, 201, await restore.clone().text());
    const restored = ((await restore.json()) as { project: Project }).project;
    assert.notEqual(restored.id, ignored.id);
    assert.deepEqual(restored.continuity, ignored.continuity);
    const undo = await post('/api/history/undo', {
      projectId: restored.id,
      expectedRevision: restored.revision,
    });
    assert.equal(undo.status, 200);
    assert.equal(((await undo.json()) as Project).continuity, undefined);
    assert.equal((await post('/api/history/redo', { projectId: restored.id })).status, 200);
    assert.deepEqual(service.store.project().continuity, ignored.continuity);
    const second = toolValue<{ project: Project }>(
      (await client.callTool({
        name: 'project_package_import',
        arguments: { dataBase64: bytes.toString('base64') },
      })) as CallToolResult,
    );
    assert.notEqual(second.project.id, restored.id);
    assert.deepEqual(second.project.continuity, ignored.continuity);
    const persisted = new Store(dataDir, config.token);
    try {
      assert.equal(persisted.project().id, second.project.id);
      assert.deepEqual(persisted.project().continuity, ignored.continuity);
      assert.equal(persisted.history().canUndo, true);
    } finally {
      persisted.close();
    }
  } finally {
    await client.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
