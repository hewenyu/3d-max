import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { readPackageRecords } from '../../server/package-codec';
import { validateProject } from '../../shared/schema';
import type { Project, RenderJob } from '../../shared/types';
import { clipDuration } from '../../shared/time-map';
import { ProductionMcp } from './production-mcp';
import { sha256, uploadPackage } from './mcp-package-upload';
import { verifyRenderComparison, type RenderBaseline } from './render-baseline';

const run = promisify(execFile);
export const packageShots = {
  tourism: 'travel-shot-3',
  martial: 'martial-shot-8',
  racing: 'race-shot-4',
  space: 'space-shot-6',
} as const;
export type FilmTheme = keyof typeof packageShots;
type AssetEvidence = { id: string; url: string; size: number; sha256: string };
const content = (project: Project) => {
  const { id: _id, revision: _revision, updatedAt: _updatedAt, ...data } = project;
  return data;
};

async function download(api: string, url: string) {
  const response = await fetch(new URL(url, api));
  assert.equal(response.status, 200, `Media download ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function verifyAssets(film: ProductionMcp, assets: AssetEvidence[]) {
  for (const asset of assets) {
    const bytes = await download(film.apiUrl, asset.url);
    assert.equal(bytes.length, asset.size);
    assert.equal(sha256(bytes), asset.sha256, `Restored asset ${asset.id} changed bytes`);
  }
}

async function packageEvidence(bytes: Buffer) {
  const assets: AssetEvidence[] = [];
  const historyHashes: string[] = [];
  let histories = 0;
  let cursor = 0;
  let project: Project | undefined;
  for await (const record of readPackageRecords(bytes)) {
    if (record.type === 'asset') {
      const asset = record.value;
      assert.equal(sha256(Buffer.from(asset.file.data, 'base64')), asset.file.sha256);
      assets.push({ id: asset.id, url: asset.url, size: asset.size, sha256: asset.file.sha256 });
    } else if (record.type === 'history') {
      histories++;
      historyHashes.push(
        sha256(Buffer.from(JSON.stringify(content(validateProject(record.value.snapshot))))),
      );
    } else if (record.type === 'header') {
      project = validateProject(record.value.project);
      cursor = record.value.cursor;
    }
  }
  assert.ok(project);
  assert.ok(histories > 1, 'Accepted package must preserve editable history');
  return { project, assets, histories, historyHashes, cursor };
}

async function exportedHistory(film: ProductionMcp) {
  const exported = await film.call<{ downloadUrl: string }>('project_package_export', {
    projectId: film.project.id,
    includeHistory: true,
    includeVideos: false,
  });
  return packageEvidence(await download(film.apiUrl, exported.downloadUrl));
}

export interface FilmPackageReport {
  theme: FilmTheme;
  api: string;
  sourceHash: string;
  packagePath: string;
  packageBytes: number;
  packageSha256: string;
  transferId: string;
  totalChunks: number;
  transport: 'mcp-chunks';
  restoredProjectId: string;
  restoredRevision: number;
  sourceHistories: number;
  sourceHistoryHashes: string[];
  sourceHistoryCursor: number;
  restoredHistoryHashesMatch: true;
  assets: AssetEvidence[];
  restoredVideoId: string;
  restoredVideoSha256: string;
  originalPreviewHash: string;
  editedPreviewHash: string;
  undonePreviewHash: string;
  undoneRevision: number;
  history: { canUndo: boolean; canRedo: boolean };
  selectedShot: { id: string; name: string; editStart: number; duration: number; expectedFrames: number };
  reexportJobId: string;
  reexportPath: string;
  reexportSha256: string;
  decodedVideoSsim: number;
  renderComparison: Awaited<ReturnType<typeof verifyRenderComparison>>;
  media: unknown;
  passed: true;
}

export async function verifyFilmPackage(
  api: string,
  theme: FilmTheme,
  source: string,
  sourceHash: string,
  baseline?: RenderBaseline,
) {
  const film = new ProductionMcp(theme, api);
  const input = resolve(source, theme);
  try {
    await film.connect();
    const packagePath = resolve(input, `${theme}.whiteframe`);
    const bytes = await readFile(packagePath);
    const evidence = await packageEvidence(bytes);
    const accepted = JSON.parse(await readFile(resolve(input, 'export-project.json'), 'utf8')) as Project;
    assert.deepEqual(evidence.project, accepted);
    const before = await film.call<{ id: string }[]>('project_list');
    const upload = await uploadPackage(film, bytes, `${theme}.whiteframe`);
    const restored = upload.result;
    film.project = restored.project;
    assert.deepEqual(content(restored.project), content(accepted));
    assert.equal((await film.call<{ id: string }[]>('project_list')).length, before.length + 1);
    assert.equal(restored.assets, evidence.assets.length);
    await verifyAssets(film, evidence.assets);
    const restoredHistory = await exportedHistory(film);
    assert.deepEqual(restoredHistory.historyHashes, evidence.historyHashes);
    assert.equal(restoredHistory.cursor, evidence.cursor);
    const acceptedVideo = JSON.parse(await readFile(resolve(input, 'ffprobe.json'), 'utf8')) as {
      sha256: string;
    };
    const sourceVideo = resolve(input, `${theme}.mp4`);
    assert.equal(sha256(await readFile(sourceVideo)), acceptedVideo.sha256);
    const jobs = await film.call<RenderJob[]>('render_status');
    let restoredVideoId = '';
    for (const job of jobs.filter(
      (item) => item.options.projectId === film.project.id && item.status === 'completed',
    )) {
      if (sha256(await download(api, job.url!)) === acceptedVideo.sha256) restoredVideoId = job.id;
    }
    assert.ok(restoredVideoId, 'Accepted full film was not preserved in the package');
    const sequence = film.project.sequences.find((item) => item.id === film.project.activeSequenceId)!;
    const clip = sequence.clips.find((item) => item.shotId === packageShots[theme])!;
    const shot = film.project.shots.find((item) => item.id === clip.shotId)!;
    assert.ok(!clip.retiming && !clip.cameraTiming);
    assert.equal(clip.sourceIn, shot.sourceIn);
    assert.equal(clip.sourceOut, shot.sourceOut);
    const editStart = sequence.clips
      .slice(0, sequence.clips.indexOf(clip))
      .reduce((sum, item) => sum + clipDuration(item), 0);
    const duration = clipDuration(clip);
    const time = duration / 2;
    const camera = structuredClone(film.project.cameras.find((item) => item.id === shot.cameraId)!);
    await film.preview(time, 'original', shot.id);
    const originalPreviewHash = sha256(await readFile(resolve(film.directory, 'original.png')));
    await film.command('camera_update', {
      id: camera.id,
      patch: {
        fov: camera.fov + 5,
        keyframes: camera.keyframes.map((key) => ({ ...key, fov: (key.fov ?? camera.fov) + 5 })),
      },
    });
    await film.preview(time, 'edited', shot.id);
    const editedPreviewHash = sha256(await readFile(resolve(film.directory, 'edited.png')));
    assert.notEqual(editedPreviewHash, originalPreviewHash, 'Camera edit must change actual pixels');
    film.project = await film.call<Project>('history_undo', {
      projectId: film.project.id,
      expectedRevision: film.project.revision,
    });
    assert.deepEqual(content(film.project), content(accepted));
    await film.preview(time, 'undone', shot.id);
    const undonePreviewHash = sha256(await readFile(resolve(film.directory, 'undone.png')));
    assert.equal(undonePreviewHash, originalPreviewHash, 'Undo must restore rendered pixels exactly');
    const history = await film.call<{ canUndo: boolean; canRedo: boolean }>('history_status');
    assert.deepEqual(history, { canUndo: true, canRedo: true });
    let job = await film.call<RenderJob>('render_start', {
      projectId: film.project.id,
      expectedRevision: film.project.revision,
      requestId: randomUUID(),
      shotId: shot.id,
      fps: 24,
      resolution: 720,
      aspect: '16:9',
      includeAudio: false,
      burnIn: false,
    });
    const deadline = Date.now() + 20 * 60 * 1000;
    let previousProgress = -1;
    while (['queued', 'rendering', 'encoding'].includes(job.status)) {
      assert.ok(Date.now() < deadline, `Render ${job.id} exceeded twenty minutes`);
      await new Promise((done) => setTimeout(done, 2000));
      job = await film.call<RenderJob>('render_status', { id: job.id });
      const progress = Math.floor(job.progress * 10);
      if (progress !== previousProgress) {
        previousProgress = progress;
        console.log(JSON.stringify({ theme, jobId: job.id, status: job.status, progress: job.progress }));
      }
    }
    assert.equal(job.status, 'completed', job.error);
    const reexportPath = resolve(film.directory, 'reexport.mp4');
    const video = await download(api, job.url!);
    await writeFile(reexportPath, video);
    const probe = await run('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_read_frames',
      '-of',
      'json',
      reexportPath,
    ]);
    const media = JSON.parse(probe.stdout);
    const stream = media.streams.find((item: { codec_type: string }) => item.codec_type === 'video');
    const expectedFrames = Math.ceil(duration * 24);
    assert.equal(Number(stream.nb_read_frames), expectedFrames);
    assert.equal(stream.width, 1280);
    assert.equal(stream.height, 720);
    assert.equal(stream.avg_frame_rate, '24/1');
    assert.ok(Math.abs(Number(media.format.duration) - duration) <= 1 / 24);
    const comparison = await run(
      'ffmpeg',
      [
        '-v',
        'info',
        '-i',
        sourceVideo,
        '-i',
        reexportPath,
        '-filter_complex',
        `[0:v]trim=start=${editStart}:duration=${duration},setpts=PTS-STARTPTS[a];[a][1:v]ssim`,
        '-an',
        '-f',
        'null',
        '-',
      ],
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    );
    await writeFile(resolve(film.directory, 'reexport-ssim.log'), comparison.stderr);
    const decodedVideoSsim = Number(comparison.stderr.match(/All:([\d.]+)/)?.[1]);
    const renderComparison = await verifyRenderComparison({
      ssim: decodedVideoSsim,
      video: reexportPath,
      project: film.project,
      renderOptions: {
        shotId: shot.id,
        fps: 24,
        resolution: 720,
        aspect: '16:9',
        includeAudio: false,
        burnIn: false,
      },
      expectedFrames,
      directory: film.directory,
      baseline,
    });
    const report: FilmPackageReport = {
      theme,
      api,
      sourceHash,
      packagePath,
      packageBytes: upload.packageBytes,
      packageSha256: upload.packageSha256,
      transferId: upload.transferId,
      totalChunks: upload.totalChunks,
      transport: 'mcp-chunks',
      restoredProjectId: restored.project.id,
      restoredRevision: restored.project.revision,
      sourceHistories: evidence.histories,
      sourceHistoryHashes: evidence.historyHashes,
      sourceHistoryCursor: evidence.cursor,
      restoredHistoryHashesMatch: true,
      assets: evidence.assets,
      restoredVideoId,
      restoredVideoSha256: acceptedVideo.sha256,
      originalPreviewHash,
      editedPreviewHash,
      undonePreviewHash,
      undoneRevision: film.project.revision,
      history,
      selectedShot: { id: shot.id, name: shot.name, editStart, duration, expectedFrames },
      reexportJobId: job.id,
      reexportPath,
      reexportSha256: sha256(video),
      decodedVideoSsim,
      renderComparison,
      media,
      passed: true,
    };
    await writeFile(resolve(film.directory, 'mcp-package-report.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        theme,
        completed: true,
        transferId: upload.transferId,
        restoredProjectId: film.project.id,
        decodedVideoSsim,
      }),
    );
    return report;
  } finally {
    await film.close();
  }
}

export async function verifyFilmRestart(api: string, report: FilmPackageReport, source: string) {
  const film = new ProductionMcp(report.theme, api);
  try {
    await film.connect();
    const selected = await film.call<Project>('project_get');
    const projectsBefore = await film.call<{ id: string }[]>('project_list');
    const replay = await film.call<{ project: Project }>('transfer_commit', { id: report.transferId });
    assert.equal(replay.project.id, report.restoredProjectId);
    assert.equal(
      (await film.call<Project>('project_get')).id,
      selected.id,
      'Replay must not change the selected project',
    );
    assert.deepEqual(
      await film.call('project_list'),
      projectsBefore,
      'Restart replay must not import a second project',
    );
    const project = await film.call<Project>('project_open', { id: report.restoredProjectId });
    film.project = project;
    const accepted = JSON.parse(
      await readFile(resolve(source, report.theme, 'export-project.json'), 'utf8'),
    ) as Project;
    assert.deepEqual(content(project), content(accepted));
    assert.equal(project.revision, report.undoneRevision);
    const history = await film.call('history_status');
    assert.deepEqual(history, report.history);
    const persistedHistory = await exportedHistory(film);
    assert.deepEqual(
      persistedHistory.historyHashes.slice(0, report.sourceHistoryCursor + 1),
      report.sourceHistoryHashes.slice(0, report.sourceHistoryCursor + 1),
    );
    assert.equal(persistedHistory.cursor, report.sourceHistoryCursor);
    assert.equal(
      persistedHistory.histories,
      report.sourceHistoryCursor + 2,
      'The undone camera edit must remain in redo history',
    );
    await verifyAssets(film, report.assets);
    for (const [id, expectedHash] of [
      [report.restoredVideoId, report.restoredVideoSha256],
      [report.reexportJobId, report.reexportSha256],
    ]) {
      const job = await film.call<RenderJob>('render_status', { id });
      assert.equal(job.status, 'completed');
      assert.equal(sha256(await download(api, job.url!)), expectedHash);
    }
    const result = {
      api,
      sourceHash: report.sourceHash,
      projectId: project.id,
      revision: project.revision,
      history,
      verifiedAssetHashes: report.assets.length,
      verifiedHistorySnapshots: persistedHistory.histories,
      commitReplayCreatedNoProject: true,
      commitReplayPreservedSelection: true,
      acceptedAndReexportedVideosMatch: true,
      passed: true,
    };
    await writeFile(
      resolve(film.directory, 'mcp-package-restart-report.json'),
      JSON.stringify(result, null, 2),
    );
    return result;
  } finally {
    await film.close();
  }
}
