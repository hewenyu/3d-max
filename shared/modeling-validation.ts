import { DomainError } from './domain-error';
import { meshDataSchema, type ModelingData } from './modeling';
import { modelingToMesh } from './modeling-geometry';
import type { Project, SceneObject } from './types';
import { evaluateModelObject, modelingDependencyFingerprint } from './object-modeling';
import { referencedOperandIds, validateModifierDependencies } from './modifiers/dependencies';

const validated = new Map<string, number>();
let retainedBytes = 0;
const byteLimit = 8 * 1024 * 1024;

export function validateAdvancedModeling(
  modeling: ModelingData | undefined,
  project?: Project,
  object?: SceneObject,
) {
  if (!modeling) return;
  const advanced =
    modeling.kind === 'surface' ||
    (modeling.kind === 'stack' &&
      (modeling.base.kind === 'surface' ||
        modeling.modifiers.some(
          (modifier) =>
            !['mirror', 'array', 'subdivision'].includes(modifier.type) ||
            (modifier.type === 'mirror' && Boolean(modifier.weldThreshold)),
        )));
  if (!advanced) return;
  const dependencies = object ? referencedOperandIds(object) : [];
  if (dependencies.length && project) validateModifierDependencies(project, [object!.id]);
  const key =
    JSON.stringify(modeling) + (project && object ? modelingDependencyFingerprint(project, object) : '');
  const bytes = key.length * 2;
  if (validated.has(key)) {
    validated.delete(key);
    validated.set(key, bytes);
    return;
  }
  const mesh =
    project && object && dependencies.length
      ? evaluateModelObject(project, object)
      : modelingToMesh(modeling);
  const parsed = meshDataSchema.safeParse(mesh);
  if (!parsed.success)
    throw new DomainError('Advanced modeling produced invalid mesh geometry', 'MODELING_TOPOLOGY');
  if (bytes > byteLimit) return;
  while (validated.size >= 64 || retainedBytes + bytes > byteLimit) {
    const oldest = validated.keys().next().value!;
    retainedBytes -= validated.get(oldest)!;
    validated.delete(oldest);
  }
  validated.set(key, bytes);
  retainedBytes += bytes;
}
