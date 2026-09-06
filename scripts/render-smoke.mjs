import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const output =
  process.env.WHITEFRAME_RENDER_QA_OUT || (await mkdtemp(join(tmpdir(), 'whiteframe-render-qa-')));
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(join(output, '.data-'));
const exec = promisify(execFile);
const children = [];
const report = { output, passed: false };
let browser;
let client;
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function waitUntil(run, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await run();
    if (result) return result;
    await delay(300);
  }
  throw new Error(`Operation exceeded ${timeout} ms`);
}

function launch(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (data) => {
    logs = (logs + String(data)).slice(-12000);
  });
  child.stderr.on('data', (data) => {
    logs = (logs + String(data)).slice(-12000);
  });
  children.push({ child, logs: () => logs });
  return child;
}

try {
  const port = await freePort();
  const webPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const appUrl = `http://127.0.0.1:${webPort}`;
  const env = {
    PORT: String(port),
    WEB_PORT: String(webPort),
    APP_URL: appUrl,
    WHITEFRAME_DATA_DIR: dataDir,
  };
  launch(['--import', 'tsx', 'server/index.ts'], env);
  launch(
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    env,
  );
  const json = async (path, body) => {
    const response = await fetch(
      base + path,
      body === undefined
        ? {}
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  };
  await waitUntil(async () => {
    if (children.some(({ child }) => child.exitCode !== null))
      throw new Error(children.map((entry) => entry.logs()).join('\n'));
    try {
      return (await fetch(base + '/api/health')).ok && (await fetch(appUrl)).ok;
    } catch {
      return false;
    }
  });
  console.log('Isolated API and web server ready.');

  const audioPath = join(output, 'reference.wav');
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
  const upload = async (name, bytes) => {
    const form = new FormData();
    form.set('file', new Blob([bytes]), name);
    const response = await fetch(base + '/api/assets', { method: 'POST', body: form });
    assert.equal(response.status, 201);
    return response.json();
  };
  const audio = await upload('reference.wav', await readFile(audioPath));
  const vertices = Buffer.from(new Float32Array([-0.2, 0, 0, 0.2, 0, 0, 0, 0.5, 0]).buffer);
  const model = await upload(
    'triangle.gltf',
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [
        {
          byteLength: vertices.length,
          uri: `data:application/octet-stream;base64,${vertices.toString('base64')}`,
        },
      ],
      bufferViews: [{ buffer: 0, byteLength: vertices.length }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.2, 0, 0], max: [0.2, 0.5, 0] },
      ],
    }),
  );
  let project = await json('/api/project');
  project = (
    await json('/api/commands', {
      projectId: project.id,
      expectedRevision: project.revision,
      commands: [
        {
          type: 'audio.create',
          payload: { name: 'Reference', url: audio.url, duration: 10, sync: 'source' },
        },
        {
          type: 'object.create',
          payload: { type: 'model', name: 'Imported triangle', assetUrl: model.url, position: [1.5, 0, -1] },
        },
      ],
    })
  ).project;

  const connection = await json('/api/connection');
  client = new Client({ name: 'render-smoke', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  const preview = await client.callTool({
    name: 'preview_capture',
    arguments: { time: 1, width: 360, height: 640 },
  });
  assert.ok(!preview.isError, JSON.stringify(preview));
  const png = preview.content.find((content) => content.type === 'image');
  assert.equal(png.mimeType, 'image/png');
  await writeFile(join(output, 'mcp-preview.png'), Buffer.from(png.data, 'base64'));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const colors = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 96, 96);
    const pixels = context.getImageData(0, 0, 96, 96).data;
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 4) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    return colors.size;
  }, png.data);
  assert.ok(colors > 25, 'MCP preview is blank');
  report.previewColors = colors;
  console.log(`MCP PNG contains ${colors} sampled colors; uploaded model resolved.`);

  const options = {
    projectId: project.id,
    expectedRevision: project.revision,
    fps: 24,
    resolution: 720,
    aspect: '9:16',
    includeAudio: true,
    requestId: 'render-smoke-240',
  };
  const job = await json('/api/renders', options);
  assert.equal((await json('/api/renders', options)).id, job.id);
  await json('/api/commands', {
    projectId: project.id,
    commands: [{ type: 'project.update', payload: { name: 'Edited during export' } }],
  });
  assert.equal((await json('/api/renders', options)).id, job.id);
  const changed = await fetch(base + '/api/renders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...options, fps: 30 }),
  });
  assert.equal(changed.status, 409);
  const queued = await json('/api/renders', { requestId: 'render-smoke-queued' });
  assert.equal((await json(`/api/renders/${queued.id}/cancel`, {})).status, 'cancelled');
  let lastProgress = -1;
  const completed = await waitUntil(async () => {
    const state = await json(`/api/renders/${job.id}`);
    assert.ok(state.progress >= 0 && state.progress <= 1);
    if (state.frame >= lastProgress + 48) {
      console.log(`Export ${state.frame}/${state.totalFrames} frames`);
      lastProgress = state.frame;
    }
    if (state.status === 'failed') throw new Error(state.error);
    return state.status === 'completed' ? state : false;
  }, 180000);
  assert.equal(completed.projectRevision, project.revision);
  assert.equal(completed.totalFrames, 240);
  const video = join(output, 'whiteframe-10s.mp4');
  await writeFile(video, Buffer.from(await (await fetch(base + completed.url)).arrayBuffer()));
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'stream=codec_name,codec_type,width,height,r_frame_rate,duration,nb_read_frames:format=duration',
    '-of',
    'json',
    video,
  ]);
  const probe = JSON.parse(stdout);
  const visual = probe.streams.find((stream) => stream.codec_type === 'video');
  const sound = probe.streams.find((stream) => stream.codec_type === 'audio');
  assert.equal(visual.codec_name, 'h264');
  assert.equal(visual.width, 720);
  assert.equal(visual.height, 1280);
  assert.equal(visual.r_frame_rate, '24/1');
  assert.equal(visual.nb_read_frames, '240');
  assert.equal(Number(visual.duration), 10);
  assert.equal(sound.codec_name, 'aac');
  assert.equal(Number(sound.duration), 10);
  await exec('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    '5',
    '-i',
    video,
    '-frames:v',
    '1',
    join(output, 'video-frame-5s.png'),
  ]);
  report.probe = probe;
  console.log('Verified MP4: 720x1280, H.264, 24 fps, 240 frames, video/audio both 10 seconds.');

  const active = await json('/api/renders', { requestId: 'render-smoke-active-cancel' });
  await waitUntil(async () => {
    const state = await json(`/api/renders/${active.id}`);
    if (state.status === 'failed') throw new Error(state.error);
    return state.frame > 0;
  });
  assert.equal((await json(`/api/renders/${active.id}/cancel`, {})).status, 'cancelled');
  assert.equal((await json(`/api/renders/${active.id}`)).status, 'cancelled');
  report.passed = true;
} finally {
  await client?.close();
  await browser?.close();
  for (const { child } of children) child.kill('SIGTERM');
  for (const { child } of children) {
    if (child.exitCode !== null) continue;
    await Promise.race([new Promise((done) => child.once('exit', done)), delay(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  report.serverLogs = children.map((entry) => entry.logs());
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(`Render smoke test passed. Artifacts: ${resolve(output)}`);
