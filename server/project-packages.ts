import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { extname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { validateProject } from '../shared/schema';
import type { Project, RenderJob } from '../shared/types';
import type { ServerConfig } from './config';
import type { Store } from './store';
import { ApiError } from './errors';
import { validateModel } from './assets';
import { capturePackageState, installPackageState, type PackageAssetCandidate } from './package-store';
import {
  binarySchema,
  packageAssetSchema,
  packageLimits,
  encodePackageRecords,
  readPackageRecords,
  type PackageRecord,
} from './package-codec';

const exec = promisify(execFile);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface PackageOptions {
  projectId?: string;
  includeHistory?: boolean;
  includeVideos?: boolean;
}

function projectAssetUrls(project: Project): string[] {
  const objects = [
    ...project.objects,
    ...(project.production?.scenes.flatMap((scene) => scene.objects) ?? []),
  ];
  const audio = [
    ...project.audio,
    ...(project.production?.scenes.flatMap((scene) => scene.performances.flatMap((take) => take.audio)) ??
      []),
  ];
  return [
    ...objects.flatMap((object) => (object.assetUrl ? [object.assetUrl] : [])),
    ...audio.map((clip) => clip.url),
  ];
}

function modelDependencies(bytes: Buffer, extension: string): string[] {
  if (!['.gltf', '.glb'].includes(extension)) return [];
  const document = JSON.parse(
    extension === '.glb' ? bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)) : bytes.toString('utf8'),
  ) as {
    buffers?: { uri?: string }[];
    images?: { uri?: string }[];
  };
  return [...(document.buffers ?? []), ...(document.images ?? [])].flatMap((item) =>
    item.uri?.startsWith('/api/assets/') ? [item.uri] : [],
  );
}

function encodeFile(bytes: Buffer) {
  if (Math.ceil(bytes.length / 3) * 4 > packageLimits.record - 1024)
    throw new ApiError('PACKAGE_TOO_LARGE', 'A package binary exceeds the per-record limit', 413);
  return { data: bytes.toString('base64'), sha256: hash(bytes) };
}

export async function exportProjectPackage(store: Store, config: ServerConfig, options: PackageOptions = {}) {
  const state = capturePackageState(
    store,
    options.projectId ?? store.project().id,
    options.includeHistory !== false,
  );
  let assets = 0;
  let videos = 0;
  try {
    const urls = new Set(projectAssetUrls(state.project));
    for (const item of state.history()) for (const url of projectAssetUrls(item.snapshot)) urls.add(url);
    for (const item of state.jobs()) for (const url of projectAssetUrls(item.snapshot)) urls.add(url);
    async function* records(): AsyncGenerator<PackageRecord> {
      yield {
        type: 'header',
        value: {
          format: 'whiteframe-project',
          createdAt: new Date().toISOString(),
          project: state.project,
          cursor: state.cursor,
        },
      };
      let history = 0;
      for (const value of state.history()) {
        yield { type: 'history', value };
        history++;
      }
      // Dependencies added during iteration are visited by Set's iterator.
      for (const url of urls) {
        const asset = state.assetByUrl(url);
        if (!asset) throw new ApiError('INVALID_ASSET', `Cannot package unavailable asset: ${url}`);
        const bytes = await readFile(asset.path);
        const extension = extname(asset.path).toLowerCase();
        const { path: _path, ...metadata } = asset;
        yield {
          type: 'asset',
          value: packageAssetSchema.parse({ ...metadata, extension, file: encodeFile(bytes) }),
        };
        assets++;
        for (const dependency of modelDependencies(bytes, extension)) urls.add(dependency);
      }
      let jobs = 0;
      for (const item of state.jobs()) {
        if (options.includeVideos && item.job.status === 'completed') {
          const bytes = await readFile(resolve(config.dataDir, 'renders', `${item.job.id}.mp4`));
          yield { type: 'job', value: { ...item, file: encodeFile(bytes) } };
          videos++;
        } else yield { type: 'job', value: item };
        jobs++;
      }
      yield { type: 'end', history, assets, jobs };
    }
    const data = await encodePackageRecords(records());
    return { data, projectId: state.project.id, revision: state.project.revision, assets, videos };
  } finally {
    state.close();
  }
}

function decodeFile(file: z.infer<typeof binarySchema>): Buffer {
  if (file.data.length % 4 !== 0 || (file.data.length / 4) * 3 > packageLimits.compressed)
    throw new ApiError('INVALID_PACKAGE', 'Invalid binary encoding');
  const bytes = Buffer.from(file.data, 'base64');
  if (bytes.toString('base64') !== file.data)
    throw new ApiError('INVALID_PACKAGE', 'Invalid binary encoding');
  if (hash(bytes) !== file.sha256) throw new ApiError('INVALID_PACKAGE', 'Package binary checksum mismatch');
  return bytes;
}

async function mediaInfo(path: string, kind: 'audio' | 'video') {
  const { stdout } = await exec(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path],
    { timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string }[] };
  const duration = Number(info.format?.duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !info.streams?.some((stream) => stream.codec_type === kind)
  )
    throw new ApiError('INVALID_PACKAGE', `Package contains invalid ${kind}`);
  return duration;
}

export async function importProjectPackage(store: Store, config: ServerConfig, data: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-package-stage-'));
  const staging = new DatabaseSync(join(directory, 'records.sqlite'));
  staging.exec(
    'CREATE TABLE history (position INTEGER PRIMARY KEY,snapshot TEXT NOT NULL); CREATE TABLE jobs (source_id TEXT PRIMARY KEY,document TEXT NOT NULL,snapshot TEXT NOT NULL)',
  );
  let project: Project | undefined;
  let sourceProjectId = '';
  const newProjectId = randomUUID();
  let cursor = 0;
  const remapProject = (input: unknown) => {
    const snapshot = validateProject(input);
    if (snapshot.id !== sourceProjectId)
      throw new ApiError('INVALID_PACKAGE', 'Package mixes different projects');
    snapshot.id = newProjectId;
    return snapshot;
  };
  const assets: PackageAssetCandidate[] = [];
  const assetIds = new Set<string>();
  const historyPositions = new Set<number>();
  const sourceJobIds = new Set<string>();
  const written: string[] = [];
  let committed = false;
  let unusedAssetPaths: string[] = [];
  const jobs: RenderJob[] = [];
  try {
    for await (const record of readPackageRecords(data)) {
      if (record.type === 'header') {
        sourceProjectId = validateProject(record.value.project).id;
        project = remapProject(record.value.project);
        cursor = record.value.cursor;
      } else if (record.type === 'history') {
        if (historyPositions.has(record.value.position))
          throw new ApiError('INVALID_PACKAGE', 'Duplicate history positions');
        historyPositions.add(record.value.position);
        staging
          .prepare('INSERT INTO history(position,snapshot) VALUES(?,?)')
          .run(record.value.position, JSON.stringify(remapProject(record.value.snapshot)));
      } else if (record.type === 'asset') {
        const asset = record.value;
        if (assetIds.has(asset.id)) throw new ApiError('INVALID_PACKAGE', 'Duplicate asset IDs');
        assetIds.add(asset.id);
        if (asset.url !== `/api/assets/${asset.id}/file`)
          throw new ApiError('INVALID_PACKAGE', 'Invalid asset URL');
        const bytes = decodeFile(asset.file);
        if (bytes.length !== asset.size) throw new ApiError('INVALID_PACKAGE', 'Asset byte length mismatch');
        const existing = store.asset(asset.id);
        if (existing) {
          if (hash(await readFile(existing.path)) !== asset.file.sha256 || existing.mime !== asset.mime)
            throw new ApiError('ASSET_CONFLICT', `A different asset already uses ID ${asset.id}`, 409);
          assets.push({ asset: existing, sha256: asset.file.sha256, owned: false });
          continue;
        }
        const path = resolve(config.dataDir, 'assets', `${asset.id}-${randomUUID()}${asset.extension}`);
        await writeFile(path, bytes, { flag: 'wx' });
        written.push(path);
        const model = ['.glb', '.gltf'].includes(asset.extension);
        if (model && asset.mime !== (asset.extension === '.glb' ? 'model/gltf-binary' : 'model/gltf+json'))
          throw new ApiError('INVALID_PACKAGE', 'Model MIME type mismatch');
        if (!model && !asset.mime.startsWith('audio/'))
          throw new ApiError('INVALID_PACKAGE', 'Audio MIME type mismatch');
        const duration = model ? undefined : await mediaInfo(path, 'audio');
        assets.push({
          asset: {
            id: asset.id,
            name: asset.name,
            mime: asset.mime,
            size: bytes.length,
            url: asset.url,
            path,
            ...(duration ? { duration } : {}),
          },
          sha256: asset.file.sha256,
          owned: true,
        });
      } else if (record.type === 'job') {
        const item = record.value;
        if (sourceJobIds.has(item.job.id)) throw new ApiError('INVALID_PACKAGE', 'Duplicate render job IDs');
        sourceJobIds.add(item.job.id);
        const snapshot = remapProject(item.snapshot);
        const jobId = randomUUID();
        const job: RenderJob = {
          ...item.job,
          id: jobId,
          options: { ...item.job.options, projectId: newProjectId },
        };
        delete job.url;
        if (item.file) {
          if (item.job.status !== 'completed')
            throw new ApiError('INVALID_PACKAGE', 'Only completed renders may include videos');
          const path = resolve(config.dataDir, 'renders', `${jobId}.mp4`);
          await writeFile(path, decodeFile(item.file), { flag: 'wx' });
          written.push(path);
          await mediaInfo(path, 'video');
          job.url = `/api/renders/${jobId}/file`;
        } else if (['queued', 'rendering', 'encoding', 'completed'].includes(job.status)) {
          job.status = 'failed';
          job.error = 'Video not included in the package; export the saved snapshot again';
        }
        staging
          .prepare('INSERT INTO jobs(source_id,document,snapshot) VALUES(?,?,?)')
          .run(item.job.id, JSON.stringify(job), JSON.stringify(snapshot));
        jobs.push(job);
      }
    }
    if (!project) throw new ApiError('INVALID_PACKAGE', 'Package has no project');
    const assetLookup = {
      assetByUrl: (url: string) =>
        assets.find(({ asset }) => asset.url === url)?.asset ?? store.assetByUrl(url),
    } as Store;
    for (const { asset } of assets.filter((item) => item.owned && item.asset.mime.startsWith('model/')))
      await validateModel(await readFile(asset.path), extname(asset.path), assetLookup);
    function* history() {
      for (const row of staging.prepare('SELECT position,snapshot FROM history ORDER BY position').iterate())
        yield { position: Number(row.position), snapshot: JSON.parse(String(row.snapshot)) as Project };
    }
    function* snapshots() {
      for (const row of staging.prepare('SELECT document,snapshot FROM jobs ORDER BY rowid').iterate())
        yield {
          job: JSON.parse(String(row.document)) as RenderJob,
          snapshot: JSON.parse(String(row.snapshot)) as Project,
        };
    }
    const installed = installPackageState(
      store,
      { project, cursor, history: history(), jobs: snapshots() },
      assets,
    );
    committed = true;
    unusedAssetPaths = installed.unusedAssetPaths;
    const restored = installed.project;
    store.emit('project', restored);
    for (const job of jobs) store.emit('render', job);
    return {
      project: restored,
      assets: assetIds.size,
      videos: jobs.filter((job) => job.status === 'completed').length,
    };
  } finally {
    try {
      staging.close();
      await rm(directory, { recursive: true, force: true });
    } finally {
      await Promise.allSettled((committed ? unusedAssetPaths : written).map((path) => unlink(path)));
    }
  }
}
