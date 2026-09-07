import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  packageShots,
  verifyFilmPackage,
  verifyFilmRestart,
  type FilmPackageReport,
  type FilmTheme,
} from './verify-mcp-film-package';
import { verifyFrozenManifest } from './verify-frozen-manifest';
import { loadRenderBaselines } from './render-baseline';

const { values } = parseArgs({
  options: {
    runtime: { type: 'string' },
    data: { type: 'string' },
    output: { type: 'string' },
    source: { type: 'string', default: '.data/full-delivery/final-candidate-05/productions' },
    port: { type: 'string', default: '4228' },
    'review-port': { type: 'string', default: '4328' },
    'render-baselines': { type: 'string' },
  },
});
if (!values.runtime || !values.data || !values.output)
  throw new Error(
    'Provide --runtime <frozen build> --data <new directory> --output <new evidence directory>',
  );
const runtime = resolve(values.runtime);
const data = resolve(values.data);
const output = resolve(values.output);
const source = resolve(values.source);
const port = Number(values.port);
const reviewPort = Number(values['review-port']);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536 && port !== 4217);
assert.ok(
  Number.isInteger(reviewPort) &&
    reviewPort > 1024 &&
    reviewPort < 65536 &&
    reviewPort !== 4317 &&
    reviewPort !== port,
);
const api = `http://127.0.0.1:${port}`;
const manifest = await verifyFrozenManifest(resolve(runtime, 'runtime-manifest.json'));
const renderBaselines = await loadRenderBaselines(values['render-baselines']);
await readFile(resolve(runtime, 'dist/index.html'));
await mkdir(data, { recursive: false });
await mkdir(output, { recursive: false });
process.env.WHITEFRAME_PRODUCTIONS_DIR = output;
const started = new Date().toISOString();
const lifecycle: { pid: number; startedAt: string; stoppedAt?: string }[] = [];
let child: ChildProcess | undefined;
let stopped: Promise<void> | undefined;

async function assertAvailable(value: number) {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(value, '127.0.0.1', () => server.close((error) => (error ? reject(error) : done())));
  });
}

async function startRuntime() {
  await assertAvailable(port);
  await assertAvailable(reviewPort);
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
  stopped = new Promise<void>((done) =>
    child!.once('close', () => {
      log.end();
      done();
    }),
  );
  assert.ok(child.pid);
  lifecycle.push({ pid: child.pid, startedAt: new Date().toISOString() });
  const deadline = Date.now() + 30000;
  for (;;) {
    assert.ok(
      child.exitCode === null && child.signalCode === null,
      'Verification runtime exited during startup',
    );
    try {
      const response = await fetch(`${api}/api/health`);
      if (response.ok && (await response.json()).ok) break;
    } catch {
      /* The listener is still starting. */
    }
    assert.ok(Date.now() < deadline, 'Verification runtime did not become ready');
    await new Promise((done) => setTimeout(done, 250));
  }
  console.log(JSON.stringify({ runtimeStarted: child.pid, api, sourceHash: manifest.sourceHash }));
  const verified = await verifyFrozenManifest(resolve(runtime, 'runtime-manifest.json'), api);
  await writeFile(
    resolve(output, `source-verification-${lifecycle.length}.json`),
    JSON.stringify(verified, null, 2),
  );
}

async function stopRuntime() {
  if (!child || !stopped) return;
  const processToStop = child;
  child = undefined;
  processToStop.kill('SIGTERM');
  const force = setTimeout(() => processToStop.kill('SIGKILL'), 20000);
  try {
    await stopped;
  } finally {
    clearTimeout(force);
  }
  lifecycle.at(-1)!.stoppedAt = new Date().toISOString();
  stopped = undefined;
}

const reports: FilmPackageReport[] = [];
try {
  await startRuntime();
  for (const theme of Object.keys(packageShots) as FilmTheme[])
    reports.push(await verifyFilmPackage(api, theme, source, manifest.sourceHash, renderBaselines[theme]));
  await stopRuntime();
  await startRuntime();
  const restartReports = [];
  for (const report of reports) restartReports.push(await verifyFilmRestart(api, report, source));
  await stopRuntime();
  assert.equal(lifecycle.length, 2);
  assert.notEqual(lifecycle[0].pid, lifecycle[1].pid);
  await writeFile(
    resolve(output, 'suite-report.json'),
    JSON.stringify(
      {
        started,
        completed: new Date().toISOString(),
        runtime,
        sourceHash: manifest.sourceHash,
        data,
        output,
        source,
        api,
        lifecycle,
        stateMutations: 'Public MCP tools only; HTTP is used for connection metadata and media downloads',
        freshFullFilmRenders: false,
        verified: reports.map((report) => ({
          theme: report.theme,
          packageBytes: report.packageBytes,
          transferId: report.transferId,
          projectId: report.restoredProjectId,
          sourceHistories: report.sourceHistories,
          assets: report.assets.length,
          reexportedShot: report.selectedShot,
          decodedVideoSsim: report.decodedVideoSsim,
          renderComparison: report.renderComparison,
        })),
        restartReports,
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
        started,
        failed: new Date().toISOString(),
        runtime,
        sourceHash: manifest.sourceHash,
        data,
        api,
        lifecycle,
        completedThemes: reports.map((report) => report.theme),
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await stopRuntime();
}
