import { z } from 'zod';
import { DomainError } from './domain-error';
import type { Project, SceneObject } from './types';

const identifier = z.string().min(1).max(160);
const unit = z.number().finite().min(0).max(1);
const time = z.number().finite().min(0).max(86400);
export const faceValuesSchema = z
  .object({
    jawOpen: unit,
    smile: unit,
    frown: unit,
    pucker: unit,
    mouthWide: unit,
    upperLipRaise: unit,
    lowerLipDown: unit,
    blinkLeft: unit,
    blinkRight: unit,
    browInnerUp: unit,
    browDown: unit,
    browOuterUp: unit,
    eyeWide: unit,
    gazeX: z.number().finite().min(-1).max(1),
    gazeY: z.number().finite().min(-1).max(1),
  })
  .strict();
export type FaceValues = z.infer<typeof faceValuesSchema>;
export type FaceChannel = keyof FaceValues;
export const faceChannels = Object.keys(faceValuesSchema.shape) as FaceChannel[];
export const neutralFace = Object.fromEntries(faceChannels.map((channel) => [channel, 0])) as FaceValues;
export const facePresets: Record<string, { name: string; values: Partial<FaceValues> }> = {
  neutral: { name: '中性', values: {} },
  happy: { name: '喜悦', values: { smile: 0.85, browOuterUp: 0.3 } },
  sad: { name: '悲伤', values: { frown: 0.75, browInnerUp: 0.75, gazeY: -0.25 } },
  angry: { name: '愤怒', values: { browDown: 0.9, upperLipRaise: 0.4, frown: 0.45 } },
  surprise: { name: '惊讶', values: { jawOpen: 0.7, eyeWide: 1, browOuterUp: 0.85 } },
  concern: { name: '担忧', values: { browInnerUp: 0.7, browDown: 0.25, frown: 0.2 } },
};
export const visemeSchema = z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X']);
export type Viseme = z.infer<typeof visemeSchema>;
export const visemeValues: Record<Viseme, Partial<FaceValues>> = {
  A: { jawOpen: 0, pucker: 0.08 },
  B: { jawOpen: 0.12, mouthWide: 0.35 },
  C: { jawOpen: 0.42, mouthWide: 0.6 },
  D: { jawOpen: 0.9, mouthWide: 0.25 },
  E: { jawOpen: 0.48, pucker: 0.65 },
  F: { jawOpen: 0.18, pucker: 1 },
  G: { jawOpen: 0.12, upperLipRaise: 0.55, lowerLipDown: 0.1 },
  H: { jawOpen: 0.25, lowerLipDown: 0.4 },
  X: { jawOpen: 0 },
};
export const faceKeySchema = z
  .object({
    id: identifier,
    time,
    values: faceValuesSchema.partial(),
    easing: z.enum(['linear', 'smooth', 'step']).default('smooth'),
  })
  .strict();
export const visemeCueSchema = z
  .object({ id: identifier, start: time, end: time, viseme: visemeSchema })
  .strict();
export const faceClipSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(200),
    start: time,
    end: time,
    audioId: identifier.nullable().default(null),
    audioSourceIn: time.default(0),
    recognizer: z.enum(['manual', 'rhubarb-phonetic', 'rhubarb-pocketsphinx', 'import']).default('manual'),
    weight: unit.default(1),
    fadeIn: time.default(0.04),
    fadeOut: time.default(0.04),
    transition: z.number().finite().min(0).max(0.2).default(0.04),
    cues: z.array(visemeCueSchema).max(20000).default([]),
  })
  .strict();
export const faceAnimationSchema = z
  .object({
    enabled: z.boolean().default(true),
    base: faceValuesSchema.partial().default({}),
    keys: z.array(faceKeySchema).max(20000).default([]),
    clips: z.array(faceClipSchema).max(1000).default([]),
  })
  .strict();
export type FaceKey = z.infer<typeof faceKeySchema>;
export type FaceClip = z.infer<typeof faceClipSchema>;
export type VisemeCue = z.infer<typeof visemeCueSchema>;
export type FaceAnimation = z.infer<typeof faceAnimationSchema>;
export const morphChannelSchema = z.union([
  faceValuesSchema.keyof(),
  z.enum([
    'viseme:A',
    'viseme:B',
    'viseme:C',
    'viseme:D',
    'viseme:E',
    'viseme:F',
    'viseme:G',
    'viseme:H',
    'viseme:X',
  ]),
]);
export const morphBindingSchema = z
  .object({
    channel: morphChannelSchema,
    target: z.string().min(1).max(200),
    mesh: z.string().min(1).max(200).optional(),
    scale: z.number().finite().min(-2).max(2).default(1),
    offset: z.number().finite().min(-1).max(1).default(0),
  })
  .strict();
export const modelMorphSchema = z
  .object({ face: faceAnimationSchema, bindings: z.array(morphBindingSchema).max(256).default([]) })
  .strict();
export type MorphBinding = z.infer<typeof morphBindingSchema>;
export type ModelMorph = z.infer<typeof modelMorphSchema>;
export interface FaceSample {
  values: FaceValues;
  visemes: Record<Viseme, number>;
}
export function objectFace(object: SceneObject): FaceAnimation | undefined {
  return object.actor?.face ?? object.morph?.face;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => value * value * (3 - 2 * value);

export function sampleFace(face: FaceAnimation | undefined, sourceTime: number): FaceSample {
  const values = { ...neutralFace, ...(face?.enabled ? face.base : {}) };
  const visemes = Object.fromEntries(visemeSchema.options.map((shape) => [shape, 0])) as Record<
    Viseme,
    number
  >;
  if (!face?.enabled) return { values, visemes };
  for (const channel of faceChannels) {
    const keys = face.keys.filter((key) => key.values[channel] !== undefined).sort((a, b) => a.time - b.time);
    const next = keys.findIndex((key) => key.time > sourceTime);
    const left = next < 0 ? keys.at(-1) : keys[next - 1];
    const right = next < 0 ? undefined : keys[next];
    if (!left) continue;
    let blend = right ? clamp((sourceTime - left.time) / (right.time - left.time)) : 0;
    if (left.easing === 'step') blend = 0;
    if (left.easing === 'smooth') blend = smooth(blend);
    values[channel] = left.values[channel]! * (1 - blend) + (right?.values[channel] ?? 0) * blend;
  }
  let total = 0;
  const mouth: Partial<FaceValues> = {};
  for (const clip of face.clips) {
    if (sourceTime < clip.start || sourceTime >= clip.end) continue;
    const weight =
      clip.weight *
      Math.min(
        clip.fadeIn ? clamp((sourceTime - clip.start) / clip.fadeIn) : 1,
        clip.fadeOut ? clamp((clip.end - sourceTime) / clip.fadeOut) : 1,
      );
    const local = sourceTime - clip.start;
    const index = clip.cues.findIndex((cue) => local >= cue.start && local < cue.end);
    const cue = clip.cues[index];
    const previous = clip.cues[index - 1];
    const previousShape =
      previous && Math.abs(previous.end - (cue?.start ?? 0)) < 0.0001 ? previous.viseme : 'X';
    const blend =
      cue && clip.transition
        ? smooth(clamp((local - cue.start) / Math.min(clip.transition, cue.end - cue.start)))
        : 1;
    const weights: readonly (readonly [Viseme, number])[] = cue
      ? [
          [previousShape, 1 - blend],
          [cue.viseme, blend],
        ]
      : [['X', 1]];
    for (const [shape, amount] of weights) {
      visemes[shape] += weight * amount;
      for (const channel of ['jawOpen', 'pucker', 'mouthWide', 'upperLipRaise', 'lowerLipDown'] as const)
        mouth[channel] = (mouth[channel] ?? 0) + (visemeValues[shape][channel] ?? 0) * weight * amount;
    }
    total += weight;
  }
  for (const channel of Object.keys(mouth) as FaceChannel[])
    values[channel] = values[channel] * (1 - Math.min(1, total)) + mouth[channel]! / Math.max(1, total);
  for (const shape of visemeSchema.options) visemes[shape] /= Math.max(1, total);
  return { values, visemes };
}

export function validateFace(object: SceneObject, project: Pick<Project, 'audio'>): void {
  if (object.morph && object.type !== 'model')
    throw new DomainError('Morph bindings require an imported model');
  const face = objectFace(object);
  if (!face) return;
  const unique = (items: { id: string }[], name: string) => {
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new DomainError(`Duplicate ${name} ID`);
  };
  unique(face.keys, 'face key');
  unique(face.clips, 'face clip');
  const channelTimes = new Set<string>();
  for (const key of face.keys)
    for (const channel of Object.keys(key.values)) {
      const signature = `${key.time}/${channel}`;
      if (channelTimes.has(signature)) throw new DomainError(`Duplicate face channel key at ${signature}`);
      channelTimes.add(signature);
    }
  for (const clip of face.clips) {
    if (clip.end <= clip.start) throw new DomainError(`Face clip end must follow start: ${clip.id}`);
    unique(clip.cues, 'viseme cue');
    let end = 0;
    for (const cue of clip.cues) {
      if (cue.end <= cue.start || cue.start < end || cue.end > clip.end - clip.start + 0.000001)
        throw new DomainError(
          `Viseme cues must be ordered, non-overlapping and inside their clip: ${cue.id}`,
        );
      end = cue.end;
    }
    if (clip.audioId) {
      const audio = project.audio.find((item) => item.id === clip.audioId);
      if (!audio) throw new DomainError(`Missing lip-sync audio: ${clip.audioId}`);
      if (audio.sync !== 'source') throw new DomainError('Lip-sync requires source-time audio');
    }
  }
}
