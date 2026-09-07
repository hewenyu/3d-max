import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Project, RenderJob } from '../../shared/types';
import { ProductionMcp } from './production-mcp';
import { clipDuration } from '../../shared/time-map';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4222' },
    theme: { type: 'string', default: 'tourism' },
    shot: { type: 'string' },
  },
});
const film = new ProductionMcp(values.theme, values.api);
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const exec = promisify(execFile);
try {
  await film.connect();
  const before = await film.call<{ id: string }[]>('project_list');
  const archive = await readFile(resolve(film.directory, `${values.theme}.whiteframe`));
  const encodedBytes = Math.ceil(archive.length / 3) * 4;
  const transport = encodedBytes <= 32 * 1024 * 1024 ? 'mcp' : 'http-multipart';
  let restored: { project: Project; assets: number; videos: number };
  if (transport === 'mcp')
    restored = await film.call('project_package_import', { dataBase64: archive.toString('base64') });
  else {
    const form = new FormData();
    form.append('file', new Blob([archive]), `${values.theme}.whiteframe`);
    const started = new Date().toISOString();
    const response = await fetch(new URL('/api/packages/import', values.api), { method: 'POST', body: form });
    const text = await response.text();
    await appendFile(
      resolve(film.directory, 'mcp-operations.jsonl'),
      `${JSON.stringify({ started, completed: new Date().toISOString(), transport, endpoint: '/api/packages/import', api: values.api, packageSha256: hash(archive), status: response.status, responseHash: hash(Buffer.from(text)) })}\n`,
    );
    if (!response.ok) throw new Error(`Package upload failed: ${response.status} ${text}`);
    restored = JSON.parse(text) as typeof restored;
    film.project = restored.project;
  }
  const restoredInitial = structuredClone(restored.project);
  const jobs = await film.call<RenderJob[]>('render_status');
  const originalVideo = await readFile(resolve(film.directory, `${values.theme}.mp4`));
  const expectedHash = hash(originalVideo);
  let restoredJob: RenderJob | undefined;
  let restoredVideo: Buffer | undefined;
  const restoredVideoHashes: { jobId: string; revision: number; sha256: string }[] = [];
  for (const candidate of jobs.filter(
    (job) => job.options.projectId === restored.project.id && job.status === 'completed',
  )) {
    const response = await fetch(new URL(candidate.url!, values.api));
    if (!response.ok) throw new Error(`Restored video download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha256 = hash(bytes);
    restoredVideoHashes.push({ jobId: candidate.id, revision: candidate.projectRevision, sha256 });
    if (sha256 === expectedHash) {
      restoredJob = candidate;
      restoredVideo = bytes;
    }
  }
  if (!restoredJob || !restoredVideo || restored.videos < 1 || restored.assets < 1)
    throw new Error('Package omitted required media');
  const sequence = film.project.sequences.find(
    (candidate) => candidate.id === film.project.activeSequenceId,
  )!;
  const selectedClip = values.shot
    ? sequence.clips.find((clip) => clip.shotId === values.shot)
    : sequence.clips[0];
  if (!selectedClip) throw new Error('Select a shot included in the active sequence');
  const shot = film.project.shots.find((candidate) => candidate.id === selectedClip.shotId)!;
  if (
    selectedClip.retiming ||
    selectedClip.cameraTiming ||
    selectedClip.sourceIn !== shot.sourceIn ||
    selectedClip.sourceOut !== shot.sourceOut
  )
    throw new Error('Single-shot byte comparison requires a full unretimed shot with the same camera clock');
  const clipIndex = sequence.clips.indexOf(selectedClip);
  const editStart = sequence.clips.slice(0, clipIndex).reduce((sum, clip) => sum + clipDuration(clip), 0);
  const duration = clipDuration(selectedClip);
  const expectedFrames = Math.ceil(duration * 24);
  const sourceCamera = structuredClone(
    film.project.cameras.find((candidate) => candidate.id === shot.cameraId)!,
  );
  const time = (shot.sourceOut - shot.sourceIn) / 2;
  await film.preview(time, 'package-original', shot.id);
  const originalPreview = await readFile(resolve(film.directory, 'package-original.png'));
  await film.command('camera_update', {
    id: sourceCamera.id,
    patch: {
      fov: sourceCamera.fov + 5,
      keyframes: sourceCamera.keyframes.map((key) => ({ ...key, fov: (key.fov ?? sourceCamera.fov) + 5 })),
    },
  });
  const editedRevision = film.project.revision;
  await film.preview(time, 'package-edited', shot.id);
  const editedPreview = await readFile(resolve(film.directory, 'package-edited.png'));
  if (hash(editedPreview) === hash(originalPreview))
    throw new Error('Restored camera edit did not change actual pixels');
  film.project = await film.call<Project>('history_undo', {
    projectId: film.project.id,
    expectedRevision: film.project.revision,
  });
  if (
    JSON.stringify(film.project.cameras.find((camera) => camera.id === sourceCamera.id)) !==
    JSON.stringify(sourceCamera)
  )
    throw new Error('Undo did not restore the camera');
  await film.preview(time, 'package-undone', shot.id);
  const undonePreview = await readFile(resolve(film.directory, 'package-undone.png'));
  if (hash(undonePreview) !== hash(originalPreview))
    throw new Error('Undo did not restore exact rendered pixels');
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
  console.log(
    JSON.stringify({
      restoredProjectId: film.project.id,
      restoredVideoId: restoredJob.id,
      reexportJobId: job.id,
    }),
  );
  while (['queued', 'rendering', 'encoding'].includes(job.status)) {
    await new Promise((done) => setTimeout(done, 2000));
    job = await film.call<RenderJob>('render_status', { id: job.id });
  }
  if (job.status !== 'completed') throw new Error(`Re-export failed: ${job.error}`);
  const video = Buffer.from(await (await fetch(new URL(job.url!, values.api))).arrayBuffer());
  const videoPath = resolve(film.directory, 'package-reexport.mp4');
  await writeFile(videoPath, video);
  const probe = await exec('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_read_frames',
    '-of',
    'json',
    videoPath,
  ]);
  const media = JSON.parse(probe.stdout);
  const stream = media.streams.find((item: { codec_type: string }) => item.codec_type === 'video');
  if (
    Number(stream.nb_read_frames) !== expectedFrames ||
    stream.width !== 1280 ||
    stream.height !== 720 ||
    stream.avg_frame_rate !== '24/1' ||
    Math.abs(Number(media.format.duration) - duration) > 1 / 24
  )
    throw new Error(
      `Restored single shot did not export ${expectedFrames} valid 720p frames over ${duration} seconds`,
    );
  const similarity = await exec(
    'ffmpeg',
    [
      '-v',
      'info',
      '-i',
      resolve(film.directory, `${values.theme}.mp4`),
      '-i',
      videoPath,
      '-filter_complex',
      `[0:v]trim=start=${editStart}:duration=${duration},setpts=PTS-STARTPTS[a];[a][1:v]ssim`,
      '-an',
      '-f',
      'null',
      '-',
    ],
    { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
  );
  const score = Number(similarity.stderr.match(/All:([\d.]+)/)?.[1]);
  if (!(score > 0.999)) throw new Error(`Restored shot differs from original film: SSIM ${score}`);
  await writeFile(resolve(film.directory, 'package-reexport-compare.log'), similarity.stderr);
  const result = {
    api: values.api,
    packagePath: resolve(film.directory, `${values.theme}.whiteframe`),
    packageBytes: archive.length,
    packageSha256: hash(archive),
    encodedBytes,
    transport,
    projectsBefore: before.length,
    restoredProjectId: film.project.id,
    assets: restored.assets,
    videos: restored.videos,
    restoredVideoHashes,
    restoredInitialRevision: restoredInitial.revision,
    restoredVideoId: restoredJob.id,
    restoredVideoSha256: hash(restoredVideo),
    videoBytesMatch: true,
    editedRevision,
    undoneRevision: film.project.revision,
    originalPreviewHash: hash(originalPreview),
    editedPreviewHash: hash(editedPreview),
    undonePreviewHash: hash(undonePreview),
    undoPixelsMatch: true,
    reexportJobId: job.id,
    reexportPath: videoPath,
    selectedShot: {
      id: shot.id,
      sourceIn: shot.sourceIn,
      sourceOut: shot.sourceOut,
      editStart,
      duration,
      expectedFrames,
    },
    media,
    decodedVideoSsim: score,
    passed: true,
  };
  await writeFile(
    resolve(film.directory, 'package-restoration-report.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await film.close();
}
