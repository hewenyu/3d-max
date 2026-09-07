import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Project } from '../../shared/types';
import { readPackageRecords } from '../../server/package-codec';
import { ProductionMcp } from './production-mcp';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4210' },
    project: { type: 'string' },
    theme: { type: 'string' },
    revision: { type: 'string' },
  },
});
if (
  !values.project ||
  !values.theme ||
  !/^[a-z-]+$/.test(values.theme) ||
  !/^\d+$/.test(values.revision ?? '')
)
  throw new Error('Provide --project, --theme and --revision for the accepted film');
const film = new ProductionMcp(values.theme, values.api);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
try {
  await film.connect();
  const evidence = JSON.parse(await readFile(resolve(film.directory, 'ffprobe.json'), 'utf8')) as {
    projectId: string;
    projectRevision: number;
    jobId: string;
    sha256: string;
  };
  if (evidence.projectId !== values.project || evidence.projectRevision !== Number(values.revision))
    throw new Error('The accepted video evidence does not match the requested project/revision');
  const video = await readFile(resolve(film.directory, `${values.theme}.mp4`));
  if (hash(video) !== evidence.sha256) throw new Error('The accepted video file hash has changed');
  const archive = await film.call<{
    projectId: string;
    revision: number;
    downloadUrl: string;
    assets: number;
    videos: number;
  }>('project_package_export', {
    projectId: values.project,
    includeHistory: true,
    includeVideos: true,
  });
  if (archive.projectId !== values.project || archive.revision !== Number(values.revision))
    throw new Error('The source project changed before packaging');
  const response = await fetch(archive.downloadUrl);
  if (!response.ok) throw new Error(`Package download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  let historySnapshots = 0;
  let accepted = false;
  const archivedAssets: { id: string; url: string; size: number; sha256: string }[] = [];
  const archivedVideos: { jobId: string; revision: number; sha256: string }[] = [];
  for await (const record of readPackageRecords(bytes)) {
    if (record.type === 'header') {
      const project = record.value.project as Project;
      if (project.id !== values.project || project.revision !== Number(values.revision))
        throw new Error('Downloaded package project differs from source metadata');
    } else if (record.type === 'history') historySnapshots++;
    else if (record.type === 'asset') {
      const asset = record.value;
      if (hash(Buffer.from(asset.file.data, 'base64')) !== asset.file.sha256)
        throw new Error('Package asset checksum mismatch');
      archivedAssets.push({ id: asset.id, url: asset.url, size: asset.size, sha256: asset.file.sha256 });
    } else if (record.type === 'job' && record.value.file) {
      const { job, file } = record.value;
      if (hash(Buffer.from(file.data, 'base64')) !== file.sha256)
        throw new Error('Package video checksum mismatch');
      archivedVideos.push({ jobId: job.id, revision: job.projectRevision, sha256: file.sha256 });
      if (job.id === evidence.jobId && file.sha256 === evidence.sha256) accepted = true;
    }
  }
  if (!accepted) throw new Error('Package omitted or changed the accepted video');
  const path = resolve(film.directory, `${values.theme}.whiteframe`);
  await writeFile(path, bytes);
  const result = {
    api: values.api,
    sourceProjectId: values.project,
    sourceRevision: Number(values.revision),
    packagePath: path,
    packageBytes: bytes.length,
    packageSha256: hash(bytes),
    includeHistory: true,
    includeVideos: true,
    historySnapshots,
    assets: archivedAssets.length,
    videos: archivedVideos.length,
    acceptedVideo: { jobId: evidence.jobId, sha256: evidence.sha256, bytes: video.length },
    archivedAssets,
    archivedVideos,
    passed: true,
  };
  await writeFile(resolve(film.directory, 'package-export-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await film.close();
}
