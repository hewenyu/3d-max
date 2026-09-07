import { createHash, randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyCommands } from '../shared/commands';
import {
  speechCommands,
  speechRequestSchema,
  type SpeechMedia,
  type SpeechRequest,
  type SpeechResult,
} from '../shared/speech';
import type { CommandResponse, Project } from '../shared/types';
import type { ServerConfig } from './config';
import { ApiError } from './errors';
import { createSpeechRuntime, type SpeechRuntime } from './speech-runtime';
import type { AssetRecord, Store } from './store';

const pending = new WeakMap<Store, Map<string, { fingerprint: string; result: Promise<SpeechResult> }>>();
function guardProject(project: Project, request: SpeechRequest) {
  if (request.projectId !== project.id)
    throw new ApiError('PROJECT_CONFLICT', 'Active project changed before speech synthesis', 409);
  if (request.expectedRevision !== project.revision)
    throw new ApiError('REVISION_CONFLICT', 'Project changed before speech synthesis', 409);
  const context = {
    sceneId: project.production?.activeSceneId ?? null,
    performanceId: project.production?.activePerformanceId ?? null,
  };
  if (
    request.expectedContext &&
    (request.expectedContext.sceneId !== context.sceneId ||
      request.expectedContext.performanceId !== context.performanceId)
  )
    throw new ApiError('CONTEXT_CONFLICT', 'Scene or performance changed before speech synthesis', 409);
  return context;
}
function responseWithSpeech(
  response: CommandResponse,
  request: SpeechRequest,
  media: SpeechMedia,
): SpeechResult {
  const audio = response.project.audio.find((item) => item.id === media.audioId)!;
  return {
    ...response,
    speech: {
      ...media,
      url: audio.url,
      duration: audio.duration,
      engine: request.engine,
      voice: request.voice,
      rate: request.rate,
    },
  };
}

export async function synthesizeSpeech(
  store: Store,
  config: Pick<ServerConfig, 'dataDir'>,
  input: unknown,
  runtime: SpeechRuntime = createSpeechRuntime(),
): Promise<SpeechResult> {
  const request = speechRequestSchema.parse(input);
  const project = store.project();
  if (request.projectId !== project.id)
    throw new ApiError('PROJECT_CONFLICT', 'Active project changed before speech synthesis', 409);
  const { projectId: _projectId, expectedRevision: _revision, requestId: _requestId, ...options } = request;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ operation: 'speech.synthesize', ...options }))
    .digest('hex');
  const seed = createHash('sha256').update(`${project.id}\0${request.requestId}`).digest('hex').slice(0, 32);
  const media: SpeechMedia = {
    audioId: `speech-audio-${seed}`,
    beatId: request.beatId ?? `speech-beat-${seed}`,
    assetId: '',
    url: '',
    duration: 1,
  };
  const replay = store.cachedCommands(project.id, request.requestId, fingerprint);
  if (replay) {
    const audio = replay.project.audio.find((item) => item.id === media.audioId)!;
    const asset = store.assetByUrl(audio.url);
    if (!asset)
      throw new ApiError('TTS_ASSET_MISSING', 'Previously generated speech asset is unavailable', 409);
    return responseWithSpeech(replay, request, { ...media, assetId: asset.id });
  }
  const key = `${project.id}\0${request.requestId}`;
  let operations = pending.get(store);
  if (!operations) {
    operations = new Map();
    pending.set(store, operations);
  }
  const active = operations.get(key);
  if (active) {
    if (active.fingerprint !== fingerprint)
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'This requestId is already generating different dialogue',
        409,
      );
    return { ...(await active.result), replayed: true };
  }
  const context = guardProject(project, request);
  media.assetId = randomUUID();
  media.url = `/api/assets/${media.assetId}/file`;
  applyCommands(project, speechCommands(project, request, media));
  const generate = async () => {
    const generated = await runtime.synthesize(request);
    media.duration = generated.duration;
    const commands = speechCommands(project, request, media);
    applyCommands(project, commands);
    const path = resolve(config.dataDir, 'assets', `${media.assetId}.wav`);
    const asset: AssetRecord = {
      id: media.assetId,
      path,
      name: `${request.name ?? 'Temporary dialogue'}.wav`,
      url: media.url,
      mime: 'audio/wav',
      size: generated.bytes.length,
      duration: generated.duration,
    };
    let committed = false;
    let ownsFile = false;
    try {
      const file = await open(path, 'wx');
      ownsFile = true;
      try {
        await file.writeFile(generated.bytes);
      } finally {
        await file.close();
      }
      const result = store.commands(
        {
          commands,
          projectId: project.id,
          expectedRevision: project.revision,
          expectedContext: context,
          requestId: request.requestId,
        },
        fingerprint,
        [asset],
      );
      committed = !result.replayed;
      if (result.replayed) {
        const audio = result.project.audio.find((item) => item.id === media.audioId)!;
        return responseWithSpeech(result, request, { ...media, assetId: store.assetByUrl(audio.url)!.id });
      }
      return responseWithSpeech(result, request, media);
    } finally {
      if (ownsFile && !committed) await rm(path, { force: true });
    }
  };
  const result = generate();
  operations.set(key, { fingerprint, result });
  try {
    return await result;
  } finally {
    operations.delete(key);
  }
}
