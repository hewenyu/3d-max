import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readPackageRecords } from '../../server/package-codec';
import type { Project, RenderJob } from '../../shared/types';
import { ProductionMcp } from './production-mcp';

const { values } = parseArgs({
  options: { api: { type: 'string', default: 'http://127.0.0.1:4223' }, theme: { type: 'string' } },
});
if (!values.theme || !/^[a-z-]+$/.test(values.theme))
  throw new Error('Provide --theme after restarting the restored instance');
const film = new ProductionMcp(values.theme, values.api);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
try {
  await film.connect();
  const report = JSON.parse(
    await readFile(resolve(film.directory, 'package-restoration-report.json'), 'utf8'),
  ) as {
    restoredProjectId: string;
    undoneRevision: number;
    restoredVideoId: string;
    restoredVideoSha256: string;
    reexportJobId: string;
    reexportPath: string;
    assets: number;
  };
  const original = JSON.parse(
    await readFile(resolve(film.directory, 'export-project.json'), 'utf8'),
  ) as Project;
  const current = await film.call<Project>('project_get');
  assert.equal(current.id, report.restoredProjectId);
  assert.equal(current.revision, report.undoneRevision);
  const content = (project: Project) => {
    const { id: _id, revision: _revision, updatedAt: _updatedAt, ...data } = project;
    return data;
  };
  assert.deepEqual(content(current), content(original));
  const history = await (await fetch(new URL('/api/history', values.api))).json();
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, true);
  const jobs = await film.call<RenderJob[]>('render_status');
  const restored = jobs.find((job) => job.id === report.restoredVideoId)!;
  const reexported = jobs.find((job) => job.id === report.reexportJobId)!;
  assert.equal(restored.status, 'completed');
  assert.equal(reexported.status, 'completed');
  const media = async (job: RenderJob) => {
    const response = await fetch(new URL(job.url!, values.api));
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  };
  assert.equal(hash(await media(restored)), report.restoredVideoSha256);
  assert.equal(hash(await media(reexported)), hash(await readFile(report.reexportPath)));
  const exported = JSON.parse(
    await readFile(resolve(film.directory, 'package-export-report.json'), 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
      throw error;
    }),
  ) as { archivedAssets?: { url: string; size: number; sha256: string }[] };
  const assets = exported.archivedAssets ?? [];
  if (!exported.archivedAssets) {
    const archive = await readFile(resolve(film.directory, `${values.theme}.whiteframe`));
    for await (const record of readPackageRecords(archive)) {
      if (record.type === 'asset') {
        const asset = record.value;
        assets.push({ url: asset.url, size: asset.size, sha256: asset.file.sha256 });
      }
    }
  }
  assert.equal(assets.length, report.assets);
  for (const asset of assets) {
    const response = await fetch(new URL(asset.url, values.api));
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, asset.size);
    assert.equal(hash(bytes), asset.sha256);
  }
  const result = {
    api: values.api,
    projectId: current.id,
    revision: current.revision,
    projectContentMatchesAcceptedSource: true,
    history,
    assets: assets.length,
    completedVideos: jobs.filter((job) => job.status === 'completed').length,
    restoredVideoHashMatches: true,
    reexportedVideoHashMatches: true,
    passed: true,
  };
  await writeFile(resolve(film.directory, 'package-restart-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await film.close();
}
