import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { faceChannels, facePresets, visemeSchema } from '../shared/face-animation';
import {
  faceAnalysisCommands,
  faceAnalysisRequestSchema,
  morphCatalogRequestSchema,
  rhubarbClip,
  type FaceAnalysisResult,
  type MorphCatalog,
} from '../shared/face-analysis';
import { applyCommands } from '../shared/commands';
import { ApiError } from './errors';
import type { Store } from './store';

const exec = promisify(execFile);
const compatibility = [
  'Rhubarb phonetic uses a language-independent phonetic recognizer; Chinese and other non-English dialogue need manual cue review.',
  'PocketSphinx mode is English-only. Optional dialogue text improves English recognition and is not translation.',
  'Source-time audio only, maximum 300 seconds per analysis. Trimmed audio is decoded to mono 16 kHz PCM. No amplitude-based phoneme inference.',
  'A..H/X cues are editable and clip-relative. Retiming samples the same source clock; independent sequence music does not drive face animation.',
];

function rhubarbPath(): string {
  const candidates = [
    process.env.WHITEFRAME_RHUBARB_PATH,
    resolve('.data/tools/rhubarb-native/rhubarb'),
    resolve('.data/tools/rhubarb-native/build/rhubarb/rhubarb'),
    resolve('.data/tools/rhubarb/Rhubarb-Lip-Sync-1.14.0-macOS/rhubarb'),
    resolve('.data/tools/rhubarb/Rhubarb-Lip-Sync-1.14.0-Linux/rhubarb'),
  ];
  return (
    candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ??
    'rhubarb'
  );
}

export async function faceCatalog() {
  let available = false;
  let version = '';
  try {
    const result = await exec(rhubarbPath(), ['--version'], { timeout: 5000 });
    version = result.stdout.trim() || result.stderr.trim();
    available = true;
  } catch {
    /* Face editing and imported cues remain available without a local recognizer. */
  }
  return {
    channels: faceChannels,
    presets: facePresets,
    visemes: visemeSchema.options,
    lipsync: {
      available,
      version,
      recognizers: ['phonetic', 'pocketsphinx'],
      compatibility,
      configuration:
        'WHITEFRAME_RHUBARB_PATH points to the Rhubarb executable; its res directory must remain beside it.',
    },
  };
}

export async function analyzeFaceAudio(store: Store, input: unknown): Promise<FaceAnalysisResult> {
  const request = faceAnalysisRequestSchema.parse(input);
  const project = store.project();
  if (request.projectId && request.projectId !== project.id)
    throw new ApiError('PROJECT_CONFLICT', 'Active project changed before lip-sync analysis', 409);
  if (request.expectedRevision !== undefined && request.expectedRevision !== project.revision)
    throw new ApiError('REVISION_CONFLICT', 'Project changed before lip-sync analysis', 409);
  const context = {
    sceneId: project.production?.activeSceneId ?? null,
    performanceId: project.production?.activePerformanceId ?? null,
  };
  if (
    request.expectedContext &&
    (request.expectedContext.sceneId !== context.sceneId ||
      request.expectedContext.performanceId !== context.performanceId)
  )
    throw new ApiError('CONTEXT_CONFLICT', 'Scene or performance changed before lip-sync analysis', 409);
  const object = project.objects.find((item) => item.id === request.objectId);
  if (!object || (!object.actor && object.type !== 'model'))
    throw new ApiError('INVALID_ACTOR', 'Lip-sync requires an actor or imported morph model');
  if (object.locked) throw new ApiError('LOCKED', 'Face object is locked', 409);
  const audio = project.audio.find((item) => item.id === request.audioId);
  if (!audio || audio.sync !== 'source')
    throw new ApiError('INVALID_AUDIO', 'Lip-sync requires source-time audio');
  if (audio.duration > 300)
    throw new ApiError('AUDIO_TOO_LONG', 'Trim reference dialogue to 300 seconds or less before analysis');
  if (request.dialogue && request.recognizer !== 'pocketsphinx')
    throw new ApiError(
      'INVALID_RECOGNIZER',
      'Dialogue text is supported only by the English PocketSphinx recognizer',
    );
  const asset = store.assetByUrl(audio.url);
  if (!asset || !asset.mime.startsWith('audio/'))
    throw new ApiError('INVALID_AUDIO', 'Reference audio asset is unavailable');
  const catalog = await faceCatalog();
  if (!catalog.lipsync.available)
    throw new ApiError(
      'RHUBARB_UNAVAILABLE',
      'Rhubarb executable is unavailable or incompatible. Configure WHITEFRAME_RHUBARB_PATH; editable imported cues are supported.',
      503,
    );
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-lipsync-'));
  try {
    const wav = join(directory, 'dialogue.wav');
    const output = join(directory, 'cues.json');
    await exec(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(audio.sourceIn),
        '-i',
        asset.path,
        '-vn',
        '-af',
        'apad',
        '-t',
        String(audio.duration),
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        wav,
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    const args = ['-r', request.recognizer, '-f', 'json', '--extendedShapes', 'GHX', '-o', output, wav];
    if (request.dialogue) {
      const dialogue = join(directory, 'dialogue.txt');
      await writeFile(dialogue, request.dialogue, 'utf8');
      args.push('-d', dialogue);
    }
    await exec(rhubarbPath(), args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    const clip = rhubarbClip(JSON.parse(await readFile(output, 'utf8')), audio, request.recognizer);
    const commands = faceAnalysisCommands(project, object.id, clip, request.linkTiming);
    applyCommands(project, commands);
    return {
      projectId: project.id,
      revision: project.revision,
      context,
      engine: 'Rhubarb Lip Sync',
      version: catalog.lipsync.version,
      recognizer: request.recognizer,
      clip,
      commands,
      compatibility,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('LIPSYNC_FAILED', `Lip-sync analysis failed: ${(error as Error).message}`, 422);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface GltfDocument {
  meshes?: { name?: string; extras?: { targetNames?: string[] }; primitives?: { targets?: unknown[] }[] }[];
}
export async function morphCatalog(store: Store, input: unknown): Promise<MorphCatalog> {
  const request = morphCatalogRequestSchema.parse(input);
  const project = store.project();
  if (request.projectId && request.projectId !== project.id)
    throw new ApiError('PROJECT_CONFLICT', 'Active project changed', 409);
  const object = project.objects.find((item) => item.id === request.objectId);
  const asset = object?.assetUrl ? store.assetByUrl(object.assetUrl) : undefined;
  if (object?.type !== 'model' || !asset)
    throw new ApiError('INVALID_MODEL', 'Select an imported glTF model');
  const bytes = await readFile(asset.path);
  const document: GltfDocument = JSON.parse(
    bytes.toString(
      'utf8',
      bytes.toString('ascii', 0, 4) === 'glTF' ? 20 : 0,
      bytes.toString('ascii', 0, 4) === 'glTF' ? 20 + bytes.readUInt32LE(12) : bytes.length,
    ),
  );
  const meshes: MorphCatalog['meshes'] = [];
  for (const [index, mesh] of (document.meshes ?? []).entries()) {
    for (const [primitiveIndex, primitive] of (mesh.primitives ?? []).entries()) {
      const count = primitive.targets?.length ?? 0;
      if (!count) continue;
      const names =
        mesh.extras?.targetNames?.length === count
          ? mesh.extras.targetNames
          : Array.from({ length: count }, (_, i) => String(i));
      meshes.push({
        mesh: `mesh:${index}/primitive:${primitiveIndex}`,
        name: `${mesh.name ?? `Mesh ${index}`} / ${primitiveIndex}`,
        targets: names,
      });
    }
  }
  const missingBindings = (object.morph?.bindings ?? []).filter(
    (binding) =>
      !meshes.some(
        (mesh) => (!binding.mesh || binding.mesh === mesh.mesh) && mesh.targets.includes(binding.target),
      ),
  );
  return { objectId: object.id, meshes, missingBindings };
}
