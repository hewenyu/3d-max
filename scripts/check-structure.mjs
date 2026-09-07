import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const roots = ['src', 'shared', 'server', 'tests', 'scripts'];
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html']);
const violations = [];
let checked = 0;

async function inspectFile(file) {
  if (!extensions.has(path.extname(file))) return;
  const source = await readFile(file, 'utf8');
  const lines = source.split('\n').length - Number(source.endsWith('\n'));
  checked += 1;
  if (lines > 1000) violations.push(`${file}: ${lines} lines (maximum 1000)`);
}

async function inspect(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await inspect(file);
    else await inspectFile(file);
  }
}

for (const root of roots) await inspect(root);
for (const entry of await readdir('.', { withFileTypes: true }))
  if (entry.isFile()) await inspectFile(entry.name);
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else console.log(`Structure check passed: ${checked} source files, each <= 1000 lines.`);
