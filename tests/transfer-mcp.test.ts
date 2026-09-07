import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTransferTools } from '../server/transfer-mcp';
import { installAssetRoutes, type AssetImportResult } from '../server/assets';
import { errorBody, errorStatus } from '../server/errors';
import { exportProjectPackage, type PackageImportResult } from '../server/project-packages';
import { chunkInput, largeModel, transferFixture, transferInput } from './fixtures/transfers';

async function sdkFixture() {
  const fixture = await transferFixture();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  installAssetRoutes(app, fixture.config, fixture.store);
  app.all('/mcp', async (request, response) => {
    const server = new McpServer({ name: 'transfer-test', version: '1' });
    registerTransferTools(server, fixture.store, fixture.config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.once('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    response.status(errorStatus(error)).json(errorBody(error));
  };
  app.use(errors);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => listener.once('listening', done));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const client = new Client({ name: 'large-transfer-client', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const raw = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const content = (response.content as { type: string; text?: string }[]).find(
      (part) => part.type === 'text',
    );
    assert.ok(content?.text, `${name} must return structured text`);
    return { response, value: JSON.parse(content.text) };
  };
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await raw(name, args);
    assert.ok(!result.response.isError, `${name}: ${JSON.stringify(result.value)}`);
    return result.value as T;
  };
  return {
    ...fixture,
    url,
    client,
    raw,
    call,
    async upload<T>(
      bytes: Buffer,
      kind: 'asset' | 'project-package',
      name: string,
    ): Promise<{ id: string; result: T }> {
      const transfer = await call<{ id: string; totalChunks: number }>(
        'transfer_begin',
        transferInput(bytes, kind, name),
      );
      for (let index = transfer.totalChunks - 1; index >= 0; index--)
        await call('transfer_chunk', chunkInput(transfer.id, bytes, index));
      const status = await call<{ missingChunks: number[]; receivedBytes: number }>('transfer_status', {
        id: transfer.id,
      });
      assert.deepEqual(status.missingChunks, []);
      assert.equal(status.receivedBytes, bytes.length);
      return { id: transfer.id, result: await call<T>('transfer_commit', { id: transfer.id }) };
    },
    async close() {
      await client.close();
      await new Promise<void>((done, reject) => listener.close((error) => (error ? reject(error) : done())));
      await fixture.close();
    },
  };
}

test('real MCP SDK imports a GLB and portable package larger than the legacy 24 MiB raw ceiling', async () => {
  const source = await sdkFixture();
  const target = await sdkFixture();
  try {
    assert.deepEqual((await source.client.listTools()).tools.map((tool) => tool.name).sort(), [
      'transfer_begin',
      'transfer_cancel',
      'transfer_chunk',
      'transfer_commit',
      'transfer_status',
    ]);
    const model = largeModel();
    assert.ok(model.length > 24 * 1024 * 1024);
    const imported = await source.upload<AssetImportResult>(model, 'asset', 'large.glb');
    assert.deepEqual(await readFile(source.store.asset(imported.result.id)!.path), model);
    assert.deepEqual(await source.call('transfer_commit', { id: imported.id }), imported.result);
    source.store.commands({
      commands: [{ type: 'object.create', payload: { type: 'model', assetUrl: imported.result.url } }],
    });
    const archive = await exportProjectPackage(source.store, source.config, { includeHistory: true });
    assert.ok(
      archive.data.length > 24 * 1024 * 1024,
      `Compressed package must exercise the old ceiling: ${archive.data.length}`,
    );
    const restored = await target.upload<PackageImportResult>(
      archive.data,
      'project-package',
      'large.whiteframe',
    );
    assert.equal(restored.result.assets, 1);
    assert.notEqual(restored.result.project.id, source.store.project().id);
    assert.deepEqual(await readFile(target.store.asset(imported.result.id)!.path), model);
    const other = target.store.newProject('Current working project', 'empty');
    assert.deepEqual(await target.call('transfer_commit', { id: restored.id }), restored.result);
    assert.equal(target.store.project().id, other.id);
    const completed = await target.call<{ state: string }>('transfer_cancel', { id: restored.id });
    assert.equal(completed.state, 'completed');
    assert.equal(target.store.projects().length, 3);
    assert.equal((await target.call<unknown[]>('transfer_status')).length, 1);
  } finally {
    await source.close();
    await target.close();
  }
});

test('Web multipart and MCP chunk imports share malformed model, remote dependency and audio validation', async () => {
  const fixture = await sdkFixture();
  try {
    for (const [name, bytes, expectedCode] of [
      ['invalid.glb', Buffer.from('invalid glb'), 'INVALID_MODEL'],
      [
        'external.gltf',
        Buffer.from(
          JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.com/data.bin' }] }),
        ),
        'EXTERNAL_ASSET',
      ],
      ['invalid.wav', Buffer.from('invalid audio'), 'INVALID_ASSET'],
    ] as const) {
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(bytes)]), name);
      const response = await fetch(`${fixture.url}/api/assets`, { method: 'POST', body: form });
      assert.equal(response.status, 400);
      const http = await response.json();
      const transfer = await fixture.call<{ id: string }>(
        'transfer_begin',
        transferInput(bytes, 'asset', name),
      );
      await fixture.call('transfer_chunk', chunkInput(transfer.id, bytes));
      const mcp = await fixture.raw('transfer_commit', { id: transfer.id });
      assert.equal(mcp.response.isError, true);
      assert.equal(mcp.value.error.code, expectedCode);
      assert.equal(mcp.value.error.code, http.error.code);
      await fixture.call('transfer_cancel', { id: transfer.id });
    }
    const audio = await readFile(new URL('./fixtures/face-dialogue-zh.wav', import.meta.url));
    const result = await fixture.upload<AssetImportResult>(audio, 'asset', 'valid.wav');
    assert.ok(result.result.duration! > 0);
    assert.deepEqual(await readFile(fixture.store.asset(result.result.id)!.path), audio);
  } finally {
    await fixture.close();
  }
});
