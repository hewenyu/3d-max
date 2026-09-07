import { validateProject } from '../shared/schema';
import type { Project, RenderJob } from '../shared/types';
import { ApiError } from './errors';
import type { AssetRecord, Store } from './store';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface PackageState {
  project: Project;
  cursor: number;
  history: Iterable<{ position: number; snapshot: Project }>;
  jobs: Iterable<{ job: RenderJob; snapshot: Project }>;
}

export interface PackageAssetCandidate {
  asset: AssetRecord;
  sha256: string;
  owned: boolean;
}

export function capturePackageState(store: Store, projectId: string, includeHistory: boolean) {
  const file = (store.db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).find(
    (entry) => entry.name === 'main',
  )!.file;
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT document,cursor FROM projects WHERE id=?').get(projectId) as
      { document: string; cursor: number } | undefined;
    if (!row) throw new ApiError('NOT_FOUND', 'Project not found', 404);
    const project = JSON.parse(row.document) as Project;
    function* history() {
      if (!includeHistory) {
        yield { position: 0, snapshot: project };
        return;
      }
      for (const item of db
        .prepare('SELECT position,snapshot FROM history WHERE project_id=? ORDER BY position')
        .iterate(projectId))
        yield { position: Number(item.position), snapshot: JSON.parse(String(item.snapshot)) as Project };
    }
    function* jobs() {
      for (const item of db
        .prepare(
          "SELECT document,snapshot FROM render_jobs WHERE json_extract(snapshot,'$.id')=? ORDER BY rowid",
        )
        .iterate(projectId))
        yield {
          job: JSON.parse(String(item.document)) as RenderJob,
          snapshot: JSON.parse(String(item.snapshot)) as Project,
        };
    }
    return {
      project,
      history,
      jobs,
      cursor: includeHistory ? row.cursor : 0,
      assetByUrl(url: string): AssetRecord | undefined {
        const item = db
          .prepare("SELECT metadata FROM assets WHERE json_extract(metadata,'$.url')=?")
          .get(url);
        return item ? (JSON.parse(String(item.metadata)) as AssetRecord) : undefined;
      },
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function installPackageState(
  store: Store,
  state: PackageState,
  assets: PackageAssetCandidate[],
  onCommit?: (project: Project) => void,
) {
  const project = validateProject(state.project);
  const unusedAssetPaths: string[] = [];
  store.db.exec('BEGIN IMMEDIATE');
  try {
    // Staging yields to other importers; check identity again while holding SQLite's write lock.
    for (const candidate of assets) {
      const { asset, sha256, owned } = candidate;
      const existing = store.asset(asset.id);
      if (existing) {
        if (
          existing.mime !== asset.mime ||
          createHash('sha256').update(readFileSync(existing.path)).digest('hex') !== sha256
        )
          throw new ApiError('ASSET_CONFLICT', `A different asset already uses ID ${asset.id}`, 409);
        if (owned && existing.path !== asset.path) unusedAssetPaths.push(asset.path);
      } else {
        store.db.prepare('INSERT INTO assets(id,metadata) VALUES(?,?)').run(asset.id, JSON.stringify(asset));
      }
    }
    store.assertAssets(project);
    store.db
      .prepare('INSERT INTO projects(id,document,cursor) VALUES(?,?,?)')
      .run(project.id, JSON.stringify(project), state.cursor);
    const insertHistory = store.db.prepare('INSERT INTO history(project_id,position,snapshot) VALUES(?,?,?)');
    let historyCount = 0;
    for (const item of state.history) {
      const snapshot = validateProject(item.snapshot);
      if (item.position !== historyCount++ || snapshot.id !== project.id)
        throw new ApiError('INVALID_PACKAGE', 'Project history positions or identities are invalid');
      store.assertAssets(snapshot);
      insertHistory.run(project.id, item.position, JSON.stringify(snapshot));
    }
    if (!historyCount || state.cursor < 0 || state.cursor >= historyCount)
      throw new ApiError('INVALID_PACKAGE', 'Project history cursor is invalid');
    for (const item of state.jobs) {
      const snapshot = validateProject(item.snapshot);
      if (snapshot.id !== project.id)
        throw new ApiError('INVALID_PACKAGE', 'Package snapshots belong to different projects');
      store.assertAssets(snapshot);
      store.db
        .prepare('INSERT INTO render_jobs(id,document,snapshot) VALUES(?,?,?)')
        .run(item.job.id, JSON.stringify(item.job), JSON.stringify(snapshot));
    }
    store.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES('active_project',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(project.id);
    onCommit?.(project);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return { project, unusedAssetPaths };
}
