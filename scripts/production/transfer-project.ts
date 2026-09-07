import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Project } from '../../shared/types';
import { ProductionMcp } from './production-mcp';

const { values } = parseArgs({
  options: {
    source: { type: 'string', default: 'http://127.0.0.1:4199' },
    target: { type: 'string', default: 'http://127.0.0.1:4210' },
    project: { type: 'string' },
    theme: { type: 'string' },
  },
});
if (!values.project || !values.theme || !/^[a-z-]+$/.test(values.theme))
  throw new Error(
    'Provide --project <source-id> --theme <film-name> and optional --source / --target API URLs',
  );

interface Transfer {
  sourceProjectId: string;
  sourceRevision: number;
  targetApi: string;
  targetProjectId: string;
  sha256: string;
  assets: number;
  package: string;
  transport?: 'mcp' | 'http-multipart';
}

const source = new ProductionMcp(values.theme, values.source);
const target = new ProductionMcp(values.theme, values.target);
try {
  await source.connect();
  const archive = await source.call<{ projectId: string; revision: number; downloadUrl: string }>(
    'project_package_export',
    {
      projectId: values.project,
      includeHistory: true,
      includeVideos: false,
    },
  );
  await target.connect();
  const transferPath = resolve(target.directory, 'delivery-transfer.json');
  let previous: Transfer | undefined;
  try {
    previous = JSON.parse(await readFile(transferPath, 'utf8')) as Transfer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const projects = await target.call<{ id: string }[]>('project_list');
  if (
    previous?.sourceProjectId === values.project &&
    previous.sourceRevision === archive.revision &&
    previous.targetApi === values.target &&
    projects.some((project) => project.id === previous.targetProjectId)
  ) {
    console.log(JSON.stringify({ ...previous, reused: true }));
  } else {
    const response = await fetch(archive.downloadUrl);
    if (!response.ok) throw new Error(`Project package download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const dataBase64 = bytes.toString('base64');
    const packagePath = resolve(target.directory, 'source-project.whiteframe');
    await writeFile(packagePath, bytes);
    const transport = dataBase64.length <= 32 * 1024 * 1024 ? 'mcp' : 'http-multipart';
    let restored: { project: Project; assets: number };
    if (transport === 'mcp') {
      restored = await target.call('project_package_import', { dataBase64 });
    } else {
      const form = new FormData();
      form.append('file', new Blob([bytes]), `${values.theme}.whiteframe`);
      const started = new Date().toISOString();
      const uploaded = await fetch(new URL('/api/packages/import', values.target), {
        method: 'POST',
        body: form,
      });
      const result = await uploaded.text();
      await appendFile(
        resolve(target.directory, 'mcp-operations.jsonl'),
        `${JSON.stringify({
          started,
          completed: new Date().toISOString(),
          transport,
          method: 'POST',
          endpoint: '/api/packages/import',
          packageSha256: createHash('sha256').update(bytes).digest('hex'),
          status: uploaded.status,
          responseHash: createHash('sha256').update(result).digest('hex'),
        })}\n`,
      );
      if (!uploaded.ok) throw new Error(`Project package upload failed: ${uploaded.status} ${result}`);
      restored = JSON.parse(result) as typeof restored;
      await target.call<Project>('project_open', { id: restored.project.id });
    }
    const record: Transfer = {
      sourceProjectId: values.project,
      sourceRevision: archive.revision,
      targetApi: values.target,
      targetProjectId: restored.project.id,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      assets: restored.assets,
      package: packagePath,
      transport,
    };
    await writeFile(transferPath, JSON.stringify(record, null, 2));
    await writeFile(
      resolve(target.directory, 'delivery-project.json'),
      JSON.stringify(restored.project, null, 2),
    );
    console.log(JSON.stringify(record));
  }
} finally {
  await source.client.close();
  await target.client.close();
}
