import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/app';
import { commandDefinitions } from '../shared/commands';
import type { CommandResponse, Project } from '../shared/types';
import { skinnedModelAsset } from './fixtures/skinned-model';
import { mcpCommandCases, mcpCommandSeed } from './fixtures/mcp-command-cases';

function content(project: Project) {
  const { revision: _revision, updatedAt: _updatedAt, ...value } = project;
  return value;
}

test('every declared editing tool changes real shared state through its standalone MCP schema and supports exact undo', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'whiteframe-mcp-catalog-'));
  const config = {
    port: 0,
    dataDir,
    distDir: join(dataDir, 'dist'),
    appUrl: 'http://127.0.0.1:5173',
    apiUrl: 'http://127.0.0.1:4173',
    token: 'catalog-local-test',
  };
  const service = createApp(config);
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => listener.once('listening', done));
  config.apiUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const client = new Client({ name: 'complete-command-catalog', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${config.apiUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
    }),
  );
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, `${name}: ${JSON.stringify(response)}`);
    const text = (response.content as { type: string; text?: string }[]).find(
      (part) => part.type === 'text',
    )?.text;
    assert.ok(text, `${name} omitted structured text`);
    return JSON.parse(text) as T;
  };
  try {
    const tools = (await client.listTools()).tools;
    const model = await call<{ url: string }>('asset_import', {
      name: 'catalog.glb',
      dataBase64: (await skinnedModelAsset(true)).toString('base64'),
    });
    const audio = await call<{ url: string }>('asset_import', {
      name: 'catalog.wav',
      dataBase64: (await readFile(new URL('./fixtures/face-dialogue-zh.wav', import.meta.url))).toString(
        'base64',
      ),
    });
    const cases = mcpCommandCases(audio.url);
    assert.deepEqual(
      cases.map((value) => value.type).sort(),
      commandDefinitions.map((definition) => definition.type).sort(),
      'Every registered editing command requires a real standalone schema exercise',
    );
    const empty = await call<Project>('project_new', { name: 'Command catalog seed', template: 'empty' });
    const seed = await call<CommandResponse>('edit_batch', {
      projectId: empty.id,
      expectedRevision: empty.revision,
      commands: mcpCommandSeed(model.url, audio.url),
    });
    for (const fixture of cases) {
      await t.test(fixture.type, async () => {
        const name = fixture.type.replaceAll('.', '_');
        const tool = tools.find((entry) => entry.name === name);
        assert.ok(tool, `Missing tools/list entry: ${name}`);
        assert.equal(tool.inputSchema.type, 'object');
        let before = await call<Project>('project_import', { project: seed.project });
        if (fixture.setup?.length)
          before = (
            await call<CommandResponse>('edit_batch', {
              projectId: before.id,
              expectedRevision: before.revision,
              commands: fixture.setup,
            })
          ).project;
        const payload = typeof fixture.payload === 'function' ? fixture.payload(before) : fixture.payload;
        const result = await call<CommandResponse>(name, {
          ...payload,
          projectId: before.id,
          expectedRevision: before.revision,
          requestId: `catalog-${fixture.type}`,
        });
        assert.equal(result.project.id, before.id);
        assert.equal(result.project.revision, before.revision + 1);
        assert.notDeepEqual(
          content(result.project),
          content(before),
          `${name} returned success without an actual edit`,
        );
        assert.deepEqual(
          await (await fetch(`${config.apiUrl}/api/project`)).json(),
          result.project,
          'MCP and HTTP must expose the identical edited project',
        );
        const undone = await call<Project>('history_undo', {
          projectId: before.id,
          expectedRevision: result.project.revision,
        });
        assert.deepEqual(content(undone), content(before), `${name} did not preserve exact undo state`);
      });
    }
  } finally {
    await client.close();
    await new Promise<void>((done, reject) => listener.close((error) => (error ? reject(error) : done())));
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
