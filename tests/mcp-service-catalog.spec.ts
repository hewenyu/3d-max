import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { commandDefinitions } from '../shared/commands';
import type { FaceAnalysisResult, MorphCatalog } from '../shared/face-analysis';
import type { ModelCatalog } from '../shared/model-catalog';
import type { ReviewComment, ReviewInvite, ReviewPublication } from '../shared/review';
import type { SpeechCatalog, SpeechResult } from '../shared/speech';
import type { TemplateContent, TemplateSummary } from '../shared/templates';
import type { Command, CommandResponse, Project, RenderJob } from '../shared/types';
import { skinnedModelAsset } from './fixtures/skinned-model';
import { exerciseTransferCatalog, exerciseWorkspaceCatalog } from './fixtures/mcp-service-parity';

const exec = promisify(execFile);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Role = 'owner' | 'reviewer' | 'viewer';

async function catalogModel() {
  const io = new NodeIO();
  const document = await io.readBinary(await skinnedModelAsset(true));
  const mesh = document.getRoot().listMeshes()[0];
  const delta = document
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 0, 0, 0, 0.2, -0.2, 0, -0.2, -0.2, 0]))
    .setBuffer(document.getRoot().listBuffers()[0]);
  mesh.setExtras({ targetNames: ['jawOpen'] }).setWeights([0]);
  mesh
    .listPrimitives()[0]
    .addTarget(document.createPrimitiveTarget('jawOpen').setAttribute('POSITION', delta));
  return Buffer.from(await io.writeBinary(document));
}

test('every declared MCP service tool succeeds with real media, persistence and review principals', async ({
  request,
  page,
}, testInfo) => {
  test.setTimeout(300000);
  const directory = testInfo.outputPath('artifacts');
  await mkdir(directory, { recursive: true });
  const connection = await (await request.get('/api/connection')).json();
  const client = new Client({ name: 'mcp-service-catalog', version: '1.0' });
  const clients = [client];
  const success: Record<Role, Set<string>> = {
    owner: new Set(),
    reviewer: new Set(),
    viewer: new Set(),
  };
  const declared: Record<Role, string[]> = { owner: [], reviewer: [], viewer: [] };
  const journal: unknown[] = [];
  const evidence: Record<string, unknown> = {};
  let passed = false;
  const callWith = async <T = any>(
    target: Client,
    role: Role,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    const started = new Date().toISOString();
    const result = await target.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    journal.push({
      role,
      name,
      started,
      completed: new Date().toISOString(),
      argumentsHash: hash(Buffer.from(JSON.stringify(args))),
      responseHash: hash(Buffer.from(JSON.stringify(result))),
      success: !result.isError,
    });
    expect(result.isError, `${role} ${name}: ${JSON.stringify(result)}`).not.toBe(true);
    success[role].add(name);
    const text = (result.content as { type: string; text?: string }[]).find((part) => part.type === 'text');
    return (text ? JSON.parse(text.text!) : result) as T;
  };
  const call = <T = any>(name: string, args: Record<string, unknown> = {}) =>
    callWith<T>(client, 'owner', name, args);
  const connect = (target: Client, url: string, token: string) =>
    target.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
  try {
    await connect(client, connection.url, connection.token);
    const catalog = await client.listTools();
    const commands = new Set(commandDefinitions.map((definition) => definition.type.replaceAll('.', '_')));
    declared.owner = catalog.tools
      .map((tool) => tool.name)
      .filter((name) => !commands.has(name))
      .sort();
    await writeFile(`${directory}/owner-catalog.json`, JSON.stringify(catalog, null, 2));
    const initial = await call<Project>('project_get');
    expect((await call<Project[]>('project_list')).some((project) => project.id === initial.id)).toBe(true);
    const capabilities = await call('capabilities_list');
    expect(capabilities.commands.map((item: { type: string }) => item.type).sort()).toEqual(
      commandDefinitions.map((definition) => definition.type).sort(),
    );
    let project = await call<Project>('project_new', {
      name: `MCP service catalog ${Date.now()}`,
      template: 'empty',
    });
    expect(project.id).not.toBe(initial.id);
    expect((await call<Project>('project_open', { id: initial.id })).id).toBe(initial.id);
    project = await call<Project>('project_open', { id: project.id });
    const guard = () => ({
      projectId: project.id,
      expectedRevision: project.revision,
      requestId: randomUUID(),
    });
    const edit = async (operations: Command[]) => {
      project = (await call<CommandResponse>('edit_batch', { ...guard(), commands: operations })).project;
      expect(await (await request.get('/api/project')).json()).toEqual(project);
    };
    const modelBytes = await catalogModel();
    evidence.transfer = await exerciseTransferCatalog(call, modelBytes);
    const asset = await call<{ id: string; url: string }>('asset_import', {
      name: 'catalog-performer.glb',
      dataBase64: modelBytes.toString('base64'),
    });
    expect(hash(await (await request.get(asset.url)).body())).toBe(hash(modelBytes));
    await edit([
      { type: 'project.settings', payload: { aspect: '16:9', fps: 24, resolution: 720 } },
      { type: 'object.create', payload: { id: 'speaker', type: 'actor', name: 'Speaker' } },
      {
        type: 'object.create',
        payload: {
          id: 'imported',
          type: 'model',
          name: 'Imported performer',
          position: [-2, 0, 0],
          assetUrl: asset.url,
          animationIndex: 0,
        },
      },
      {
        type: 'object.create',
        payload: { id: 'falling', type: 'sphere', name: 'Falling prop', position: [2, 3, 0] },
      },
      { type: 'physics.body.set', payload: { id: 'falling', body: { mode: 'dynamic', shape: 'sphere' } } },
      {
        type: 'camera.create',
        payload: {
          id: 'camera',
          name: 'Service camera',
          position: [4, 3, 7],
          target: [0, 1.1, 0],
          fov: 42,
        },
      },
      {
        type: 'shot.create',
        payload: {
          id: 'shot',
          name: 'Service shot',
          cameraId: 'camera',
          sourceIn: 0,
          sourceOut: 4,
          subjectIds: ['speaker'],
        },
      },
      {
        type: 'sequence.update',
        payload: {
          id: project.activeSequenceId,
          patch: { clips: [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 4 }] },
        },
      },
    ]);
    const beforeUndo = structuredClone(project);
    expect(await call('history_status')).toEqual(await (await request.get('/api/history')).json());
    expect(await call('history_status')).toMatchObject({ canUndo: true, canRedo: false });
    project = await call<Project>('history_undo', {
      projectId: project.id,
      expectedRevision: project.revision,
    });
    expect(project.objects).toHaveLength(0);
    expect(await call('history_status')).toMatchObject({ canRedo: true });
    project = await call<Project>('history_redo', {
      projectId: project.id,
      expectedRevision: project.revision,
    });
    expect(project.objects).toEqual(beforeUndo.objects);
    expect(project.shots).toEqual(beforeUndo.shots);
    const model = await call<ModelCatalog>('model_catalog', { objectId: 'imported', projectId: project.id });
    expect(model.skins[0].joints).toHaveLength(2);
    expect(model.animations.map((animation) => animation.name)).toEqual(['Sway left', 'Sway right']);
    const morph = await call<MorphCatalog>('model_morph_catalog', {
      objectId: 'imported',
      projectId: project.id,
    });
    expect(morph.meshes[0].targets).toEqual(['jawOpen']);
    const face = await call('actor_face_catalog');
    expect(face.lipsync.available).toBe(true);
    const speechCatalog = await call<SpeechCatalog>('speech_catalog');
    expect(speechCatalog.available).toBe(true);
    const engine = speechCatalog.engines.find(
      (item) => item.available && item.voices.some((voice) => /^en/.test(voice.language)),
    )!;
    expect(engine).toBeTruthy();
    const voice = engine.voices.find((item) => /^en/.test(item.language))!;
    const speech = await call<SpeechResult>('speech_synthesize', {
      ...guard(),
      engine: engine.id,
      voice: voice.id,
      rate: 200,
      text: 'Camera is ready. We start here.',
      actorId: 'speaker',
      start: 0,
    });
    project = speech.project;
    expect(speech.speech.duration).toBeGreaterThan(1);
    const wav = await (await request.get(speech.speech.url)).body();
    await writeFile(`${directory}/dialogue.wav`, wav);
    const analysis = await call<FaceAnalysisResult>('actor_face_lipsync_analyze', {
      projectId: project.id,
      expectedRevision: project.revision,
      objectId: 'speaker',
      audioId: speech.speech.audioId,
      recognizer: 'phonetic',
      linkTiming: true,
    });
    expect(analysis.engine).toBe('Rhubarb Lip Sync');
    expect(analysis.clip.cues.length).toBeGreaterThan(3);
    expect(analysis.clip.cues.some((cue) => !['A', 'X'].includes(cue.viseme))).toBe(true);
    await edit(analysis.commands);
    const duration = Math.ceil(speech.speech.duration + 0.5);
    await edit([
      { type: 'shot.update', payload: { id: 'shot', patch: { sourceOut: duration } } },
      {
        type: 'sequence.update',
        payload: {
          id: project.activeSequenceId,
          patch: {
            clips: [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: duration }],
          },
        },
      },
    ]);
    project = (
      await call<CommandResponse>('simulation_bake', {
        ...guard(),
        options: { ids: ['falling'], duration: 0.5, fps: 24, stepRate: 120 },
      })
    ).project;
    const falling = project.objects.find((object) => object.id === 'falling')!;
    expect(falling.keyframes.length).toBeGreaterThan(10);
    expect(falling.keyframes.at(-1)!.position![1]).toBeLessThan(2.5);
    await edit([{ type: 'production.initialize', payload: {} }]);
    const scene = project.production!.scenes[0];
    await edit([
      {
        type: 'performance.duplicate',
        payload: {
          sceneId: scene.id,
          id: scene.performances[0].id,
          newId: 'alternate',
          name: 'Alternate',
          select: false,
        },
      },
    ]);
    const production = await call('production_inspect', {
      sceneId: scene.id,
      leftPerformanceId: scene.performances[0].id,
      rightPerformanceId: 'alternate',
    });
    expect(production.scenes[0].performances).toHaveLength(2);
    expect(production.comparison).toBeTruthy();
    const inspected = await call('scene_inspect', {
      time: 0.5,
      sequenceId: project.activeSequenceId,
      sourceTime: 0.5,
    });
    expect(
      inspected.objects.find((object: { id: string }) => object.id === 'falling').position[1],
    ).toBeLessThan(2.5);
    const continuity = await call('continuity_analyze', {
      projectId: project.id,
      expectedRevision: project.revision,
      sequenceId: project.activeSequenceId,
    });
    expect(continuity.projectId).toBe(project.id);
    const script = await call('script_parse', {
      format: 'fountain',
      source:
        'Title: MCP service scene\n\nINT. STUDIO - DAY\n\nThe actor enters.\n\n@SPEAKER\nCamera is ready.\n',
    });
    expect(script.scenes).toHaveLength(1);
    expect(script.characters).toContain('SPEAKER');
    const saved = await call<TemplateSummary>('template_save', {
      ...guard(),
      kind: 'scene',
      name: 'Reusable service scene',
      description: 'MCP acceptance',
    });
    expect((await call<TemplateSummary[]>('template_list')).some((item) => item.id === saved.id)).toBe(true);
    const template = await call<TemplateSummary & { content: TemplateContent }>('template_get', {
      id: saved.id,
    });
    expect(template.content.project.objects).toHaveLength(3);
    const renamed = await call<TemplateSummary>('template_update', {
      id: saved.id,
      expectedRevision: saved.revision,
      name: 'Renamed service scene',
      description: 'Updated by MCP',
    });
    expect(renamed.name).toBe('Renamed service scene');
    expect(renamed.revision).toBe(saved.revision + 1);
    expect(await call('template_delete', { id: saved.id })).toEqual({ id: saved.id, deleted: true });
    expect((await call<TemplateSummary[]>('template_list')).some((item) => item.id === saved.id)).toBe(false);
    const preview = await call('preview_capture', { shotId: 'shot', time: 0.5, width: 1280, height: 720 });
    const image = preview.content.find((part: { type: string }) => part.type === 'image');
    expect(image.mimeType).toBe('image/png');
    const png = Buffer.from(image.data, 'base64');
    await writeFile(`${directory}/preview.png`, png);
    const pixels = await page.evaluate(async (base64: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set<number>();
      for (let index = 0; index < rgba.length; index += 16)
        colors.add((rgba[index] << 16) | (rgba[index + 1] << 8) | rgba[index + 2]);
      bitmap.close();
      return { width: canvas.width, height: canvas.height, colors: colors.size };
    }, image.data);
    expect(pixels).toMatchObject({ width: 1280, height: 720 });
    expect(pixels.colors).toBeGreaterThan(100);
    let job = await call<RenderJob>('render_start', {
      ...guard(),
      shotId: 'shot',
      fps: 24,
      resolution: 720,
      aspect: '16:9',
      includeAudio: true,
      burnIn: false,
    });
    const canceled = await call<RenderJob>('render_start', {
      ...guard(),
      shotId: 'shot',
      fps: 24,
      resolution: 720,
      aspect: '16:9',
      includeAudio: false,
      burnIn: false,
    });
    expect((await call<RenderJob>('render_cancel', { id: canceled.id })).status).toBe('cancelled');
    await expect
      .poll(
        async () => {
          job = await call<RenderJob>('render_status', { id: job.id });
          if (job.status === 'failed') throw new Error(job.error);
          return job.status;
        },
        { timeout: 150000 },
      )
      .toBe('completed');
    const video = await (await request.get(job.url!)).body();
    const videoPath = `${directory}/service-export.mp4`;
    await writeFile(videoPath, video);
    const media = JSON.parse(
      (
        await exec('ffprobe', [
          '-v',
          'error',
          '-count_frames',
          '-show_entries',
          'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_read_frames',
          '-of',
          'json',
          videoPath,
        ])
      ).stdout,
    );
    expect(
      media.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video'),
    ).toMatchObject({
      codec_name: 'h264',
      width: 1280,
      height: 720,
      avg_frame_rate: '24/1',
      nb_read_frames: String(duration * 24),
    });
    expect(media.streams.some((stream: { codec_name: string }) => stream.codec_name === 'aac')).toBe(true);
    const volume = await exec('ffmpeg', [
      '-v',
      'info',
      '-i',
      videoPath,
      '-vn',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ]);
    const peakDb = Number(volume.stderr.match(/max_volume: ([\d.-]+) dB/)?.[1]);
    expect(Number.isFinite(peakDb)).toBe(true);
    expect(peakDb).toBeGreaterThan(-50);
    const comparison = await exec('ffmpeg', [
      '-v',
      'info',
      '-i',
      videoPath,
      '-i',
      `${directory}/preview.png`,
      '-filter_complex',
      '[0:v]select=eq(n\\,12),setpts=PTS-STARTPTS[a];[a][1:v]ssim',
      '-an',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ]);
    const previewVideoSsim = Number(comparison.stderr.match(/All:([\d.]+)/)?.[1]);
    expect(previewVideoSsim).toBeGreaterThan(0.995);
    const publication = await call<ReviewPublication>('review_publish', {
      jobId: job.id,
      title: 'MCP media review',
    });
    expect(publication.projectRevision).toBe(job.projectRevision);
    expect((await call<ReviewPublication[]>('review_list')).some((item) => item.id === publication.id)).toBe(
      true,
    );
    const ownerComment = await call<ReviewComment>('review_comment_add', {
      publicationId: publication.id,
      requestId: randomUUID(),
      time: 0.5,
      text: 'Move the cut to this frame.',
    });
    expect(
      await call('review_comment_update', {
        publicationId: publication.id,
        id: ownerComment.id,
        expectedVersion: ownerComment.version,
        status: 'resolved',
      }),
    ).toMatchObject({ id: ownerComment.id, status: 'resolved', version: ownerComment.version + 1 });
    expect(
      (await call<ReviewComment[]>('review_comments', { publicationId: publication.id })).map(
        (comment) => comment.id,
      ),
    ).toContain(ownerComment.id);
    for (const role of ['reviewer', 'viewer'] as const) {
      const invitation = await call<{ invite: ReviewInvite; token: string; mcpUrl: string }>(
        'review_invite',
        {
          publicationId: publication.id,
          name: `Catalog ${role}`,
          role,
        },
      );
      const reviewer = new Client({ name: `mcp-catalog-${role}`, version: '1.0' });
      const ownerDetails = await call('review_details', { publicationId: publication.id });
      expect(ownerDetails).toEqual(await (await request.get(`/api/reviews/${publication.id}`)).json());
      expect(ownerDetails.invites).toContainEqual(invitation.invite);
      expect(JSON.stringify(ownerDetails)).not.toContain(invitation.token);
      clients.push(reviewer);
      await connect(reviewer, invitation.mcpUrl, invitation.token);
      const tools = await reviewer.listTools();
      declared[role] = tools.tools.map((tool) => tool.name).sort();
      const review = await callWith(reviewer, role, 'review_get');
      expect(review.publication.id).toBe(publication.id);
      expect(review.principal.role).toBe(role);
      if (role === 'reviewer') {
        const comment = await callWith<ReviewComment>(reviewer, role, 'review_comment_add', {
          requestId: randomUUID(),
          time: 1,
          text: 'The camera move is clear.',
        });
        expect(comment.author.id).toBe(invitation.invite.id);
        expect(
          await callWith(reviewer, role, 'review_comment_update', {
            id: comment.id,
            expectedVersion: comment.version,
            text: 'The camera move and blocking are clear.',
          }),
        ).toMatchObject({ id: comment.id, version: comment.version + 1 });
      }
      expect([...success[role]].sort()).toEqual(declared[role]);
      expect(
        await call('review_revoke', { publicationId: publication.id, id: invitation.invite.id }),
      ).toEqual({ id: invitation.invite.id, revoked: true });
      await reviewer.close();
    }
    const packaged = await call<{ url: string }>('project_package_export', {
      projectId: project.id,
      includeHistory: true,
      includeVideos: true,
    });
    const archive = await (await request.get(packaged.url)).body();
    evidence.workspace = await exerciseWorkspaceCatalog(call, page, project);
    await writeFile(`${directory}/service-project.whiteframe`, archive);
    const restored = await call<{ project: Project; assets: number; videos: number }>(
      'project_package_import',
      {
        dataBase64: archive.toString('base64'),
      },
    );
    expect(restored.project.id).not.toBe(project.id);
    expect(restored.project.objects).toEqual(project.objects);
    expect(restored.project.audio).toEqual(project.audio);
    expect(restored.assets).toBe(2);
    expect(restored.videos).toBe(1);
    const restoredJobs = await call<RenderJob[]>('render_status');
    const restoredJob = restoredJobs.find(
      (item) => item.options.projectId === restored.project.id && item.status === 'completed',
    )!;
    expect(hash(await (await request.get(restoredJob.url!)).body())).toBe(hash(video));
    const imported = await call<Project>('project_import', { project: restored.project });
    expect(imported.id).not.toBe(restored.project.id);
    expect(imported.objects).toEqual(project.objects);
    expect(imported.production).toEqual(project.production);
    expect(await call<Project>('project_get')).toEqual(imported);
    expect(declared.owner.filter((name) => !success.owner.has(name))).toEqual([]);
    Object.assign(evidence, {
      model,
      morph,
      speech: speech.speech,
      speechSha256: hash(wav),
      analysis,
      fallingKeys: falling.keyframes,
      production,
      continuity,
      pixels,
      previewSha256: hash(png),
      media,
      peakDb,
      previewVideoSsim,
      job,
      canceledJobId: canceled.id,
      videoSha256: hash(video),
      packageSha256: hash(archive),
      restoredProjectId: restored.project.id,
      importedProjectId: imported.id,
    });
    passed = true;
  } finally {
    await writeFile(
      `${directory}/service-tool-coverage.json`,
      JSON.stringify(
        {
          passed,
          declared,
          successful: Object.fromEntries(
            Object.entries(success).map(([role, names]) => [role, [...names].sort()]),
          ),
          missing: Object.fromEntries(
            Object.entries(declared).map(([role, names]) => [
              role,
              names.filter((name) => !success[role as Role].has(name)),
            ]),
          ),
          journal,
          evidence,
        },
        null,
        2,
      ),
    );
    for (const connected of clients) await connected.close();
  }
});
