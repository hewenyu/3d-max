import { z } from 'zod';
import { DomainError } from './domain-error';
import {
  faceAnimationSchema,
  faceClipSchema,
  faceKeySchema,
  morphBindingSchema,
  objectFace,
  visemeCueSchema,
  type FaceAnimation,
  type FaceClip,
  type FaceKey,
  type MorphBinding,
  type VisemeCue,
} from './face-animation';
import type { Command, Project } from './types';
const id = z.string().min(1).max(160);
const remove = z.object({ id, itemId: id }).strict();
export const faceCommandDefinitions = [
  {
    type: 'actor.face.set',
    description:
      'Set editable face animation on a built-in actor or imported morph model. Expression channels are normalized 0..1, gaze is -1..1, key times are source seconds. Disabled faces preserve legacy appearance.',
    schema: z.object({ id, face: faceAnimationSchema }).strict(),
  },
  {
    type: 'actor.face.key.set',
    description:
      'Create or replace an expression, blink, gaze or jaw key. Sparse channels interpolate independently; key times are source seconds.',
    schema: z.object({ id, keyframe: faceKeySchema.extend({ id: id.optional() }) }).strict(),
  },
  { type: 'actor.face.key.delete', description: 'Delete an editable face key.', schema: remove },
  {
    type: 'actor.face.clip.set',
    description:
      'Create or replace a lip-sync clip. Cue times are relative to clip start, non-overlapping A..H/X Rhubarb mouth shapes. audioId must reference source-time audio. Use synchronization groups to link timing.',
    schema: z.object({ id, clip: faceClipSchema.extend({ id: id.optional() }) }).strict(),
  },
  {
    type: 'actor.face.clip.delete',
    description: 'Delete a lip-sync clip after unlinking any synchronization references.',
    schema: remove,
  },
  {
    type: 'actor.face.cue.set',
    description: 'Create or replace one editable relative-time lip-sync mouth cue in a clip.',
    schema: z.object({ id, clipId: id, cue: visemeCueSchema.extend({ id: id.optional() }) }).strict(),
  },
  {
    type: 'actor.face.cue.delete',
    description: 'Delete one mouth cue from a lip-sync clip.',
    schema: remove.extend({ clipId: id }).strict(),
  },
  {
    type: 'model.morph.bindings.set',
    description:
      'Map normalized face channels or viseme:A..H/X to named glTF morph targets. Optional mesh uses the stable mesh:N/primitive:N key from model_morph_catalog and affects all instances of that source primitive; omission affects every matching target. Mapped weights override embedded animation and clamp to 0..1.',
    schema: z.object({ id, bindings: z.array(morphBindingSchema).max(256) }).strict(),
  },
];
function upsert<T extends { id: string }>(items: T[], input: T): T {
  const value = { ...input, id: input.id ?? crypto.randomUUID() };
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) items.push(value);
  else items[index] = value;
  return value;
}
export function applyFaceCommand(project: Project, command: Command): unknown {
  const p = command.payload;
  const object = project.objects.find((item) => item.id === p.id);
  if (!object) throw new DomainError(`Face object not found: ${String(p.id)}`, 'NOT_FOUND', 404);
  if (object.locked) throw new DomainError(`Face object is locked: ${object.id}`, 'LOCKED', 409);
  if (!object.actor && object.type !== 'model')
    throw new DomainError('Faces require a built-in actor or imported model');
  const setFace = (face: FaceAnimation) => {
    if (object.actor) object.actor.face = face;
    else object.morph = { bindings: object.morph?.bindings ?? [], face };
    return face;
  };
  if (command.type === 'actor.face.set') return setFace(p.face as FaceAnimation);
  const face = objectFace(object) ?? setFace(faceAnimationSchema.parse({}));
  if (command.type === 'model.morph.bindings.set') {
    if (object.type !== 'model') throw new DomainError('Morph bindings require an imported model');
    object.morph = { face, bindings: p.bindings as MorphBinding[] };
    return object.morph;
  }
  if (command.type === 'actor.face.key.set') {
    const key = upsert(face.keys, p.keyframe as FaceKey);
    face.keys.sort((a, b) => a.time - b.time);
    return key;
  }
  if (command.type === 'actor.face.clip.set') return upsert(face.clips, p.clip as FaceClip);
  const clip = face.clips.find((item) => item.id === p.clipId);
  if (command.type.startsWith('actor.face.cue.') && !clip)
    throw new DomainError(`Face clip not found: ${String(p.clipId)}`, 'NOT_FOUND', 404);
  if (command.type === 'actor.face.cue.set') {
    const cue = upsert(clip!.cues, p.cue as VisemeCue);
    clip!.cues.sort((a, b) => a.start - b.start);
    return cue;
  }
  const items =
    command.type === 'actor.face.key.delete'
      ? face.keys
      : command.type === 'actor.face.clip.delete'
        ? face.clips
        : clip!.cues;
  const index = items.findIndex((item) => item.id === p.itemId);
  if (index < 0) throw new DomainError(`Face item not found: ${String(p.itemId)}`, 'NOT_FOUND', 404);
  items.splice(index, 1);
  return { id: p.itemId, deleted: true };
}
