import { z } from 'zod';
import { faceClipSchema, visemeSchema, type FaceClip } from './face-animation';
import type { Command, Project } from './types';

const id = z.string().min(1).max(160);
export const faceAnalysisRequestSchema = z
  .object({
    objectId: id,
    audioId: id,
    recognizer: z.enum(['phonetic', 'pocketsphinx']).default('phonetic'),
    dialogue: z.string().max(20000).optional(),
    linkTiming: z.boolean().default(true),
    projectId: id.optional(),
    expectedRevision: z.number().int().min(0).optional(),
    expectedContext: z.object({ sceneId: id.nullable(), performanceId: id.nullable() }).strict().optional(),
  })
  .strict();
export const morphCatalogRequestSchema = z.object({ objectId: id, projectId: id.optional() }).strict();
export interface FaceAnalysisResult {
  projectId: string;
  revision: number;
  context: { sceneId: string | null; performanceId: string | null };
  engine: 'Rhubarb Lip Sync';
  version: string;
  recognizer: 'phonetic' | 'pocketsphinx';
  clip: FaceClip;
  commands: Command[];
  compatibility: string[];
}
export interface MorphCatalog {
  objectId: string;
  meshes: { mesh: string; name: string; targets: string[] }[];
  missingBindings: { channel: string; target: string; mesh?: string }[];
}
const rhubarbOutput = z
  .object({
    metadata: z.object({ duration: z.number().finite().positive() }).passthrough(),
    mouthCues: z
      .array(
        z
          .object({
            start: z.number().finite().min(0),
            end: z.number().finite().positive(),
            value: visemeSchema,
          })
          .strict(),
      )
      .max(20000),
  })
  .passthrough();

export function rhubarbClip(
  input: unknown,
  audio: Project['audio'][number],
  recognizer: 'phonetic' | 'pocketsphinx',
): FaceClip {
  const result = rhubarbOutput.parse(input);
  const duration = Math.min(audio.duration, result.metadata.duration);
  const cues = result.mouthCues.flatMap((cue, index) =>
    cue.start < duration
      ? [
          {
            id: `cue-${index}`,
            start: cue.start,
            end: Math.min(cue.end, duration),
            viseme: cue.value,
          },
        ]
      : [],
  );
  return faceClipSchema.parse({
    id: `face-${crypto.randomUUID()}`,
    name: `${audio.name} / 口型`,
    start: audio.start,
    end: audio.start + duration,
    audioId: audio.id,
    audioSourceIn: audio.sourceIn,
    recognizer: `rhubarb-${recognizer}`,
    cues,
  });
}

export function faceAnalysisCommands(
  project: Project,
  objectId: string,
  clip: FaceClip,
  link: boolean,
): Command[] {
  const commands: Command[] = [{ type: 'actor.face.clip.set', payload: { id: objectId, clip } }];
  if (link && clip.audioId) {
    const existing = project.synchronization?.find((group) =>
      group.members.some((member) => member.kind === 'audio' && member.id === clip.audioId),
    );
    const member = { kind: 'actor-face-clip', objectId, id: clip.id, anchor: 'start' };
    commands.push({
      type: 'sync.group.set',
      payload: {
        group: existing
          ? {
              ...structuredClone(existing),
              members: [...existing.members, member],
            }
          : {
              id: `sync-${clip.id}`,
              name: clip.name,
              locked: false,
              members: [{ kind: 'audio', id: clip.audioId, anchor: 'start' }, member],
            },
      },
    });
  }
  return commands;
}
