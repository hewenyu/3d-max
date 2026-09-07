import { z } from 'zod';
import { DomainError } from './domain-error';
import type { Project } from './types';
import { objectFace } from './face-animation';

const id = z.string().min(1).max(160);
const anchor = z.enum(['start', 'end']).default('start');
const objectMember = { objectId: id, id, anchor };
export const timingReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('beat'), id, anchor }).strict(),
  z.object({ kind: z.literal('audio'), id, anchor }).strict(),
  z.object({ kind: z.literal('keyframe'), ...objectMember }).strict(),
  z.object({ kind: z.literal('actor-clip'), ...objectMember }).strict(),
  z.object({ kind: z.literal('actor-face-clip'), ...objectMember }).strict(),
  z.object({ kind: z.literal('actor-contact'), ...objectMember }).strict(),
  z.object({ kind: z.literal('actor-joint-key'), ...objectMember }).strict(),
  z.object({ kind: z.literal('motion-event'), ...objectMember }).strict(),
  z.object({ kind: z.literal('motion-path'), objectId: id, anchor }).strict(),
  z.object({ kind: z.literal('effect'), objectId: id, anchor }).strict(),
]);
export const synchronizationGroupSchema = z
  .object({
    id,
    name: z.string().min(1).max(200),
    locked: z.boolean().default(false),
    members: z.array(timingReferenceSchema).min(2).max(128),
  })
  .strict();
export const synchronizationSchema = z.array(synchronizationGroupSchema).max(1000);
export type TimingReference = z.infer<typeof timingReferenceSchema>;
export type SynchronizationGroup = z.infer<typeof synchronizationGroupSchema>;
export type SynchronizationProject = Project & { synchronization?: SynchronizationGroup[] };

export interface TimingMember {
  reference: TimingReference;
  label: string;
  start: number;
  end: number;
  locked: boolean;
  clock: 'source' | 'sequence';
  shift: (delta: number) => void;
}

export function timingReferenceKey(reference: TimingReference): string {
  return JSON.stringify([
    reference.kind,
    'objectId' in reference ? reference.objectId : null,
    'id' in reference ? reference.id : null,
  ]);
}

export function timingAnchor(member: TimingMember): number {
  return member.reference.anchor === 'end' ? member.end : member.start;
}

export function resolveTimingMember(project: Project, reference: TimingReference): TimingMember | null {
  const member = (
    label: string,
    start: number,
    end: number,
    locked: boolean,
    shift: (delta: number) => void,
    clock: TimingMember['clock'] = 'source',
  ): TimingMember => ({ reference, label, start, end, locked, shift, clock });
  if (reference.kind === 'beat') {
    const beat = project.beats.find((item) => item.id === reference.id);
    return beat
      ? member(beat.label, beat.time, beat.endTime, beat.locked, (delta) => {
          beat.time += delta;
          beat.endTime += delta;
        })
      : null;
  }
  if (reference.kind === 'audio') {
    const audio = project.audio.find((item) => item.id === reference.id);
    return audio
      ? member(
          audio.name,
          audio.start,
          audio.start + audio.duration,
          audio.locked,
          (delta) => (audio.start += delta),
          audio.sync,
        )
      : null;
  }
  const object = project.objects.find((item) => item.id === reference.objectId);
  if (!object) return null;
  const named = (suffix: string) => `${object.name} / ${suffix}`;
  switch (reference.kind) {
    case 'actor-face-clip': {
      const clip = objectFace(object)?.clips.find((item) => item.id === reference.id);
      return clip
        ? member(named(clip.name), clip.start, clip.end, object.locked, (delta) => {
            clip.start += delta;
            clip.end += delta;
          })
        : null;
    }
    case 'keyframe': {
      const frame = object.keyframes.find((item) => item.id === reference.id);
      return frame
        ? member(named('对象关键帧'), frame.time, frame.time, object.locked, (delta) => (frame.time += delta))
        : null;
    }
    case 'actor-clip': {
      const clip = object.actor?.animation?.clips.find((item) => item.id === reference.id);
      return clip
        ? member(named(clip.action), clip.start, clip.end, object.locked, (delta) => {
            clip.start += delta;
            clip.end += delta;
          })
        : null;
    }
    case 'actor-contact': {
      const contact = object.actor?.animation?.constraints.find((item) => item.id === reference.id);
      return contact
        ? member(named(contact.effector), contact.start, contact.end, object.locked, (delta) => {
            contact.start += delta;
            contact.end += delta;
          })
        : null;
    }
    case 'actor-joint-key': {
      const frame = object.actor?.animation?.jointKeys.find((item) => item.id === reference.id);
      return frame
        ? member(named(frame.joint), frame.time, frame.time, object.locked, (delta) => (frame.time += delta))
        : null;
    }
    case 'motion-event': {
      const event = object.motionEvents?.find((item) => item.id === reference.id);
      return event
        ? member(named(event.kind), event.time, event.time, object.locked, (delta) => (event.time += delta))
        : null;
    }
    case 'motion-path': {
      const path = object.motion;
      return path
        ? member(
            named('路径'),
            path.start,
            path.start + path.speed.reduce((sum, segment) => sum + segment.duration, 0),
            object.locked,
            (delta) => (path.start += delta),
          )
        : null;
    }
    case 'effect': {
      const effect = object.effect;
      return effect
        ? member(
            named(effect.kind),
            effect.start,
            effect.start + effect.duration,
            object.locked,
            (delta) => (effect.start += delta),
          )
        : null;
    }
  }
}

export function timingMembers(project: Project): TimingMember[] {
  const references: TimingReference[] = [
    ...project.beats.map((beat): TimingReference => ({ kind: 'beat', id: beat.id, anchor: 'start' })),
    ...project.audio.map((audio): TimingReference => ({ kind: 'audio', id: audio.id, anchor: 'start' })),
  ];
  for (const object of project.objects) {
    const add = (kind: TimingReference['kind'], items: { id: string }[]) => {
      for (const item of items)
        references.push({ kind, objectId: object.id, id: item.id, anchor: 'start' } as TimingReference);
    };
    add('keyframe', object.keyframes);
    add('actor-clip', object.actor?.animation?.clips ?? []);
    add('actor-face-clip', objectFace(object)?.clips ?? []);
    add('actor-contact', object.actor?.animation?.constraints ?? []);
    add('actor-joint-key', object.actor?.animation?.jointKeys ?? []);
    add('motion-event', object.motionEvents ?? []);
    if (object.motion) references.push({ kind: 'motion-path', objectId: object.id, anchor: 'start' });
    if (object.effect) references.push({ kind: 'effect', objectId: object.id, anchor: 'start' });
  }
  return references.flatMap((reference) => {
    const member = resolveTimingMember(project, reference);
    return member ? [member] : [];
  });
}

export function validateSynchronization(project: SynchronizationProject): void {
  const groupIds = new Set<string>();
  const membership = new Set<string>();
  for (const group of project.synchronization ?? []) {
    if (groupIds.has(group.id)) throw new DomainError(`Duplicate synchronization group: ${group.id}`);
    groupIds.add(group.id);
    for (const reference of group.members) {
      const key = timingReferenceKey(reference);
      if (membership.has(key)) throw new DomainError(`Timing member belongs to multiple groups: ${key}`);
      membership.add(key);
      const member = resolveTimingMember(project, reference);
      if (!member) throw new DomainError(`Unlink the missing timing member first: ${key}`, 'CONFLICT', 409);
      if (member.clock !== 'source')
        throw new DomainError(`Synchronization requires source-time audio: ${member.label}`);
    }
  }
}
