import type { SceneObject } from './types';
import { DomainError } from './domain-error';

export function validateActorTargets(object: SceneObject, objects: Map<string, SceneObject>): void {
  for (const constraint of object.actor?.animation?.constraints ?? []) {
    const target = constraint.target;
    if (target.kind !== 'object') continue;
    const other = objects.get(target.objectId);
    if (!other) throw new DomainError(`Missing IK target ${target.objectId} for constraint ${constraint.id}`);
    if (target.bone && target.bone !== 'root' && other.type !== 'actor')
      throw new DomainError(`IK bone target requires an actor: ${constraint.id}`);
  }
}

export function protectActorTargets(object: Pick<SceneObject, 'id' | 'actor'>, removed: Set<string>): void {
  const constraint = object.actor?.animation?.constraints.find(
    (item) => item.target.kind === 'object' && removed.has(item.target.objectId),
  );
  if (constraint)
    throw new DomainError(`Remove IK constraint ${constraint.id} on ${object.id} before deleting its target`);
}

export function remapActorTargets(object: SceneObject, mapping: Map<string, string>): void {
  for (const constraint of object.actor?.animation?.constraints ?? []) {
    if (constraint.target.kind === 'object')
      constraint.target.objectId = mapping.get(constraint.target.objectId) ?? constraint.target.objectId;
  }
}
