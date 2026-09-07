import { z } from 'zod';
import { DomainError } from './domain-error';
import type { Command, CommandResponse, Project } from './types';

const id = z.string().min(1).max(160);
export const speechEngineSchema = z.enum(['say', 'espeak-ng']);
export type SpeechEngine = z.infer<typeof speechEngineSchema>;
export const speechRequestSchema = z
  .object({
    engine: speechEngineSchema,
    voice: z.string().min(1).max(200),
    text: z
      .string()
      .trim()
      .min(1)
      .max(5000)
      .refine((text) => /[\p{L}\p{N}]/u.test(text), 'Dialogue must contain spoken words')
      .refine(
        (text) => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) && !text.includes('[['),
        'Use plain dialogue without speech control codes',
      ),
    rate: z.number().int().min(80).max(350).default(180),
    start: z.number().finite().min(0).max(86400).optional(),
    actorId: id.nullable().optional(),
    beatId: id.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    projectId: id,
    expectedRevision: z.number().int().min(0),
    expectedContext: z.object({ sceneId: id.nullable(), performanceId: id.nullable() }).strict().optional(),
    requestId: z.string().min(1).max(200),
  })
  .strict();
export type SpeechRequest = z.infer<typeof speechRequestSchema>;
export interface SpeechVoice {
  id: string;
  name: string;
  language: string;
}
export const speechCatalogSchema = z.object({
  available: z.boolean(),
  engines: z.array(
    z.object({
      id: speechEngineSchema,
      name: z.string(),
      available: z.boolean(),
      voices: z.array(z.object({ id: z.string().min(1), name: z.string(), language: z.string() })),
      diagnostic: z.string().optional(),
    }),
  ),
  encoding: z.object({ available: z.boolean(), diagnostic: z.string().optional() }),
  limits: z.object({
    textCharacters: z.number().positive(),
    durationSeconds: z.number().positive(),
    rate: z.object({
      min: z.number().positive(),
      max: z.number().positive(),
      default: z.number().positive(),
    }),
  }),
});
export type SpeechCatalog = z.infer<typeof speechCatalogSchema>;
export interface SpeechMedia {
  audioId: string;
  beatId: string;
  assetId: string;
  url: string;
  duration: number;
}
export interface SpeechResult extends CommandResponse {
  speech: SpeechMedia & { engine: SpeechEngine; voice: string; rate: number };
}

export function speechCommands(project: Project, request: SpeechRequest, media: SpeechMedia): Command[] {
  const beat = request.beatId ? project.beats.find((item) => item.id === request.beatId) : undefined;
  if (request.beatId && (!beat || beat.kind !== 'dialogue'))
    throw new DomainError('Select an existing dialogue beat');
  const actorId = request.actorId === undefined ? (beat?.actorId ?? null) : request.actorId;
  if (actorId) {
    const actor = project.objects.find((item) => item.id === actorId);
    if (!actor || (!actor.actor && actor.type !== 'model'))
      throw new DomainError('Dialogue actor is unavailable');
  }
  const start = request.start ?? beat?.time ?? 0;
  const name = request.name ?? beat?.label ?? 'Temporary dialogue';
  const beatPatch = { text: request.text, actorId, time: start, endTime: start + media.duration };
  const commands: Command[] = [
    beat
      ? { type: 'beat.update', payload: { id: beat.id, patch: beatPatch } }
      : { type: 'beat.create', payload: { ...beatPatch, id: media.beatId, label: name, kind: 'dialogue' } },
    {
      type: 'audio.create',
      payload: {
        id: media.audioId,
        name,
        url: media.url,
        start,
        sourceIn: 0,
        duration: media.duration,
        sync: 'source',
        volume: 1,
        muted: false,
        locked: false,
      },
    },
  ];
  const group = project.synchronization?.find((item) =>
    item.members.some((member) => member.kind === 'beat' && member.id === media.beatId),
  );
  commands.push({
    type: 'sync.group.set',
    payload: {
      group: group
        ? {
            ...structuredClone(group),
            members: [...group.members, { kind: 'audio', id: media.audioId, anchor: 'start' }],
          }
        : {
            id: `sync-${media.audioId}`,
            name,
            locked: false,
            members: [
              { kind: 'beat', id: media.beatId, anchor: 'start' },
              { kind: 'audio', id: media.audioId, anchor: 'start' },
            ],
          },
    },
  });
  return commands;
}
