import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import type { Project, RenderJob } from '../../shared/types';
import { ProductionMcp } from '../production/production-mcp';
import { fileHash, verifyFrozenManifest } from '../production/verify-frozen-manifest';
import type { FilmPackageReport } from '../production/verify-mcp-film-package';

const { values } = parseArgs({
  options: {
    evidence: { type: 'string', default: '.data/advanced-modeling/compatibility' },
    runtime: { type: 'string' },
    attempt: { type: 'string', default: '01' },
  },
});
const evidence = resolve(values.evidence);
const suite = JSON.parse(await readFile(resolve(evidence, 'suite-report.json'), 'utf8')) as {
  runtime: string;
  data: string;
  api: string;
  source: string;
  sourceHash: string;
  passed: boolean;
  verified: { theme: string; projectId: string }[];
};
assert.equal(suite.passed, true);
assert.match(values.attempt, /^[a-z0-9-]+$/);
const runtime = resolve(values.runtime ?? suite.runtime);
const verifiedSource = await verifyFrozenManifest(resolve(runtime, 'runtime-manifest.json'));
const port = Number(new URL(suite.api).port),
  reviewPort = port + 100;
assert.ok(port !== 4219 && reviewPort !== 4319);
for (const value of [port, reviewPort]) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(value, '127.0.0.1', () => server.close((error) => (error ? reject(error) : resolve())));
  });
}
const fixture = resolve(evidence, `ui-source-${values.attempt}`),
  output = resolve(evidence, `ui-${values.attempt}`);
await mkdir(fixture, { recursive: false });
process.env.WHITEFRAME_PRODUCTIONS_DIR = resolve(evidence, `ui-preparation-${values.attempt}`);
const log = createWriteStream(resolve(evidence, `ui-runtime-${values.attempt}.log`), { flags: 'wx' });
const child = spawn(
  process.execPath,
  [resolve(runtime, 'node_modules/tsx/dist/cli.mjs'), 'server/index.ts'],
  {
    cwd: runtime,
    env: {
      ...process.env,
      PORT: String(port),
      APP_URL: suite.api,
      WHITEFRAME_DATA_DIR: suite.data,
      WHITEFRAME_DIST_DIR: resolve(runtime, 'dist'),
      WHITEFRAME_REVIEW_PORT: String(reviewPort),
      WHITEFRAME_REVIEW_HOST: '127.0.0.1',
      WHITEFRAME_REVIEW_URL: `http://127.0.0.1:${reviewPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
child.stdout!.pipe(log, { end: false });
child.stderr!.pipe(log, { end: false });
const exited = new Promise<void>((done) =>
  child.once('close', () => {
    log.end();
    done();
  }),
);
const provenance: unknown[] = [];
const sourceFiles = new Map<string, string>();
const content = (project: Project) => {
  const { id: _id, revision: _revision, updatedAt: _updatedAt, ...value } = project;
  return value;
};
const startedAt = new Date().toISOString();
try {
  const deadline = Date.now() + 30000;
  for (;;) {
    assert.equal(child.exitCode, null, 'Compatibility runtime exited during startup');
    try {
      if ((await fetch(`${suite.api}/api/health`)).ok) break;
    } catch {
      /* Listener is starting. */
    }
    assert.ok(Date.now() < deadline, 'Compatibility runtime did not start');
    await new Promise((done) => setTimeout(done, 250));
  }
  await verifyFrozenManifest(resolve(runtime, 'runtime-manifest.json'), suite.api);
  for (const { theme, projectId } of suite.verified) {
    const film = new ProductionMcp(theme, suite.api);
    try {
      await film.connect();
      const project = await film.call<Project>('project_open', { id: projectId });
      const originalPath = resolve(suite.source, theme, 'export-project.json');
      const accepted = JSON.parse(await readFile(originalPath, 'utf8')) as Project;
      assert.deepEqual(content(project), content(accepted));
      if (theme === 'tourism') {
        await film.preview(0, 'deterministic-order-probe');
        assert.equal(
          fileHash(await readFile(resolve(film.directory, 'deterministic-order-probe.png'))),
          fileHash(await readFile(resolve(suite.source, theme, 'runtime-review/preview-00000.png'))),
        );
        console.log(
          JSON.stringify({
            theme,
            deterministicOrderProbe: 'exact original PNG',
            sourceHash: verifiedSource.sourceHash,
          }),
        );
      }
      const packageReport = JSON.parse(
        await readFile(resolve(evidence, theme, 'mcp-package-report.json'), 'utf8'),
      ) as FilmPackageReport;
      const job = await film.call<RenderJob>('render_status', { id: packageReport.restoredVideoId });
      const directory = resolve(fixture, theme);
      await mkdir(resolve(directory, 'runtime-review'), { recursive: true });
      await writeFile(resolve(directory, 'export-project.json'), JSON.stringify(project, null, 2));
      await writeFile(resolve(directory, 'export-job.json'), JSON.stringify(job, null, 2));
      for (const name of [
        'ffprobe.json',
        'runtime-review/preview-00000.png',
        'runtime-review/runtime-verification.json',
      ]) {
        const sourcePath = resolve(suite.source, theme, name);
        sourceFiles.set(sourcePath, fileHash(await readFile(sourcePath)));
        await copyFile(sourcePath, resolve(directory, name));
      }
      for (const name of ['export-project.json', 'export-job.json', `${theme}.mp4`, `${theme}.whiteframe`]) {
        const path = resolve(suite.source, theme, name);
        sourceFiles.set(path, fileHash(await readFile(path)));
      }
      const stream = await fetch(`${suite.api}/api/renders/${job.id}/stream`);
      assert.equal(stream.status, 200);
      const streamHash = fileHash(Buffer.from(await stream.arrayBuffer()));
      assert.equal(streamHash, packageReport.restoredVideoSha256);
      const range = await fetch(`${suite.api}/api/renders/${job.id}/stream`, {
        headers: { Range: 'bytes=0-1023' },
      });
      assert.equal(range.status, 206);
      assert.equal((await range.arrayBuffer()).byteLength, 1024);
      provenance.push({
        theme,
        originalProjectId: accepted.id,
        restoredProjectId: project.id,
        originalRevision: accepted.revision,
        restoredRevision: project.revision,
        contentMatchesOriginal: true,
        restoredVideoId: job.id,
        originalVideoStreamSha256: streamHash,
        streamRangeStatus: range.status,
        source: resolve(suite.source, theme),
        fixture: directory,
        fixtureChange:
          'Only restored project identity/revision/update timestamp and restored render-job identity; content and preview/media baselines remain original.',
      });
    } finally {
      await film.close();
    }
  }
  await writeFile(
    resolve(evidence, `ui-fixture-provenance-${values.attempt}.json`),
    JSON.stringify(provenance, null, 2),
  );
  const result = await promisify(execFile)(
    process.execPath,
    [
      resolve('node_modules/tsx/dist/cli.mjs'),
      'scripts/production/verify-film-ui.ts',
      '--api',
      suite.api,
      '--manifest',
      resolve(runtime, 'runtime-manifest.json'),
      '--source',
      fixture,
      '--output',
      output,
    ],
    { cwd: process.cwd(), env: process.env, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  for (const [path, sha256] of sourceFiles) assert.equal(fileHash(await readFile(path)), sha256);
  await writeFile(
    resolve(evidence, `legacy-ui-completion-${values.attempt}.json`),
    JSON.stringify(
      {
        startedAt,
        completedAt: new Date().toISOString(),
        sourceHash: verifiedSource.sourceHash,
        runtime,
        runtimePid: child.pid,
        originalArtifactsUnchanged: [...sourceFiles].map(([path, sha256]) => ({ path, sha256 })),
        originalRuntime: 'http://127.0.0.1:4219 was not controlled or mutated',
        fixtureProvenance: resolve(evidence, `ui-fixture-provenance-${values.attempt}.json`),
        uiReport: resolve(output, 'film-ui-report.json'),
        passed: true,
      },
      null,
      2,
    ),
  );
} finally {
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}
