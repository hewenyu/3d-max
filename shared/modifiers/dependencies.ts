import { Matrix4 } from 'three';
import { DomainError } from '../domain-error';
import type { BaseModelingData, MeshData } from '../modeling';
import { modelingWorldMatrix } from '../modeling-transforms';
import { evaluateModifiers } from '../modifier-evaluation';
import type { Project, SceneObject } from '../types';

export const MODIFIER_DEPENDENCY_LIMITS = { depth: 32, objects: 256 } as const;
type ModifierProject = Pick<Project, 'objects'>;

export class ModifierDependencyError extends DomainError {
  constructor(
    message: string,
    code: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message, code, code === 'MODIFIER_DEPENDENCY_MISSING' ? 404 : 422);
  }
}

export function referencedOperandIds(object: Pick<SceneObject, 'modeling'>): string[] {
  return object.modeling?.kind === 'stack'
    ? [
        ...new Set(
          object.modeling.modifiers.flatMap((modifier) =>
            modifier.type === 'boolean' ? [modifier.operandId] : [],
          ),
        ),
      ]
    : [];
}

export function validateModifierDependencies(
  project: ModifierProject,
  roots = project.objects.map((object) => object.id),
) {
  const objects = new Map(project.objects.map((object) => [object.id, object]));
  const visited = new Map<string, number>();
  const active: string[] = [];
  const visit = (id: string): number => {
    if (active.includes(id))
      throw new ModifierDependencyError(
        'Boolean modifier dependencies contain a cycle',
        'MODIFIER_DEPENDENCY_CYCLE',
        { path: [...active, id] },
      );
    const knownDepth = visited.get(id);
    if (knownDepth !== undefined) {
      if (active.length + knownDepth > MODIFIER_DEPENDENCY_LIMITS.depth)
        throw new ModifierDependencyError('Modifier dependency chain exceeds 32 objects', 'MODELING_LIMIT', {
          path: [...active, id],
        });
      return knownDepth;
    }
    const object = objects.get(id);
    if (!object)
      throw new ModifierDependencyError(
        'Boolean operand is unavailable in this scene',
        'MODIFIER_DEPENDENCY_MISSING',
        { objectId: id, path: [...active, id] },
      );
    if (active.length >= MODIFIER_DEPENDENCY_LIMITS.depth)
      throw new ModifierDependencyError('Modifier dependency chain exceeds 32 objects', 'MODELING_LIMIT', {
        path: [...active, id],
      });
    active.push(id);
    const depth = 1 + Math.max(0, ...referencedOperandIds(object).map(visit));
    active.pop();
    visited.set(id, depth);
    return depth;
  };
  roots.forEach(visit);
  return {
    objectIds: [...visited.keys()],
    references: Object.fromEntries(
      [...visited.keys()].map((id) => [id, referencedOperandIds(objects.get(id)!)]),
    ),
  };
}

export type ModifierSourceMesh = (object: SceneObject, source: BaseModelingData | undefined) => MeshData;

export function createModifierEvaluator(project: ModifierProject, sourceMesh: ModifierSourceMesh) {
  const objects = new Map(project.objects.map((object) => [object.id, object]));
  const cache = new Map<string, MeshData>();
  const resolving = new Set<string>();
  const resolve = (id: string): MeshData => {
    const cached = cache.get(id);
    if (cached) return structuredClone(cached);
    if (resolving.has(id))
      throw new ModifierDependencyError(
        'Boolean modifier dependencies contain a cycle',
        'MODIFIER_DEPENDENCY_CYCLE',
        { objectId: id },
      );
    const object = objects.get(id);
    if (!object)
      throw new ModifierDependencyError(
        'Boolean operand is unavailable in this scene',
        'MODIFIER_DEPENDENCY_MISSING',
        { objectId: id },
      );
    if (resolving.size >= MODIFIER_DEPENDENCY_LIMITS.depth)
      throw new ModifierDependencyError(
        'Modifier evaluation exceeds 32 dependency levels or 256 objects',
        'MODELING_LIMIT',
      );
    if (object.actor || object.type === 'actor' || object.vehicle || object.effect || object.attachment)
      throw new ModifierDependencyError(
        'Boolean operands require static mesh geometry without bone attachments or animated rigs',
        'MODIFIER_OPERAND_UNSUPPORTED',
        { objectId: id },
      );
    resolving.add(id);
    try {
      const stack = object.modeling?.kind === 'stack' ? object.modeling : undefined;
      const source = sourceMesh(object, stack?.base ?? (object.modeling as BaseModelingData | undefined));
      const evaluated = stack
        ? evaluateModifiers(source, stack.modifiers, {
            objectId: id,
            resolveOperand: (operandId) => {
              const operand = objects.get(operandId);
              if (!operand)
                throw new ModifierDependencyError(
                  'Boolean operand is unavailable in this scene',
                  'MODIFIER_DEPENDENCY_MISSING',
                  { objectId: id, operandId },
                );
              const matrix = modelingWorldMatrix(project, object);
              if (!Number.isFinite(matrix.determinant()) || Math.abs(matrix.determinant()) < 1e-10)
                throw new ModifierDependencyError(
                  'Boolean target world transform is singular',
                  'MODELING_TRANSFORM',
                  { objectId: id },
                );
              const operandToTarget = new Matrix4()
                .copy(matrix)
                .invert()
                .multiply(modelingWorldMatrix(project, operand));
              return { mesh: resolve(operandId), operandToTarget };
            },
          })
        : source;
      if (cache.size >= MODIFIER_DEPENDENCY_LIMITS.objects) cache.delete(cache.keys().next().value!);
      cache.set(id, structuredClone(evaluated));
      return structuredClone(evaluated);
    } finally {
      resolving.delete(id);
    }
  };
  return (objectId: string) => {
    const dependencies = validateModifierDependencies(project, [objectId]);
    if (dependencies.objectIds.length > MODIFIER_DEPENDENCY_LIMITS.objects)
      throw new ModifierDependencyError('Modifier dependency graph exceeds 256 objects', 'MODELING_LIMIT');
    return resolve(objectId);
  };
}

export function evaluateObjectModifiers(
  project: ModifierProject,
  objectId: string,
  sourceMesh: ModifierSourceMesh,
): MeshData {
  return createModifierEvaluator(project, sourceMesh)(objectId);
}
