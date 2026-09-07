import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import type { Project, RenderJob } from '../../shared/types';
import { clipDuration } from '../../shared/time-map';
import { ProductionMcp } from './production-mcp';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4210' },
    theme: { type: 'string' },
    manifest: { type: 'string' },
  },
});
if (!values.theme || !/^[a-z-]+$/.test(values.theme) || !values.manifest)
  throw new Error('Provide --theme and --manifest <running frozen runtime manifest>');
const run = promisify(execFile);
const film = new ProductionMcp(values.theme, values.api);
const directory = resolve(film.directory, 'runtime-review');
await mkdir(directory, { recursive: true });
const source = JSON.parse(await readFile(resolve(values.manifest), 'utf8')) as { sourceHash: string };
const accepted = JSON.parse(
  await readFile(resolve(film.directory, 'export-project.json'), 'utf8'),
) as Project;
const job = JSON.parse(await readFile(resolve(film.directory, 'export-job.json'), 'utf8')) as RenderJob;
const ffprobe = JSON.parse(await readFile(resolve(film.directory, 'ffprobe.json'), 'utf8')) as {
  sha256: string;
};
const videoPath = resolve(film.directory, `${values.theme}.mp4`);
assert.equal(
  createHash('sha256')
    .update(await readFile(videoPath))
    .digest('hex'),
  ffprobe.sha256,
);
try {
  await film.connect();
  const project = await film.call<Project>('project_open', { id: accepted.id });
  assert.deepEqual(
    project,
    accepted,
    'Delivered editor project differs from the accepted immutable snapshot',
  );
  const currentJob = await film.call<RenderJob>('render_status', { id: job.id });
  assert.equal(currentJob.status, 'completed');
  assert.equal(currentJob.projectRevision, accepted.revision);
  const streamed = await fetch(new URL(`/api/renders/${job.id}/stream`, values.api));
  assert.equal(streamed.status, 200);
  assert.equal(
    createHash('sha256')
      .update(Buffer.from(await streamed.arrayBuffer()))
      .digest('hex'),
    ffprobe.sha256,
  );
  const sequence = accepted.sequences.find((item) => item.id === accepted.activeSequenceId)!;
  const frames = new Set<number>();
  const fps = job.options.fps!;
  let start = 0;
  for (const clip of sequence.clips) {
    const duration = clipDuration(clip);
    frames.add(Math.round((start + duration / 2) * fps));
    if (start > 0) {
      frames.add(Math.round(start * fps) - 1);
      frames.add(Math.round(start * fps));
    }
    start += duration;
  }
  frames.add(0);
  frames.add(job.totalFrames - 1);
  const samples: { frame: number; time: number; ssim: number; previewSha256: string }[] = [];
  for (const frame of [...frames].sort((a, b) => a - b)) {
    assert.ok(frame >= 0 && frame < job.totalFrames);
    const time = frame / fps;
    const name = `preview-${String(frame).padStart(5, '0')}`;
    await film.preview(time, `runtime-review/${name}`);
    const decoded = resolve(directory, `video-${String(frame).padStart(5, '0')}.png`);
    await run(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', videoPath, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', decoded],
      { timeout: 60000 },
    );
    const preview = resolve(directory, `${name}.png`);
    const comparison = await run(
      'ffmpeg',
      ['-v', 'info', '-i', preview, '-i', decoded, '-lavfi', 'ssim', '-f', 'null', '-'],
      { timeout: 30000 },
    );
    const ssim = Number(/All:([\d.]+)/.exec(comparison.stderr)?.[1]);
    samples.push({
      frame,
      time,
      ssim,
      previewSha256: createHash('sha256')
        .update(await readFile(preview))
        .digest('hex'),
    });
    await writeFile(
      resolve(directory, 'runtime-verification.json'),
      JSON.stringify(
        {
          sourceHash: source.sourceHash,
          projectId: accepted.id,
          revision: accepted.revision,
          videoSha256: ffprobe.sha256,
          jobId: job.id,
          expectedSamples: frames.size,
          samples,
          completed: false,
        },
        null,
        2,
      ),
    );
    assert.ok(ssim > 0.98, `Rendered frame ${frame} differs from accepted video: SSIM ${ssim}`);
    console.log(
      JSON.stringify({ theme: values.theme, frame, ssim, checked: samples.length, total: frames.size }),
    );
  }
  const result = {
    sourceHash: source.sourceHash,
    projectId: accepted.id,
    revision: accepted.revision,
    videoSha256: ffprobe.sha256,
    jobId: job.id,
    samples,
    projectEqualsAcceptedSnapshot: true,
    servedVideoBytesMatch: true,
    completed: true,
  };
  await writeFile(resolve(directory, 'runtime-verification.json'), JSON.stringify(result, null, 2));
} finally {
  await film.close();
}
