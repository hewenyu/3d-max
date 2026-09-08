import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NodeIO } from '@gltf-transform/core';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { createApp } from '../server/app';
import { geometryToMesh, meshVolume } from '../shared/modeling-geometry';
import { diagnoseMesh } from '../shared/topology/diagnostics';
import type { CommandResponse, Project } from '../shared/types';
import type { MeshDiagnostics } from '../shared/topology/diagnostics';
import { architectureArchCommands, archOpeningArea } from './fixtures/boolean-arches';

test('public MCP exports closed architectural Boolean geometry and repeats it after dependency undo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-boolean-output-'));
  const config = {
    port: 0,
    dataDir: directory,
    distDir: join(directory, 'dist'),
    apiUrl: 'http://127.0.0.1:4173',
    appUrl: 'http://127.0.0.1:5173',
    token: 'boolean-output-test',
  };
  const service = createApp(config);
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  config.apiUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const client = new Client({ name: 'boolean-output-integration', version: '1' });
  const call = async <T>(name: string, arguments_: Record<string, unknown> = {}): Promise<T> => {
    const response = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 30000 });
    const item = (response.content as { type: string; text?: string }[]).find(
      (value) => value.type === 'text',
    );
    assert.ok(item?.text);
    assert.ok(!response.isError, item.text);
    return JSON.parse(item.text) as T;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${config.apiUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      }),
    );
    let project = await call<Project>('project_new', {
      name: 'Three real architectural arches',
      template: 'empty',
    });
    const guard = () => ({
      projectId: project.id,
      expectedRevision: project.revision,
      expectedContext: { sceneId: null, performanceId: null },
    });
    project = (
      await call<CommandResponse>('edit_batch', { ...guard(), commands: architectureArchCommands() })
    ).project;
    const inspect = () =>
      call<{ diagnostics: MeshDiagnostics }>('mesh_inspect', {
        ...guard(),
        objectId: 'front-wall',
        stage: 'evaluated',
        kind: 'face',
        limit: 1,
      });
    const inspected = await inspect();
    assert.equal(inspected.diagnostics.closed, true);
    assert.deepEqual(inspected.diagnostics.duplicateVertices, []);
    const exportGlb = async () => {
      const result = await call<{ url: string; sha256: string }>('model_export', {
        ...guard(),
        scope: 'selection',
        objectIds: ['front-wall'],
        sourceTime: 0,
        name: 'watertight-arches',
      });
      const response = await fetch(new URL(result.url, config.apiUrl));
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sha256);
      const document = await new NodeIO().readBinary(bytes);
      const primitives = document
        .getRoot()
        .listMeshes()
        .flatMap((mesh) => mesh.listPrimitives());
      assert.equal(primitives.length, 1);
      const primitive = primitives[0];
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        'position',
        new Float32BufferAttribute(primitive.getAttribute('POSITION')!.getArray()!, 3),
      );
      geometry.setIndex(Array.from(primitive.getIndices()!.getArray()!));
      try {
        const mesh = geometryToMesh(geometry);
        const diagnostics = diagnoseMesh(mesh);
        assert.equal(diagnostics.closed, true);
        assert.deepEqual(diagnostics.duplicateVertices, []);
        return { sha256: result.sha256, volume: meshVolume(mesh) };
      } finally {
        geometry.dispose();
      }
    };
    const before = await exportGlb();
    const ideal = 12 * 4.4 * 0.36 - 3 * archOpeningArea * 0.36;
    assert.ok(before.volume < ideal && before.volume > ideal - 0.1);
    project = (
      await call<CommandResponse>('object_update', {
        ...guard(),
        id: 'arch-cutter-0',
        patch: { scale: [1, 1.12, 1] },
      })
    ).project;
    assert.equal((await inspect()).diagnostics.closed, true);
    const after = await exportGlb();
    assert.notEqual(before.sha256, after.sha256);
    assert.ok(after.volume < before.volume - 0.2);
    project = await call<Project>('history_undo', {
      projectId: project.id,
      expectedRevision: project.revision,
    });
    assert.deepEqual(await exportGlb(), before);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
