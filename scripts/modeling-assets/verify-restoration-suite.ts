import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { verifyFrozenManifest } from '../production/verify-frozen-manifest';

const { values } = parseArgs({
  options: {
    runtime: { type: 'string' },
    source: { type: 'string' },
    name: { type: 'string' },
    output: { type: 'string' },
    data: { type: 'string' },
    port: { type: 'string', default: '4189' },
  },
});
if (!values.runtime || !values.source || !values.name || !values.output || !values.data)
  throw new Error(
    'Supply --runtime, --source, --name, --output and --data; output/data must be new directories',
  );
const runtime = resolve(values.runtime),
  source = resolve(values.source),
  output = resolve(values.output),
  data = resolve(values.data);
const port = Number(values.port),
  reviewPort = port + 100,
  api = `http://127.0.0.1:${port}`;
assert.ok(Number.isInteger(port) && port > 1024 && reviewPort < 65536);
assert.ok(![4219, 4220, 4222, 4223, 4224].includes(port), 'Use a dedicated restoration verification port');
const manifest = await verifyFrozenManifest(resolve(runtime, 'runtime-manifest.json'));
await mkdir(output, { recursive: false });
await mkdir(data, { recursive: false });
const lifecycle: { pid: number; startedAt: string; stoppedAt?: string }[] = [];
let child: ChildProcess | undefined, exited: Promise<void> | undefined;
async function start() {
  for (const value of [port, reviewPort]) {
    const server = createServer();
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(value, '127.0.0.1', () => server.close((error) => (error ? reject(error) : done())));
    });
  }
  const log = createWriteStream(resolve(output, `runtime-${lifecycle.length + 1}.log`), { flags: 'wx' });
  child = spawn(process.execPath, [resolve(runtime, 'node_modules/tsx/dist/cli.mjs'), 'server/index.ts'], {
    cwd: runtime,
    env: {
      ...process.env,
      PORT: String(port),
      APP_URL: api,
      WHITEFRAME_DATA_DIR: data,
      WHITEFRAME_DIST_DIR: resolve(runtime, 'dist'),
      WHITEFRAME_REVIEW_PORT: String(reviewPort),
      WHITEFRAME_REVIEW_HOST: '127.0.0.1',
      WHITEFRAME_REVIEW_URL: `http://127.0.0.1:${reviewPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  exited = new Promise<void>((done) =>
    child!.once('close', () => {
      log.end();
      done();
    }),
  );
  assert.ok(child.pid);
  lifecycle.push({ pid: child.pid, startedAt: new Date().toISOString() });
  const deadline = Date.now() + 30000;
  for (;;) {
    assert.equal(child.exitCode, null);
    try {
      if ((await fetch(`${api}/api/health`)).ok) break;
    } catch {
      /* Listener is starting. */
    }
    assert.ok(Date.now() < deadline, 'Restoration runtime did not start');
    await new Promise((done) => setTimeout(done, 250));
  }
  await verifyFrozenManifest(resolve(runtime, 'runtime-manifest.json'), api);
}
async function stop() {
  if (!child || !exited) return;
  const running = child;
  child = undefined;
  running.kill('SIGTERM');
  const force = setTimeout(() => running.kill('SIGKILL'), 20000);
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
  lifecycle.at(-1)!.stoppedAt = new Date().toISOString();
  exited = undefined;
}
async function phase(phase: 'import' | 'restart', state?: string) {
  const result = await promisify(execFile)(
    process.execPath,
    [
      resolve('node_modules/tsx/dist/cli.mjs'),
      resolve('scripts/modeling-assets/verify-restoration.ts'),
      '--api',
      api,
      '--name',
      values.name!,
      '--source',
      source,
      '--phase',
      phase,
      ...(state ? ['--state', state] : []),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, WHITEFRAME_MODELING_DIR: output },
      timeout: 15 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  await writeFile(resolve(output, `${phase}.log`), result.stdout + result.stderr);
  const receipt = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { phase?: string; directory?: string; passed?: boolean })
    .reverse()
    .find((item) => item.phase === phase);
  assert.ok(receipt?.passed && receipt.directory);
  const path = resolve(receipt.directory, 'restoration-state.json');
  return { path, report: JSON.parse(await readFile(path, 'utf8')) };
}
const startedAt = new Date().toISOString();
try {
  await start();
  const imported = await phase('import');
  console.log(JSON.stringify({ phase: 'import', passed: true, state: imported.path }));
  await stop();
  await start();
  const restarted = await phase('restart', imported.path);
  assert.notEqual(lifecycle[0].pid, lifecycle[1].pid);
  assert.equal(restarted.report.projectId, imported.report.projectId);
  await stop();
  await writeFile(
    resolve(output, 'suite-report.json'),
    JSON.stringify(
      {
        startedAt,
        completedAt: new Date().toISOString(),
        sourceHash: manifest.sourceHash,
        runtime,
        source,
        api,
        data,
        lifecycle,
        imported,
        restarted,
        passed: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, report: resolve(output, 'suite-report.json') }));
} catch (error) {
  await writeFile(
    resolve(output, 'suite-failure.json'),
    JSON.stringify(
      {
        startedAt,
        sourceHash: manifest.sourceHash,
        lifecycle,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
        passed: false,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await stop();
}
