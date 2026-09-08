import type { Project, SceneObject } from './types';
import { DomainError } from './domain-error';
import { referencedOperandIds } from './modifiers/dependencies';
import { modelingDependencyFingerprint } from './object-modeling';

export function remapModifierReferences(object: SceneObject, mapping: Map<string, string>) {
  if (object.modeling?.kind !== 'stack') return;
  for (const modifier of object.modeling.modifiers)
    if (modifier.type === 'boolean')
      modifier.operandId = mapping.get(modifier.operandId) ?? modifier.operandId;
}
export function protectModifierDeletion(object: SceneObject, removed: Set<string>) {
  const referenced = referencedOperandIds(object).filter((id) => removed.has(id));
  if (referenced.length)
    throw new DomainError(
      `Remove or bake Boolean modifiers on ${object.id} before deleting operands: ${referenced.join(', ')}`,
      'MODIFIER_DEPENDENCY_REFERENCED',
      409,
    );
}
export function captureModifierLocks(project: Project) {
  return new Map(
    project.objects
      .filter((object) => object.locked && referencedOperandIds(object).length)
      .map((object) => [object.id, modelingDependencyFingerprint(project, object)]),
  );
}
export function validateModifierLocks(project: Project, before: Map<string, string>) {
  for (const [id, fingerprint] of before) {
    const object = project.objects.find((candidate) => candidate.id === id);
    if (object?.locked && modelingDependencyFingerprint(project, object) !== fingerprint)
      throw new DomainError(`Geometry change affects locked Boolean result: ${id}`, 'LOCKED', 409);
  }
}
