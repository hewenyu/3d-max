import { z } from 'zod';
import { dequal } from 'dequal';
import { DomainError } from './domain-error';
import type { Command } from './types';
import {
  resolveTimingMember,
  synchronizationGroupSchema,
  timingAnchor,
  timingReferenceKey,
  timingReferenceSchema,
  validateSynchronization,
  type SynchronizationGroup,
  type SynchronizationProject,
  type TimingMember,
  type TimingReference,
} from './synchronization';

const id = z.string().min(1).max(160);
const epsilon = 1e-8;
const changed = (left: number, right: number) => Math.abs(left - right) > epsilon;
export const synchronizationCommandDefinitions = [
  {
    type: 'sync.group.set',
    description:
      'Create or replace a source-time synchronization group. Members retain their current offsets; each binds its start or end anchor. Editing an anchor shifts other members while preserving their durations. A member belongs to one group. Missing group ID is generated.',
    schema: z.object({ group: synchronizationGroupSchema.extend({ id: id.optional() }).strict() }).strict(),
  },
  {
    type: 'sync.group.delete',
    description: 'Unlink a complete synchronization group, preserving all current member timing.',
    schema: z.object({ id }).strict(),
  },
  {
    type: 'sync.member.remove',
    description:
      'Unlink one member without moving any content. A group with fewer than two remaining members is removed.',
    schema: z.object({ id, member: timingReferenceSchema }).strict(),
  },
  {
    type: 'sync.group.move',
    description:
      'Move every group member by the same delta so its earliest selected anchor equals time in source seconds. Durations and all relative offsets remain unchanged; any locked member rejects the transaction.',
    schema: z.object({ id, time: z.number().finite().min(0).max(86400) }).strict(),
  },
];

interface MemberSnapshot {
  start: number;
  end: number;
  anchor: number;
  locked: boolean;
}
export interface SynchronizationSnapshot {
  context: string;
  groups: { group: SynchronizationGroup; members: Map<string, MemberSnapshot> }[];
}
export interface SynchronizationTransaction {
  explicitTimes: Map<string, number>;
}
export function createSynchronizationTransaction(): SynchronizationTransaction {
  return { explicitTimes: new Map() };
}
const contextKey = (project: SynchronizationProject) =>
  JSON.stringify([
    project.id,
    project.production?.activeSceneId ?? null,
    project.production?.activePerformanceId ?? null,
  ]);

export function captureSynchronization(project: SynchronizationProject): SynchronizationSnapshot {
  return {
    context: contextKey(project),
    groups: (project.synchronization ?? []).map((group) => ({
      group: structuredClone(group),
      members: new Map(
        group.members.flatMap((reference) => {
          const member = resolveTimingMember(project, reference);
          return member
            ? [
                [
                  timingReferenceKey(reference),
                  {
                    start: member.start,
                    end: member.end,
                    anchor: timingAnchor(member),
                    locked: member.locked,
                  },
                ] as const,
              ]
            : [];
        }),
      ),
    })),
  };
}

function assertMovable(member: TimingMember, delta: number): void {
  if (member.locked) throw new DomainError(`Timing member is locked: ${member.label}`, 'LOCKED', 409);
  if (member.start + delta < -epsilon || member.end + delta > 86400 + epsilon)
    throw new DomainError(`Synchronization moves outside the source-time range: ${member.label}`);
}

function sortTracks(project: SynchronizationProject): void {
  project.beats.sort((left, right) => left.time - right.time);
  for (const object of project.objects) {
    object.keyframes.sort((left, right) => left.time - right.time);
    object.actor?.animation?.jointKeys.sort(
      (left, right) => left.time - right.time || left.joint.localeCompare(right.joint),
    );
    object.motionEvents?.sort((left, right) => left.time - right.time);
  }
}

/** Plan all secondary moves before applying any, then let the domain transaction validate the result. */
export function applySynchronization(
  project: SynchronizationProject,
  snapshot: SynchronizationSnapshot,
  transaction = createSynchronizationTransaction(),
): void {
  if (snapshot.context !== contextKey(project)) return;
  validateSynchronization(project);
  const shifts: { member: TimingMember; delta: number }[] = [];
  const pins = new Map(transaction.explicitTimes);
  for (const previous of snapshot.groups) {
    const group = project.synchronization?.find((item) => item.id === previous.group.id);
    if (!group) continue;
    const members = group.members.map((reference) => resolveTimingMember(project, reference)!);
    const moved = members.flatMap((member) => {
      const key = timingReferenceKey(member.reference);
      const before = previous.members.get(key);
      if (!before) return [];
      const originalReference = previous.group.members.find((item) => timingReferenceKey(item) === key)!;
      if (originalReference.anchor !== member.reference.anchor) return [];
      const timingChanged = changed(member.start, before.start) || changed(member.end, before.end);
      if (timingChanged && (group.locked || previous.group.locked || before.locked || member.locked))
        throw new DomainError(`Synchronized timing is locked: ${member.label}`, 'LOCKED', 409);
      const delta = timingAnchor(member) - before.anchor;
      return changed(delta, 0) ? [{ member, delta }] : [];
    });
    if (!moved.length) continue;
    const delta = moved[0]!.delta;
    if (moved.some((item) => changed(item.delta, delta)))
      throw new DomainError(`Conflicting timing edits in group: ${group.id}`, 'CONFLICT', 409);
    const movedKeys = new Set(moved.map(({ member }) => timingReferenceKey(member.reference)));
    const pinKey = (reference: TimingReference) =>
      JSON.stringify([snapshot.context, group.id, timingReferenceKey(reference), reference.anchor]);
    for (const { member } of moved) pins.set(pinKey(member.reference), timingAnchor(member));
    for (const member of members) {
      if (movedKeys.has(timingReferenceKey(member.reference))) continue;
      const pinned = pins.get(pinKey(member.reference));
      if (pinned !== undefined && changed(timingAnchor(member) + delta, pinned))
        throw new DomainError(`Conflicting explicit timing edit: ${member.label}`, 'CONFLICT', 409);
      assertMovable(member, delta);
      shifts.push({ member, delta });
    }
  }
  for (const { member, delta } of shifts) member.shift(delta);
  transaction.explicitTimes = pins;
  if (shifts.length) sortTracks(project);
}

export function applySynchronizationCommand(project: SynchronizationProject, command: Command): unknown {
  const p = command.payload;
  const groups = (project.synchronization ??= []);
  if (command.type === 'sync.group.set') {
    const incoming = p.group as SynchronizationGroup;
    const group = { ...incoming, id: incoming.id ?? crypto.randomUUID() };
    const existing = groups.find((item) => item.id === group.id);
    if (existing?.locked) {
      const unlocked = { ...existing, locked: false };
      if (!dequal(group, unlocked))
        throw new DomainError(`Synchronization group is locked: ${existing.id}`, 'LOCKED', 409);
    }
    if (existing) groups[groups.indexOf(existing)] = group;
    else groups.push(group);
    validateSynchronization(project);
    return group;
  }
  const group = groups.find((item) => item.id === p.id);
  if (!group) throw new DomainError(`Synchronization group not found: ${String(p.id)}`, 'NOT_FOUND', 404);
  if (group.locked) throw new DomainError(`Synchronization group is locked: ${group.id}`, 'LOCKED', 409);
  switch (command.type) {
    case 'sync.group.delete':
      groups.splice(groups.indexOf(group), 1);
      return { id: group.id, deleted: true };
    case 'sync.member.remove': {
      const key = timingReferenceKey(p.member as TimingReference);
      const index = group.members.findIndex((member) => timingReferenceKey(member) === key);
      if (index < 0) throw new DomainError(`Timing member not found: ${key}`, 'NOT_FOUND', 404);
      group.members.splice(index, 1);
      if (group.members.length < 2) groups.splice(groups.indexOf(group), 1);
      return { id: group.id, removed: p.member, deleted: group.members.length < 2 };
    }
    case 'sync.group.move': {
      validateSynchronization(project);
      const members = group.members.map((reference) => resolveTimingMember(project, reference)!);
      const delta = Number(p.time) - Math.min(...members.map(timingAnchor));
      if (!changed(delta, 0)) return group;
      for (const member of members) assertMovable(member, delta);
      for (const member of members) member.shift(delta);
      sortTracks(project);
      return group;
    }
    default:
      throw new DomainError(`Unknown synchronization command: ${command.type}`);
  }
}
