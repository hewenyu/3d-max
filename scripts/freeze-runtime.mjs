import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative } from 'node:path';

const source = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = resolve(process.argv[2] ?? `.data/releases/${stamp}`);
await mkdir(target, { recursive: false });
const entries = await readdir(source);
const directories = [
  'src',
  'shared',
  'server',
  'tests',
  'scripts',
  ...(entries.includes('public') ? ['public'] : []),
];
const files = [
  'package.json',
  'package-lock.json',
  '.prettierrc.json',
  '.prettierignore',
  'tsconfig.json',
  'vite.config.ts',
  ...entries.filter((name) => /^playwright(?:\..+)?\.config\.ts$/.test(name)),
  ...entries.filter((name) => name.endsWith('.html')),
];
for (const path of [...directories, ...files])
  await cp(resolve(source, path), resolve(target, path), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
await symlink(resolve(source, 'node_modules'), resolve(target, 'node_modules'), 'dir');

const hashes = {};
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (entry.isFile())
      hashes[relative(target, path)] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
  }
}
for (const directory of directories) await scan(resolve(target, directory));
for (const file of files)
  hashes[file] = createHash('sha256')
    .update(await readFile(resolve(target, file)))
    .digest('hex');
const sorted = Object.fromEntries(
  Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)),
);
const sourceHash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
const { stdout, stderr } = await promisify(execFile)('npm', ['run', 'build'], {
  cwd: target,
  maxBuffer: 4 * 1024 * 1024,
});
process.stdout.write(stdout);
process.stderr.write(stderr);
await writeFile(
  resolve(target, 'runtime-manifest.json'),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      sourceHash,
      files: sorted,
      dependencies: 'Shared node_modules; dependency changes require a new frozen runtime',
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ directory: target, sourceHash }));
