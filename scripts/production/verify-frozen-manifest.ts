import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const fileHash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function verifyFrozenManifest(path: string, api?: string) {
  const manifestPath = resolve(path);
  const runtime = dirname(manifestPath);
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString()) as { sourceHash: string; files: Record<string, string> };
  assert.match(manifest.sourceHash, /^[a-f0-9]{64}$/);
  assert.ok(manifest.files && Object.keys(manifest.files).length > 0);
  const actual: Record<string, string> = {};
  for (const [name, expected] of Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) {
    assert.ok(!isAbsolute(name) && !relative(runtime, resolve(runtime, name)).startsWith('..'));
    actual[name] = fileHash(await readFile(resolve(runtime, name)));
    assert.equal(actual[name], expected, `Frozen source differs from manifest: ${name}`);
  }
  const sourceHash = fileHash(JSON.stringify(actual));
  assert.equal(
    sourceHash,
    manifest.sourceHash,
    'The complete sourceHash does not match the manifest file map',
  );
  const served: { path: string; bytes: number; sha256: string }[] = [];
  async function verifyDistribution(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) await verifyDistribution(file);
      else if (entry.isFile()) {
        const name = relative(resolve(runtime, 'dist'), file).split('\\').join('/');
        const local = await readFile(file);
        const response = await fetch(new URL(name === 'index.html' ? '/' : `/${name}`, api));
        assert.equal(response.status, 200, `Frozen distribution file is not served: ${name}`);
        const remote = Buffer.from(await response.arrayBuffer());
        assert.equal(
          fileHash(remote),
          fileHash(local),
          `Served distribution differs from frozen build: ${name}`,
        );
        served.push({ path: name, bytes: local.length, sha256: fileHash(local) });
      }
    }
  }
  if (api) await verifyDistribution(resolve(runtime, 'dist'));
  return {
    sourceHash,
    manifestPath,
    manifestSha256: fileHash(bytes),
    runtime,
    verifiedSourceFiles: Object.keys(actual).length,
    manifestFiles: actual,
    servedDistribution: served,
    verifiedAt: new Date().toISOString(),
  };
}
