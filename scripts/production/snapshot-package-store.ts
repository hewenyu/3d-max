import { DatabaseSync, backup } from 'node:sqlite';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { AssetRecord } from '../../server/store';
import type { RenderJob } from '../../shared/types';

const { values } = parseArgs({ options: { source: { type: 'string' }, target: { type: 'string' } } });
if (!values.source || !values.target) throw new Error('Provide --source and a new --target directory');
const source = resolve(values.source);
const target = resolve(values.target);
await mkdir(target, { recursive: false });
for (const name of ['assets', 'renders']) await mkdir(resolve(target, name));
const origin = new DatabaseSync(resolve(source, 'whiteframe.sqlite'), { readOnly: true });
try {
  await backup(origin, resolve(target, 'whiteframe.sqlite'));
} finally {
  origin.close();
}
const copy = new DatabaseSync(resolve(target, 'whiteframe.sqlite'));
try {
  const assetRows = copy.prepare('SELECT id,metadata FROM assets').all();
  for (const row of assetRows) {
    const asset = JSON.parse(String(row.metadata)) as AssetRecord;
    const path = resolve(target, 'assets', `${asset.id}${extname(asset.path)}`);
    await cp(asset.path, path, { errorOnExist: true, force: false });
    copy.prepare('UPDATE assets SET metadata=? WHERE id=?').run(JSON.stringify({ ...asset, path }), asset.id);
  }
  let videos = 0;
  for (const row of copy.prepare('SELECT document FROM render_jobs').all()) {
    const job = JSON.parse(String(row.document)) as RenderJob;
    if (job.status === 'completed') {
      await cp(resolve(source, 'renders', `${job.id}.mp4`), resolve(target, 'renders', `${job.id}.mp4`), {
        errorOnExist: true,
        force: false,
      });
      videos++;
    }
  }
  const result = {
    source,
    target,
    createdAt: new Date().toISOString(),
    assets: assetRows.length,
    videos,
    projects: copy.prepare("SELECT id,json_extract(document,'$.revision') AS revision FROM projects").all(),
  };
  await writeFile(resolve(target, 'snapshot-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  copy.close();
}
