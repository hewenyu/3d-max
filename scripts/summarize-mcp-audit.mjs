import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) throw new Error('Provide the MCP audit JSONL input and JSON report output');
const entries = (await readFile(resolve(input), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const tools = new Map();
const ensure = (name) => {
  if (!tools.has(name))
    tools.set(name, { name, schemaHashes: new Set(), directSuccesses: 0, batchSuccesses: 0, failures: 0 });
  return tools.get(name);
};
for (const entry of entries) {
  if (entry.kind === 'catalog')
    for (const tool of entry.tools) ensure(tool.name).schemaHashes.add(tool.schemaHash);
  else if (entry.kind === 'call') {
    const tool = ensure(entry.name);
    if (entry.success) {
      tool.directSuccesses++;
      for (const command of entry.commands ?? []) ensure(command.replaceAll('.', '_')).batchSuccesses++;
    } else tool.failures++;
  }
}
const coverage = [...tools.values()]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((tool) => ({ ...tool, schemaHashes: [...tool.schemaHashes] }));
const result = {
  input: resolve(input),
  generatedAt: new Date().toISOString(),
  scope:
    'Observed real SDK calls. A successful batch proves domain dispatch, not the standalone tool schema. Counts are not substitutes for behavioral assertions or visual review.',
  records: entries.length,
  declaredTools: coverage.filter((tool) => tool.schemaHashes.length).length,
  coverage,
  missingSuccessfulDirectCalls: coverage
    .filter((tool) => tool.schemaHashes.length && !tool.directSuccesses)
    .map((tool) => tool.name),
  missingSuccessfulOperations: coverage
    .filter((tool) => tool.schemaHashes.length && !tool.directSuccesses && !tool.batchSuccesses)
    .map((tool) => tool.name),
};
await writeFile(resolve(output), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    records: result.records,
    declaredTools: result.declaredTools,
    missingSuccessfulDirectCalls: result.missingSuccessfulDirectCalls,
    missingSuccessfulOperations: result.missingSuccessfulOperations,
  }),
);
