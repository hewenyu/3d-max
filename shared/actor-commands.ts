import { z } from 'zod';
import {
  actorAnimationSchema,
  actorClipSchema,
  actorConstraintSchema,
  actorJointKeySchema,
  type ActorAnimation,
  type ActorClip,
  type ActorConstraint,
  type ActorJointKey,
} from './actor-animation';
import { DomainError } from './domain-error';
import type { Command, Project } from './types';

const identifier = z.string().min(1).max(160);
const remove = z.object({ id: identifier, itemId: identifier }).strict();
const set = (name: string, schema: z.AnyZodObject) =>
  z.object({ id: identifier, [name]: schema.extend({ id: identifier.optional() }).strict() }).strict();

export const actorCommandDefinitions = [
  {
    type: 'actor.animation.set',
    description:
      'Replace the actor animation tracks with editable action clips, additive joint keys and world/object/bone IK constraints. Times are source seconds, rotations degrees, positions meters.',
    schema: z.object({ id: identifier, animation: actorAnimationSchema }).strict(),
  },
  {
    type: 'actor.clip.set',
    description:
      'Create or replace an actor action clip by clip ID. Supports overlapping blends, fades, source offset, signed playback speed, loop and mirror. Missing clip ID is generated.',
    schema: set('clip', actorClipSchema),
  },
  { type: 'actor.clip.delete', description: 'Delete one actor action clip by itemId.', schema: remove },
  {
    type: 'actor.constraint.set',
    description:
      'Create or replace a timed hand/foot IK contact with a world position or object/bone target and offset. Weight and fades blend the constraint. Missing constraint ID is generated.',
    schema: set('constraint', actorConstraintSchema),
  },
  { type: 'actor.constraint.delete', description: 'Delete one IK constraint by itemId.', schema: remove },
  {
    type: 'actor.joint-key.set',
    description:
      'Create or replace an additive skeletal joint key. One key per joint/source time; hipsOffset controls body translation. Missing key ID is generated.',
    schema: set('keyframe', actorJointKeySchema),
  },
  { type: 'actor.joint-key.delete', description: 'Delete one skeletal joint key by itemId.', schema: remove },
];

function upsert<T extends { id: string }>(items: T[], value: T): T {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) items.push(value);
  else items[index] = value;
  return value;
}

export function applyActorCommand(project: Project, command: Command): unknown {
  const p = command.payload;
  const object = project.objects.find((item) => item.id === p.id);
  if (!object) throw new DomainError(`Actor not found: ${String(p.id)}`, 'NOT_FOUND', 404);
  if (object.locked) throw new DomainError(`Actor is locked: ${object.id}`, 'LOCKED', 409);
  if (!object.actor || object.type !== 'actor') throw new DomainError('Animation requires a rigged actor');
  if (command.type === 'actor.animation.set') {
    object.actor.animation = p.animation as ActorAnimation;
    return object.actor.animation;
  }
  const animation = (object.actor.animation ??= { clips: [], constraints: [], jointKeys: [] });
  const makeItem = <T extends { id: string }>(key: string): T => {
    const value = p[key] as T;
    return { ...value, id: value.id ?? crypto.randomUUID() };
  };
  switch (command.type) {
    case 'actor.clip.set':
      return upsert(animation.clips, makeItem<ActorClip>('clip'));
    case 'actor.constraint.set':
      return upsert(animation.constraints, makeItem<ActorConstraint>('constraint'));
    case 'actor.joint-key.set': {
      const key = makeItem<ActorJointKey>('keyframe');
      const existing = animation.jointKeys.find((item) => item.joint === key.joint && item.time === key.time);
      if (existing && existing.id !== key.id)
        throw new DomainError(`A joint key already exists at ${key.time}: ${existing.id}`, 'CONFLICT', 409);
      upsert(animation.jointKeys, key);
      animation.jointKeys.sort((a, b) => a.time - b.time || a.joint.localeCompare(b.joint));
      return key;
    }
    default: {
      const list =
        command.type === 'actor.clip.delete'
          ? animation.clips
          : command.type === 'actor.constraint.delete'
            ? animation.constraints
            : command.type === 'actor.joint-key.delete'
              ? animation.jointKeys
              : null;
      if (!list) throw new DomainError(`Unknown actor command: ${command.type}`);
      const index = list.findIndex((item) => item.id === p.itemId);
      if (index < 0) throw new DomainError(`Animation item not found: ${String(p.itemId)}`, 'NOT_FOUND', 404);
      list.splice(index, 1);
      return { id: p.itemId, deleted: true };
    }
  }
}
