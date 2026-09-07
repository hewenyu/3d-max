import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { finished } from 'node:stream/promises';

const manifest = JSON.parse(await readFile('runtime-manifest.json', 'utf8'));
if (!manifest.sourceHash || !manifest.files) throw new Error('Run from a frozen runtime directory');
if (!process.argv[2]) throw new Error('Provide the absolute directory for verification evidence');
const directory = resolve(process.argv[2]);
await mkdir(directory, { recursive: false });
const report = {
  sourceHash: manifest.sourceHash,
  runtimeDirectory: process.cwd(),
  startedAt: new Date().toISOString(),
  scope:
    'Engineering regression gates. Film playback, artifact restoration and requirement audits are separate.',
  checks: [],
  completed: false,
};
const save = () => writeFile(resolve(directory, 'verification.json'), JSON.stringify(report, null, 2));
async function verifySource() {
  for (const [path, expected] of Object.entries(manifest.files)) {
    const actual = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    if (actual !== expected) throw new Error(`Frozen source changed: ${path}`);
  }
}
try {
  await verifySource();
  for (const name of ['format:check', 'test', 'build', 'test:render', 'test:e2e', 'test:production']) {
    const check = { name, startedAt: new Date().toISOString(), completed: false };
    report.checks.push(check);
    await save();
    const log = createWriteStream(resolve(directory, `${name.replaceAll(':', '-')}.log`), { flags: 'wx' });
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', name], {
      env: {
        ...process.env,
        WHITEFRAME_RENDER_QA_OUT: resolve(directory, 'render-smoke'),
        WHITEFRAME_MCP_AUDIT_OUT: resolve(directory, 'mcp-calls.jsonl'),
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(resolve('scripts/mcp-audit.mjs')).href}`.trim(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = (bytes) => {
      log.write(bytes);
      process.stdout.write(bytes);
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    let code;
    try {
      code = await new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', resolveExit);
      });
    } finally {
      log.end();
      await finished(log);
    }
    check.exitCode = code;
    check.completed = code === 0;
    check.finishedAt = new Date().toISOString();
    await save();
    if (name === 'test:e2e' || name === 'test:production') {
      const path = name === 'test:e2e' ? 'test-results' : 'test-results-production';
      await cp(path, resolve(directory, path), { recursive: true });
    }
    if (code !== 0) throw new Error(`${name} failed with exit code ${code}`);
  }
  const coverageCheck = { name: 'mcp:coverage', startedAt: new Date().toISOString(), completed: false };
  report.checks.push(coverageCheck);
  await save();
  const coveragePath = resolve(directory, 'mcp-coverage.json');
  const summary = await promisify(execFile)(process.execPath, [
    'scripts/summarize-mcp-audit.mjs',
    resolve(directory, 'mcp-calls.jsonl'),
    coveragePath,
  ]);
  process.stdout.write(summary.stdout);
  const coverage = JSON.parse(await readFile(coveragePath, 'utf8'));
  if (!coverage.declaredTools || coverage.missingSuccessfulDirectCalls.length)
    throw new Error(
      `MCP tools lack successful standalone calls: ${coverage.missingSuccessfulDirectCalls.join(', ')}`,
    );
  coverageCheck.completed = true;
  coverageCheck.finishedAt = new Date().toISOString();
  await save();
  await verifySource();
  report.completed = true;
  report.finishedAt = new Date().toISOString();
  await save();
} catch (error) {
  report.error = error.message;
  await save();
  throw error;
}
