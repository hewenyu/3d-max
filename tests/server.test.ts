import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../server/app.ts';
import { Store } from '../server/store.ts';
import { audioSegments } from '../server/audio.ts';
import { encoderArguments } from '../server/encoder.ts';
import { validateModel } from '../server/assets.ts';
import { createDemoProject } from '../shared/project.ts';
import type { Command, Project, RenderJob } from '../shared/types.ts';

test('HTTP project transactions, authorization, MCP and SQLite persistence', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), '.whiteframe-server-'));
  const config = {
    port: 0,
    dataDir,
    distDir: join(dataDir, 'dist'),
    appUrl: 'http://127.0.0.1:5173',
    apiUrl: 'http://127.0.0.1:4173',
    token: 'test-mcp-secret',
  };
  const service = createApp(config);
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => listener.once('listening', done));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  config.apiUrl = url;
  const read = async (): Promise<Project> => (await fetch(`${url}/api/project`)).json();
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  try {
    await t.test(
      'optimistic revisions allow only one concurrent writer and requests replay once',
      async () => {
        const project = await read();
        const updates = ['First writer', 'Second writer'].map((name) => ({
          expectedRevision: project.revision,
          commands: [{ type: 'project.update', payload: { name } }],
        }));
        const responses = await Promise.all(updates.map((body) => post('/api/commands', body)));
        assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
        const current = await read();
        assert.equal(current.revision, project.revision + 1);
        const request = {
          expectedRevision: current.revision,
          requestId: 'stable-create-request',
          commands: [{ type: 'object.create', payload: { id: 'server_test_box', type: 'box', name: 'Box' } }],
        };
        const first = await post('/api/commands', request);
        assert.equal(first.status, 200);
        const retry = await post('/api/commands', request);
        const result = await retry.json();
        assert.equal(result.replayed, true);
        assert.equal((await read()).objects.filter((object) => object.id === 'server_test_box').length, 1);
        assert.equal(
          (
            await post('/api/commands', {
              ...request,
              commands: [{ type: 'project.update', payload: { name: 'Different request' } }],
            })
          ).status,
          409,
        );
      },
    );

    await t.test('a locked edit rolls the entire batch back and undo uses increasing revisions', async () => {
      assert.equal(
        (
          await post('/api/commands', {
            commands: [
              { type: 'object.update', payload: { id: 'server_test_box', patch: { locked: true } } },
            ],
          })
        ).status,
        200,
      );
      const before = await read();
      const commands: Command[] = [
        { type: 'project.update', payload: { name: 'Should roll back' } },
        { type: 'object.update', payload: { id: 'server_test_box', patch: { position: [10, 0, 0] } } },
      ];
      const failed = await post('/api/commands', { commands });
      assert.equal(failed.status, 409);
      assert.equal((await failed.json()).error.code, 'LOCKED');
      assert.deepEqual(await read(), before);
      const undone = (await (await post('/api/history/undo', {})).json()) as Project;
      assert.equal(undone.revision, before.revision + 1);
      assert.equal(undone.objects.find((object) => object.id === 'server_test_box')?.locked, false);
      const redone = (await (await post('/api/history/redo', {})).json()) as Project;
      assert.equal(redone.revision, before.revision + 2);
      assert.equal(redone.objects.find((object) => object.id === 'server_test_box')?.locked, true);
    });

    await t.test('foreign origins, invalid hosts and missing MCP credentials are rejected', async () => {
      const body = { commands: [{ type: 'project.update', payload: { name: 'Untrusted' } }] };
      assert.equal((await post('/api/commands', body, { Origin: 'https://untrusted.example' })).status, 403);
      const invalidHost = await new Promise<number | undefined>((done, reject) => {
        const request = httpRequest(
          `${url}/api/project`,
          { headers: { Host: 'untrusted.example' } },
          (response) => {
            response.resume();
            done(response.statusCode);
          },
        );
        request.on('error', reject);
        request.end();
      });
      assert.equal(invalidHost, 403);
      assert.equal((await post('/mcp', {})).status, 401);
      assert.equal((await post('/mcp', {}, { Authorization: 'Bearer wrong-token' })).status, 401);
      assert.equal((await post('/api/project/import', { invalid: true })).status, 400);
      assert.equal((await post('/api/commands', { commands: [null] })).status, 400);
    });

    await t.test('MCP SDK discovers real schemas and edits the same browser project', async () => {
      const client = new Client({ name: 'integration-test', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
        }),
      );
      try {
        const tools = await client.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === 'preview_capture'));
        assert.ok(tools.tools.some((tool) => tool.name === 'render_start'));
        const create = tools.tools.find((tool) => tool.name === 'object_create');
        assert.ok(create?.inputSchema.properties?.type);
        const result = await client.callTool({
          name: 'project_update',
          arguments: {
            name: 'Changed through MCP',
            expectedRevision: (await read()).revision,
            requestId: 'mcp-edit-test',
          },
        });
        assert.ok(!result.isError);
        assert.equal((await read()).name, 'Changed through MCP');
        const locked = await client.callTool({
          name: 'object_update',
          arguments: { id: 'server_test_box', patch: { name: 'Illegal edit' } },
        });
        assert.equal(locked.isError, true);
      } finally {
        await client.close();
      }
    });

    await t.test('model resources cannot fetch arbitrary files or external URLs', async () => {
      for (const uri of ['file:///etc/passwd', 'https://example.com/buffer.bin', '../../secret.bin']) {
        await assert.rejects(
          validateModel(
            Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri }] })),
            '.gltf',
            service.store,
          ),
          { code: 'EXTERNAL_ASSET' },
        );
      }
      const current = await read();
      const invalid = await post('/api/commands', {
        commands: [{ type: 'audio.create', payload: { url: '/api/assets/nonexistent/file', duration: 3 } }],
      });
      assert.equal(invalid.status, 400);
      assert.deepEqual(await read(), current);
    });

    await t.test('assets and completed videos are downloadable from the hidden data directory', async () => {
      const form = new FormData();
      const content = JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 });
      form.set('file', new Blob([content]), 'empty.gltf');
      const uploaded = await fetch(`${url}/api/assets`, { method: 'POST', body: form });
      assert.equal(uploaded.status, 201);
      const asset = (await uploaded.json()) as { url: string };
      const download = await fetch(url + asset.url);
      assert.equal(download.status, 200);
      assert.equal(await download.text(), content);
      const current = await read();
      const job: RenderJob = {
        id: 'download-test',
        status: 'completed',
        progress: 1,
        frame: 1,
        totalFrames: 1,
        projectRevision: current.revision,
        createdAt: new Date().toISOString(),
        options: {},
        url: '/api/renders/download-test/file',
      };
      await writeFile(join(dataDir, 'renders', `${job.id}.mp4`), Buffer.from('test-video-payload'));
      service.store.addJob(job, current);
      const video = await fetch(url + job.url);
      assert.equal(video.status, 200);
      assert.equal(await video.text(), 'test-video-payload');
    });

    await t.test('stdio MCP bridge shares HTTP project state without opening another database', async () => {
      const client = new Client({ name: 'stdio-integration-test', version: '1' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'server/stdio.ts'],
          cwd: process.cwd(),
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            ),
            WHITEFRAME_API_URL: url,
            WHITEFRAME_MCP_TOKEN: config.token,
          },
        }),
      );
      try {
        assert.ok((await client.listTools()).tools.length > 30);
        const result = await client.callTool({ name: 'project_get', arguments: {} });
        assert.ok(!result.isError);
        const text = (result.content as { type: string; text?: string }[]).find(
          (content) => content.type === 'text',
        )!.text!;
        assert.equal(JSON.parse(text).id, (await read()).id);
      } finally {
        await client.close();
      }
    });

    await t.test('saved projects can be listed and reopened with their history intact', async () => {
      const previous = await read();
      const created = (await (
        await post('/api/project/new', { name: 'Second project', template: 'empty' })
      ).json()) as Project;
      assert.notEqual(created.id, previous.id);
      const list = (await (await fetch(`${url}/api/projects`)).json()) as { id: string; name: string }[];
      assert.equal(list.length, 2);
      assert.ok(list.some((project) => project.id === previous.id));
      assert.equal((await post(`/api/projects/${previous.id}/open`, {})).status, 200);
      assert.deepEqual(await read(), previous);
      assert.equal(service.store.history().canUndo, true);
      assert.equal((await post('/api/projects/missing-project/open', {})).status, 404);
      assert.deepEqual(await read(), previous);
    });

    await t.test(
      'switching between equal-revision demo projects rejects stale project IDs before replay',
      async () => {
        const previous = await read();
        const first = (await (
          await post('/api/project/new', { name: 'First demo', template: 'demo' })
        ).json()) as Project;
        const second = (await (
          await post('/api/project/new', { name: 'Second demo', template: 'demo' })
        ).json()) as Project;
        assert.equal(first.revision, second.revision);
        const commands = [
          { type: 'object.update', payload: { id: 'actor-a', patch: { name: 'Wrong project' } } },
        ];
        const stale = await post('/api/commands', {
          projectId: first.id,
          expectedRevision: first.revision,
          requestId: 'cross-project-edit',
          commands,
        });
        assert.equal(stale.status, 409);
        assert.equal((await stale.json()).error.code, 'PROJECT_CONFLICT');
        assert.deepEqual(await read(), second);
        assert.equal(
          (await post('/api/history/undo', { projectId: first.id, expectedRevision: first.revision })).status,
          409,
        );
        assert.equal(
          (await post('/api/renders', { projectId: first.id, expectedRevision: first.revision })).status,
          409,
        );
        assert.equal(
          (await post('/api/renders', { projectId: second.id, expectedRevision: second.revision + 1 }))
            .status,
          409,
        );
        assert.equal(
          (
            await post('/api/commands', {
              projectId: second.id,
              expectedRevision: second.revision,
              requestId: 'cross-project-edit',
              commands,
            })
          ).status,
          200,
        );
        await post(`/api/projects/${first.id}/open`, {});
        assert.equal(
          (await post('/api/commands', { projectId: second.id, requestId: 'cross-project-edit', commands }))
            .status,
          409,
        );
        assert.deepEqual(await read(), first);
        await post(`/api/projects/${previous.id}/open`, {});
      },
    );

    await t.test('restart preserves project, undo history and export snapshots', async () => {
      const before = await read();
      const job: RenderJob = {
        id: 'unfinished-export',
        status: 'rendering',
        progress: 0.25,
        frame: 60,
        totalFrames: 240,
        projectRevision: before.revision,
        createdAt: new Date().toISOString(),
        options: { fps: 24 },
      };
      service.store.addJob(job, before, { id: 'persistent-export-request', fingerprint: 'same-options' });
      const restored = new Store(dataDir, config.token);
      try {
        assert.deepEqual(restored.project(), before);
        assert.equal(restored.history().canUndo, true);
        assert.equal(restored.job(job.id).status, 'failed');
        assert.deepEqual(restored.jobProject(job.id), before);
        assert.equal(
          restored.cachedRender(before.id, 'persistent-export-request', 'same-options')?.id,
          job.id,
        );
        assert.throws(
          () => restored.cachedRender(before.id, 'persistent-export-request', 'changed-options'),
          { code: 'IDEMPOTENCY_CONFLICT' },
        );
      } finally {
        restored.close();
      }
    });
  } finally {
    listener.closeAllConnections();
    await new Promise<void>((done, reject) => listener.close((error) => (error ? reject(error) : done())));
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('source audio maps repeated and omitted footage while sequence audio stays on edit time', () => {
  const project = createDemoProject();
  const shot = project.shots[0]!;
  project.sequences[0]!.clips = [
    { id: 'clip-a', shotId: shot.id, sourceIn: 2, sourceOut: 4 },
    { id: 'clip-b', shotId: shot.id, sourceIn: 3, sourceOut: 5 },
  ];
  project.audio = [
    {
      id: 'source-audio',
      name: 'Source',
      url: '/api/assets/audio/file',
      start: 1,
      sourceIn: 4,
      duration: 5,
      volume: 1,
      muted: false,
      locked: false,
      sync: 'source',
    },
    {
      id: 'sequence-audio',
      name: 'Sequence',
      url: '/api/assets/audio/file',
      start: 1,
      sourceIn: 10,
      duration: 2,
      volume: 0.5,
      muted: false,
      locked: false,
      sync: 'sequence',
    },
  ];
  const store = {
    assetByUrl: () => ({
      id: 'audio',
      path: '/local/audio.wav',
      mime: 'audio/wav',
      name: 'Audio',
      size: 10,
      url: '/api/assets/audio/file',
      duration: 20,
    }),
  };
  const segments = audioSegments(project, { includeAudio: true }, 4, store);
  assert.deepEqual(
    segments.map(({ sourceStart, start, duration }) => ({ sourceStart, start, duration })),
    [
      { sourceStart: 5, start: 0, duration: 2 },
      { sourceStart: 6, start: 2, duration: 2 },
      { sourceStart: 10, start: 1, duration: 2 },
    ],
  );
});

test('FFmpeg encoder preserves all 240 video frames and the final audio samples', async () => {
  const exec = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-encoder-'));
  const audioPath = join(directory, 'tone.wav');
  const output = join(directory, 'video.mp4');
  try {
    await exec('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=10',
      audioPath,
    ]);
    const { stdout: png } = await exec(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=white:s=16x16',
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        '-',
      ],
      { encoding: 'buffer' },
    );
    const job: RenderJob = {
      id: 'encoder-test',
      status: 'rendering',
      progress: 0,
      frame: 0,
      totalFrames: 240,
      projectRevision: 0,
      createdAt: new Date().toISOString(),
      options: { fps: 24 },
    };
    const child = spawn(
      'ffmpeg',
      encoderArguments(
        job,
        [
          { path: audioPath, sourceStart: 0, duration: 3.5, start: 0, volume: 1 },
          { path: audioPath, sourceStart: 3.5, duration: 3.5, start: 3.5, volume: 1 },
          { path: audioPath, sourceStart: 7, duration: 3, start: 7, volume: 1 },
        ],
        output,
      ),
    );
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    child.stdout.resume();
    const finished = new Promise<void>((done, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? done() : reject(new Error(stderr))));
    });
    child.stdin.end(Buffer.concat(Array.from({ length: 240 }, () => png)));
    await finished;
    const { stdout } = await exec('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=codec_type,duration,nb_read_frames',
      '-of',
      'json',
      output,
    ]);
    const info = JSON.parse(stdout) as {
      streams: { codec_type: string; duration: string; nb_read_frames: string }[];
    };
    assert.equal(info.streams.find((stream) => stream.codec_type === 'video')?.nb_read_frames, '240');
    assert.equal(Number(info.streams.find((stream) => stream.codec_type === 'video')?.duration), 10);
    assert.equal(Number(info.streams.find((stream) => stream.codec_type === 'audio')?.duration), 10);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
