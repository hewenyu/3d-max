import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Project, RenderJob } from '../../shared/types';
import { sequenceDuration } from '../../shared/timeline';
import { ProductionMcp } from './production-mcp';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4210' },
    project: { type: 'string' },
    theme: { type: 'string' },
    job: { type: 'string' },
    wait: { type: 'boolean', default: false },
  },
});
if (!values.project || !values.theme || !/^[a-z-]+$/.test(values.theme))
  throw new Error(
    'Provide --project <project-id> --theme <film-name>; optional --job resumes an existing export',
  );

const author = new ProductionMcp(values.theme, values.api);
try {
  await author.connect();
  author.project = values.job
    ? (JSON.parse(await readFile(resolve(author.directory, 'export-project.json'), 'utf8')) as Project)
    : await author.call<Project>('project_open', { id: values.project });
  if (author.project.id !== values.project)
    throw new Error('Saved export snapshot belongs to another project');
  const duration = sequenceDuration(author.project);
  if (duration < 120) throw new Error(`Film is too short: ${duration} seconds`);
  if (!values.job)
    await writeFile(
      resolve(author.directory, 'export-project.json'),
      JSON.stringify(author.project, null, 2),
    );
  let job = values.job
    ? await author.call<RenderJob>('render_status', { id: values.job })
    : await author.call<RenderJob>('render_start', {
        projectId: author.project.id,
        expectedRevision: author.project.revision,
        requestId: `${author.project.id}-r${author.project.revision}-720p24`,
        sequenceId: author.project.activeSequenceId,
        fps: 24,
        resolution: 720,
        aspect: '16:9',
        includeAudio: true,
        burnIn: false,
      });
  if (job.options.projectId !== values.project)
    throw new Error('The selected export belongs to another project');
  if (job.projectRevision !== author.project.revision)
    throw new Error('Saved export snapshot revision does not match the selected render');
  const saveJob = () => writeFile(resolve(author.directory, 'export-job.json'), JSON.stringify(job, null, 2));
  await saveJob();
  console.log(
    JSON.stringify({
      theme: values.theme,
      projectId: values.project,
      jobId: job.id,
      status: job.status,
      totalFrames: job.totalFrames,
    }),
  );
  let lastProgress = '';
  while (values.wait && ['queued', 'rendering', 'encoding'].includes(job.status)) {
    await new Promise((done) => setTimeout(done, 2000));
    job = await author.call<RenderJob>('render_status', { id: job.id });
    const progress = `${job.status} ${Math.floor(job.progress * 100)}% ${job.frame}/${job.totalFrames}`;
    if (progress !== lastProgress) {
      console.log(`${values.theme}: ${progress}`);
      lastProgress = progress;
      await saveJob();
    }
  }
  if (job.status === 'failed' || job.status === 'cancelled')
    throw new Error(`Export ${job.status}: ${job.error ?? job.id}`);
  if (job.status === 'completed') {
    const url = new URL(job.url ?? `/api/renders/${job.id}/file`, values.api).href;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const path = resolve(author.directory, `${values.theme}.mp4`);
    await writeFile(path, bytes);
    const { stdout } = await promisify(execFile)(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-show_entries',
        'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,nb_read_frames',
        '-of',
        'json',
        path,
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    const media = JSON.parse(stdout) as {
      format: { duration: string };
      streams: {
        codec_type: string;
        codec_name: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        nb_frames?: string;
        nb_read_frames?: string;
      }[];
    };
    const video = media.streams.find((stream) => stream.codec_type === 'video');
    const [numerator, denominator] = video?.avg_frame_rate?.split('/').map(Number) ?? [0, 1];
    const frames = Number(video?.nb_read_frames ?? video?.nb_frames);
    if (
      !video ||
      video.codec_name !== 'h264' ||
      Math.min(video.width ?? 0, video.height ?? 0) < 720 ||
      numerator / denominator < 24 ||
      Number(media.format.duration) < 120 ||
      frames < 2880 ||
      frames !== job.totalFrames
    )
      throw new Error(`Export does not meet film media requirements: ${stdout}`);
    await writeFile(
      resolve(author.directory, 'ffprobe.json'),
      JSON.stringify(
        {
          projectId: values.project,
          projectRevision: job.projectRevision,
          jobId: job.id,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
          media,
          mediaGatePassed: true,
          visualReview: 'pending',
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        file: path,
        duration: media.format.duration,
        frames,
        mediaGatePassed: true,
        visualReview: 'pending',
      }),
    );
  }
} finally {
  await author.client.close();
}
