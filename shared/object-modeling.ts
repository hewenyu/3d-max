import type { Project, SceneObject } from './types';
import type { BaseModelingData, ModelingData } from './modeling';
import { ModelingError, supportsMeshConversion } from './modeling';
import { modelingToMesh, primitiveToMesh } from './modeling-geometry';
import { createModifierEvaluator, referencedOperandIds } from './modifiers/dependencies';

export function sourceModelMesh(object: SceneObject, source: BaseModelingData | undefined) {
  if (!source && !supportsMeshConversion(object))
    throw new ModelingError(
      `Object ${object.id} requires static mesh conversion`,
      'MODIFIER_OPERAND_UNSUPPORTED',
    );
  return source ? modelingToMesh(source) : primitiveToMesh(object);
}
export function createObjectModelEvaluator(project: Pick<Project, 'objects'>) {
  return createModifierEvaluator(project, sourceModelMesh);
}
export function evaluateModelObject(
  project: Pick<Project, 'objects'>,
  object: SceneObject,
  modeling?: ModelingData,
) {
  const source = modeling ? { ...object, modeling } : object;
  const view = modeling
    ? {
        ...project,
        objects: project.objects.map((candidate) => (candidate.id === object.id ? source : candidate)),
      }
    : project;
  if (referencedOperandIds(source).length) return createObjectModelEvaluator(view)(object.id);
  return source.modeling ? modelingToMesh(source.modeling) : primitiveToMesh(source);
}

export function modelingDependencyFingerprint(project: Pick<Project, 'objects'>, object: SceneObject) {
  const objects = new Map(project.objects.map((candidate) => [candidate.id, candidate]));
  const included = new Set<string>();
  const visit = (id: string) => {
    if (included.has(id)) return;
    included.add(id);
    const candidate = objects.get(id);
    if (!candidate) return;
    referencedOperandIds(candidate).forEach(visit);
    if (candidate.parentId) visit(candidate.parentId);
  };
  if (!referencedOperandIds(object).length) return '';
  visit(object.id);
  return JSON.stringify(
    [...included].sort().map((id) => {
      const candidate = objects.get(id);
      return candidate
        ? [
            id,
            candidate.type,
            candidate.modeling,
            candidate.dimensions,
            candidate.parentId,
            candidate.position,
            candidate.rotation,
            candidate.scale,
            candidate.attachment,
          ]
        : [id, null];
    }),
  );
}
