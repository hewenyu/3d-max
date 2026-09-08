import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Command, CommandResponse, Project, RenderJob, Vec3 } from '../../shared/types';
import type { ModelingJob } from '../../shared/modeling-jobs';

export interface MeshElement {
  id: string;
  index: number;
  position?: Vec3;
  positions?: Vec3[];
  center?: Vec3;
  normal?: Vec3;
  boundary?: boolean;
  vertices?: string[];
  edges?: string[];
  faces?: string[];
}
export interface MeshInspection {
  objectId: string;
  namespace: string;
  stage: 'source' | 'evaluated';
  kind: 'vertex' | 'edge' | 'face';
  total: number;
  nextOffset: number | null;
  elements: MeshElement[];
  bounds: { min: Vec3; max: Vec3; dimensions: Vec3 };
  diagnostics: Record<string, unknown>;
}

export class ModelingAssetClient {
  readonly sdk = new Client({ name: 'whiteframe-modeling-production', version: '1.0.0' });
  readonly directory: string;
  project!: Project;
  constructor(
    readonly name: string,
    readonly apiUrl: string,
    root = process.env.WHITEFRAME_MODELING_DIR ?? '.data/advanced-modeling/works',
  ) {
    const run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    this.directory = resolve(root, name, run);
  }
  async connect() {
    await mkdir(this.directory, { recursive: true });
    const response = await fetch(new URL('/api/connection', this.apiUrl));
    if (!response.ok) throw new Error(`Connection discovery failed: HTTP ${response.status}`);
    const connection = (await response.json()) as { url: string; token: string };
    await this.sdk.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
      }),
    );
    await this.save('mcp-capabilities.json', await this.sdk.listTools());
  }
  async raw(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const started = new Date().toISOString();
    const result = (await this.sdk.callTool({ name, arguments: args }, undefined, {
      timeout: 150000,
    })) as CallToolResult;
    const serialized = JSON.stringify(result);
    await appendFile(
      resolve(this.directory, 'mcp-operations.jsonl'),
      `${JSON.stringify({
        started,
        finished: new Date().toISOString(),
        name,
        arguments:
          'dataBase64' in args
            ? { ...args, dataBase64: `[${String(args.dataBase64).length} encoded bytes]` }
            : args,
        isError: Boolean(result.isError),
        responseBytes: Buffer.byteLength(serialized),
        responseSha256: createHash('sha256').update(serialized).digest('hex'),
      })}\n`,
    );
    if (result.isError) {
      const error = result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
      throw new Error(`${name}: ${error}`);
    }
    return result;
  }
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.raw(name, args);
    const text = result.content.find((item) => item.type === 'text');
    if (!text || text.type !== 'text') throw new Error(`${name} returned no JSON result`);
    const value = JSON.parse(text.text) as T;
    if (value && typeof value === 'object' && 'project' in value) {
      this.project = (value as { project: Project }).project;
    } else if (
      value &&
      typeof value === 'object' &&
      'schemaVersion' in value &&
      'objects' in value &&
      'revision' in value
    ) {
      this.project = value as unknown as Project;
    }
    return value;
  }
  guard() {
    return {
      projectId: this.project.id,
      expectedRevision: this.project.revision,
      expectedContext: {
        sceneId: this.project.production?.activeSceneId ?? null,
        performanceId: this.project.production?.activePerformanceId ?? null,
      },
    };
  }
  async create(title: string) {
    this.project = await this.call<Project>('project_new', { name: title, template: 'empty' });
    await this.save('empty-project.json', this.project);
    return this.project;
  }
  async refresh() {
    const previousId = this.project?.id;
    const project = await this.call<Project>('project_get');
    if (previousId && project.id !== previousId) throw new Error('The active project changed');
    this.project = project;
    return project;
  }
  async command(name: string, payload: Record<string, unknown>) {
    return this.call<CommandResponse>(name, { ...payload, ...this.guard(), requestId: randomUUID() });
  }
  async commands(commands: Command[], label = 'modeling') {
    for (let offset = 0; offset < commands.length; offset += 150) {
      let job = await this.call<ModelingJob>('modeling_job_start', {
        ...this.guard(),
        requestId: randomUUID(),
        kind: 'commands',
        commands: commands.slice(offset, offset + 150),
      });
      const deadline = Date.now() + 180000;
      while (job.status === 'queued' || job.status === 'running') {
        if (Date.now() > deadline) {
          await this.call('modeling_job_cancel', { id: job.id });
          throw new Error(`${label} exceeded the bounded modeling wait`);
        }
        await new Promise((done) => setTimeout(done, 500));
        job = await this.call<ModelingJob>('modeling_job_status', { id: job.id });
      }
      await this.save(`job-${job.id}.json`, job);
      if (job.status !== 'completed' || !job.result || !('project' in job.result)) {
        throw new Error(`${label}: ${JSON.stringify(job.error ?? { status: job.status })}`);
      }
      this.project = (job.result as CommandResponse).project;
      console.log(
        JSON.stringify({
          stage: label,
          projectId: this.project.id,
          revision: this.project.revision,
          jobId: job.id,
        }),
      );
    }
    return this.project;
  }
  async inspect(
    objectId: string,
    kind: MeshInspection['kind'] = 'face',
    stage: MeshInspection['stage'] = 'source',
  ) {
    const pages: MeshInspection[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: MeshInspection = await this.call('mesh_inspect', {
        ...this.guard(),
        objectId,
        kind,
        stage,
        offset,
        limit: 2000,
      });
      pages.push(page);
      offset = page.nextOffset;
    }
    return { ...pages[0], elements: pages.flatMap((page) => page.elements), nextOffset: null };
  }
  async preview(file: string, shotId: string, time: number) {
    const response = await this.raw('preview_capture', { shotId, time, width: 1280, height: 720 });
    const image = response.content.find((item) => item.type === 'image');
    if (!image || image.type !== 'image') throw new Error('MCP returned no rendered image');
    return this.writeArtifact(file, Buffer.from(image.data, 'base64'));
  }
  async download(url: string, file: string) {
    const address = new URL(url, this.apiUrl);
    if (address.origin !== new URL(this.apiUrl).origin)
      throw new Error('Artifact URL belongs to a different service');
    const response = await fetch(address);
    if (!response.ok) throw new Error(`Artifact download failed: HTTP ${response.status}`);
    return this.writeArtifact(file, Buffer.from(await response.arrayBuffer()));
  }
  async writeArtifact(file: string, bytes: Buffer) {
    const path = resolve(this.directory, file);
    await writeFile(path, bytes);
    const artifact = {
      file,
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    await appendFile(resolve(this.directory, 'artifacts.jsonl'), `${JSON.stringify(artifact)}\n`);
    return artifact;
  }
  async save(file: string, value: unknown) {
    await writeFile(resolve(this.directory, file), JSON.stringify(value, null, 2));
  }
  async exportGlb(name = this.name, objectIds?: string[]) {
    const result = await this.call<{
      id: string;
      url: string;
      sha256: string;
      triangles: number;
      vertices: number;
    }>('model_export', {
      ...this.guard(),
      scope: objectIds ? 'selection' : 'scene',
      ...(objectIds ? { objectIds } : {}),
      sourceTime: 0,
      name,
    });
    const file = await this.download(result.url, `${name}.glb`);
    if (file.sha256 !== result.sha256) throw new Error('Downloaded GLB differs from its export result');
    const bytes = await readFile(file.path);
    if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(8) !== bytes.length)
      throw new Error('Export is not a complete GLB');
    await this.save(`${name}-glb.json`, { ...result, artifact: file });
    return file;
  }
  async exportVideo(name = this.name, expectedDuration = 24) {
    await this.save(`${name}-render-project.json`, this.project);
    let job = await this.call<RenderJob>('render_start', {
      projectId: this.project.id,
      expectedRevision: this.project.revision,
      requestId: randomUUID(),
      sequenceId: this.project.activeSequenceId,
      fps: 24,
      resolution: 720,
      aspect: '16:9',
      includeAudio: false,
      burnIn: false,
    });
    const deadline = Date.now() + 30 * 60 * 1000;
    let previous = '';
    while (['queued', 'rendering', 'encoding'].includes(job.status)) {
      const state = `${job.status}:${Math.floor(job.progress * 20)}`;
      if (state !== previous) {
        previous = state;
        console.log(
          JSON.stringify({
            stage: 'render',
            name,
            id: job.id,
            status: job.status,
            frame: job.frame,
            total: job.totalFrames,
          }),
        );
        await this.save(`${name}-render-job.json`, job);
      }
      if (Date.now() > deadline) {
        await this.call('render_cancel', { id: job.id });
        throw new Error('Video export exceeded its bounded wait');
      }
      await new Promise((done) => setTimeout(done, 1500));
      job = await this.call<RenderJob>('render_status', { id: job.id });
    }
    await this.save(`${name}-render-job.json`, job);
    if (job.status !== 'completed') throw new Error(`Video ${job.status}: ${job.error ?? job.id}`);
    const artifact = await this.download(job.url ?? `/api/renders/${job.id}/file`, `${name}.mp4`);
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
        artifact.path,
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
        nb_read_frames?: string;
        nb_frames?: string;
      }[];
    };
    const stream = media.streams.find((item) => item.codec_type === 'video');
    const rate = stream?.avg_frame_rate?.split('/').map(Number) ?? [0, 1];
    const frames = Number(stream?.nb_read_frames ?? stream?.nb_frames);
    if (
      !stream ||
      stream.codec_name !== 'h264' ||
      Math.min(stream.width ?? 0, stream.height ?? 0) < 720 ||
      rate[0] / rate[1] !== 24 ||
      frames !== job.totalFrames ||
      Math.abs(Number(media.format.duration) - expectedDuration) > 1 / 24
    ) {
      throw new Error(`Unexpected exported media: ${stdout}`);
    }
    const report = {
      jobId: job.id,
      projectId: this.project.id,
      revision: job.projectRevision,
      artifact,
      media,
      mediaGatePassed: true,
      visualReview: 'pending',
    };
    await this.save(`${name}-ffprobe.json`, report);
    return report;
  }
  async exportPackage(name = this.name, includeVideos = true) {
    const archive = await this.call<{
      projectId: string;
      revision: number;
      downloadUrl: string;
      assets: number;
      videos: number;
    }>('project_package_export', {
      projectId: this.project.id,
      includeHistory: true,
      includeVideos,
    });
    if (archive.projectId !== this.project.id || archive.revision !== this.project.revision)
      throw new Error('Project changed before packaging');
    const artifact = await this.download(archive.downloadUrl, `${name}.whiteframe`);
    await this.save(`${name}-package.json`, { ...archive, artifact });
    return artifact;
  }
  async restorePackage(path: string) {
    const bytes = await readFile(path);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const upload = await this.call<{ id: string; chunkBytes: number; missingChunks: number[] }>(
      'transfer_begin',
      {
        kind: 'project-package',
        name: `${this.name}.whiteframe`,
        size: bytes.length,
        sha256: hash,
        requestId: randomUUID(),
      },
    );
    for (const index of upload.missingChunks) {
      const chunk = bytes.subarray(index * upload.chunkBytes, (index + 1) * upload.chunkBytes);
      await this.call('transfer_chunk', {
        id: upload.id,
        index,
        dataBase64: chunk.toString('base64'),
        sha256: createHash('sha256').update(chunk).digest('hex'),
      });
    }
    const status = await this.call<{ missingChunks: number[]; receivedBytes: number }>('transfer_status', {
      id: upload.id,
    });
    if (status.missingChunks.length || status.receivedBytes !== bytes.length)
      throw new Error('Package transfer is incomplete');
    const restored = await this.call<{ project: Project; assets: number; videos: number }>(
      'transfer_commit',
      { id: upload.id },
    );
    this.project = restored.project;
    await this.save('restored-project.json', restored);
    return restored;
  }
  async reviewVideo(name = this.name) {
    const [{ chromium, expect }, report] = await Promise.all([
      import('@playwright/test'),
      readFile(resolve(this.directory, `${name}-ffprobe.json`), 'utf8').then(
        (value) =>
          JSON.parse(value) as {
            jobId: string;
            artifact: { path: string; sha256: string };
            media: { format: { duration: string } };
          },
      ),
    ]);
    const directory = resolve(this.directory, `${name}-review`);
    await mkdir(directory, { recursive: true });
    const run = promisify(execFile);
    const decode = await run(
      'ffmpeg',
      [
        '-v',
        'info',
        '-i',
        report.artifact.path,
        '-vf',
        'blackdetect=d=0.001:pix_th=0.04:pic_th=0.98,freezedetect=n=-60dB:d=1',
        '-an',
        '-f',
        'null',
        '-',
      ],
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    );
    await writeFile(resolve(directory, 'full-decode.log'), decode.stderr);
    if (/black_start:|freeze_start:/.test(decode.stderr))
      throw new Error('Full video decode found black or frozen spans');
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        report.artifact.path,
        '-vf',
        'fps=1,scale=320:180,tile=4x6',
        '-frames:v',
        String(Math.ceil(Number(report.media.format.duration) / 24)),
        '-y',
        resolve(directory, 'frames-%02d.png'),
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    const browser = await chromium.launch();
    const errors: string[] = [];
    const frames: { time: number; frames: number; colors: number; sha256: string }[] = [];
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(this.apiUrl);
      await page.getByRole('button', { name: /^导出视频/ }).click();
      const row = page.locator('.render-job').filter({ has: page.locator(`a[href*="${report.jobId}"]`) });
      for (let index = 0; !(await row.count()) && index < 30; index++)
        await page.getByRole('button', { name: '更多导出记录', exact: true }).click();
      await expect(row).toHaveCount(1);
      await row.getByRole('button', { name: '播放视频', exact: true }).click();
      const player = page.getByLabel('已导出白模视频');
      await expect
        .poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState))
        .toBeGreaterThanOrEqual(2);
      await player.evaluate((video: HTMLVideoElement) => {
        video.pause();
        video.currentTime = 0;
        video.playbackRate = 1;
        video.muted = true;
      });
      await expect.poll(() => player.evaluate((video: HTMLVideoElement) => !video.seeking)).toBe(true);
      const started = Date.now();
      await player.evaluate((video: HTMLVideoElement) => video.play());
      const deadline = Date.now() + Number(report.media.format.duration) * 1000 + 30000;
      while (true) {
        const sample = await player.evaluate((video: HTMLVideoElement) => {
          const canvas = document.createElement('canvas');
          canvas.width = 160;
          canvas.height = 90;
          const context = canvas.getContext('2d')!;
          context.drawImage(video, 0, 0, 160, 90);
          const pixels = context.getImageData(0, 0, 160, 90).data;
          const colors = new Set<number>();
          for (let index = 0; index < pixels.length; index += 4 * 7)
            colors.add((pixels[index] << 16) + (pixels[index + 1] << 8) + pixels[index + 2]);
          return {
            time: video.currentTime,
            frames: video.getVideoPlaybackQuality().totalVideoFrames,
            colors: colors.size,
            data: canvas.toDataURL(),
            ended: video.ended,
            error: video.error?.message,
          };
        });
        if (sample.error || sample.colors < 12)
          throw new Error(`Playback is blank or failed: ${JSON.stringify({ ...sample, data: undefined })}`);
        frames.push({
          time: sample.time,
          frames: sample.frames,
          colors: sample.colors,
          sha256: createHash('sha256').update(sample.data).digest('hex'),
        });
        if (sample.ended) break;
        if (Date.now() > deadline)
          throw new Error('Video did not play completely within the review deadline');
        await page.waitForTimeout(1000);
      }
      const elapsedMs = Date.now() - started;
      const duration = Number(report.media.format.duration);
      if (
        elapsedMs < duration * 950 ||
        Math.abs(frames.at(-1)!.time - duration) > 0.05 ||
        new Set(frames.map((frame) => frame.sha256)).size < Math.floor(duration * 0.8)
      )
        throw new Error('Complete normal-speed moving playback was not demonstrated');
      await page.screenshot({ path: resolve(directory, 'desktop-player.png') });
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('link', { name: '下载 MP4', exact: true }).click();
      const download = await downloadPromise;
      const downloadPath = resolve(directory, 'browser-download.mp4');
      await download.saveAs(downloadPath);
      const downloadHash = createHash('sha256')
        .update(await readFile(downloadPath))
        .digest('hex');
      if (downloadHash !== report.artifact.sha256) throw new Error('Browser download changed video bytes');
      await page.setViewportSize({ width: 390, height: 844 });
      await player.evaluate((video: HTMLVideoElement) => {
        video.currentTime = 3;
      });
      await expect.poll(() => player.evaluate((video: HTMLVideoElement) => !video.seeking)).toBe(true);
      await page.screenshot({ path: resolve(directory, 'mobile-player.png') });
      if ((await page.evaluate(() => document.documentElement.scrollWidth)) !== 390)
        throw new Error('Mobile player overflows the viewport');
      if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
      const result = {
        jobId: report.jobId,
        videoSha256: report.artifact.sha256,
        completedPlayback: true,
        duration,
        elapsedMs,
        samples: frames,
        blackOrFrozenSpans: false,
        browserDownloadSha256: downloadHash,
        mobileWidth: 390,
        errors,
        visualInspection: 'pending',
        directory,
      };
      await this.save(`${name}-playback-review.json`, result);
      return result;
    } finally {
      await browser.close();
    }
  }
  async close() {
    await this.sdk.close();
  }
}
