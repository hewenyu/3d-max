import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4 } from 'three';
import { createEmptyProject } from '../shared/project';
import { applyCommands } from '../shared/commands';
import { modelingToMesh, primitiveToMesh, meshVolume } from '../shared/modeling-geometry';
import { evaluateModifiers } from '../shared/modifier-evaluation';
import { modifyStack } from '../shared/modifier-operations';
import { meshModifierSchema } from '../shared/modifier-schema';
import type { MeshData } from '../shared/modeling';
import type { Project, SceneObject } from '../shared/types';
import { assertBooleanSolid, meshBoolean } from '../shared/modifiers/boolean';
import {
  createModifierEvaluator,
  evaluateObjectModifiers,
  referencedOperandIds,
  validateModifierDependencies,
  type ModifierSourceMesh,
} from '../shared/modifiers/dependencies';
import { diagnoseMesh } from '../shared/topology/diagnostics';

const source: ModifierSourceMesh = (object, base) => (base ? modelingToMesh(base) : primitiveToMesh(object));
const cube = () => primitiveToMesh({ type: 'box', dimensions: [2, 2, 2] });
const close = (actual: number, expected: number, tolerance = 1e-5) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
function objects(): Project {
  return applyCommands(createEmptyProject(), [
    { type: 'object.create', payload: { id: 'target', type: 'box', dimensions: [2, 2, 2] } },
    {
      type: 'object.create',
      payload: { id: 'operand', type: 'box', dimensions: [2, 2, 2], position: [1, 0, 0] },
    },
  ]).project;
}
function boolean(object: SceneObject, operandId: string, enabled = true) {
  object.modeling = {
    kind: 'stack',
    base:
      object.modeling?.kind === 'stack' ? object.modeling.base : (object.modeling ?? primitiveToMesh(object)),
    modifiers: [
      meshModifierSchema.parse({
        id: `boolean-${object.id}`,
        type: 'boolean',
        operandId,
        operation: 'subtract',
        enabled,
      }),
    ],
  };
}

test('shared CSG preserves analytic union, subtraction and intersection volumes without input mutation', () => {
  const target = cube();
  const operand = cube();
  const original = structuredClone([target, operand]);
  const transform = new Matrix4().makeTranslation(1, 0, 0);
  for (const [operation, volume] of [
    ['union', 12],
    ['subtract', 4],
    ['intersect', 4],
  ] as const) {
    const result = meshBoolean(target, operand, transform, operation);
    close(meshVolume(result), volume);
    assertBooleanSolid(result);
  }
  assert.deepEqual([target, operand], original);
  close(
    meshVolume(
      meshBoolean(target, operand, new Matrix4().makeScale(-1, 1, 1).setPosition(1, 0, 0), 'subtract'),
    ),
    4,
  );
});

test('referenced Boolean updates from source and nested evaluated operands using base parent transforms', () => {
  const project = objects();
  const target = project.objects[0];
  const operand = project.objects[1];
  boolean(target, operand.id);
  const before = structuredClone(project);
  close(meshVolume(evaluateObjectModifiers(project, target.id, source)), 4);
  assert.deepEqual(project, before);
  operand.position = [0.5, 0, 0];
  close(meshVolume(evaluateObjectModifiers(project, target.id, source)), 2);
  operand.position = [1, 0, 0];
  const parent = structuredClone(operand);
  parent.id = 'parent';
  parent.type = 'group';
  parent.position = [3, 0, 0];
  parent.modeling = undefined;
  project.objects.push(parent);
  operand.parentId = parent.id;
  operand.position = [-2, 0, 0];
  operand.locked = true;
  operand.visible = false;
  operand.keyframes = [{ id: 'moving', time: 1, position: [100, 0, 0] }];
  close(meshVolume(evaluateObjectModifiers(project, target.id, source)), 4);
  operand.modeling = {
    kind: 'stack',
    base: cube(),
    modifiers: [meshModifierSchema.parse({ id: 'copies', type: 'array', count: 2, offset: [0, 0, 4] })],
  };
  close(meshVolume(evaluateObjectModifiers(project, target.id, source)), 4);
});

test('live Boolean preserves source smooth shading without changing legacy destructive Boolean defaults', () => {
  const project = objects();
  const target = project.objects[0];
  target.modeling = { ...cube(), smooth: true };
  boolean(target, 'operand');
  const smooth = evaluateObjectModifiers(project, target.id, source);
  assert.equal(smooth.smooth, true);
  close(meshVolume(smooth), 4);
  const retained = project.objects[0].modeling;
  if (retained?.kind !== 'stack' || retained.base.kind !== 'mesh')
    throw new Error('Expected retained mesh stack');
  retained.base.smooth = false;
  assert.equal(evaluateObjectModifiers(project, target.id, source).smooth, false);
  assert.equal(
    meshBoolean({ ...cube(), smooth: true }, cube(), new Matrix4().makeTranslation(1, 0, 0), 'subtract')
      .smooth,
    false,
  );
});

test('disabled references are retained and validated, while enabled evaluation requires context', () => {
  const project = objects();
  boolean(project.objects[0], 'operand', false);
  assert.deepEqual(referencedOperandIds(project.objects[0]), ['operand']);
  const disabled = evaluateObjectModifiers(project, 'target', source);
  assert.deepEqual(disabled, cube());
  const stack = project.objects[0].modeling;
  if (stack?.kind !== 'stack') throw new Error('Expected stack');
  assert.throws(
    () => evaluateModifiers(cube(), [{ ...stack.modifiers[0], enabled: true }]),
    /project dependency context/,
  );
  project.objects.splice(1, 1);
  assert.throws(
    () => evaluateObjectModifiers(project, 'target', source),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'MODIFIER_DEPENDENCY_MISSING');
      return true;
    },
  );
});

test('missing and cyclic references reject disabled stacks and dependency chain limits are traversal-order independent', () => {
  const project = objects();
  boolean(project.objects[0], 'operand', false);
  boolean(project.objects[1], 'target', false);
  assert.throws(
    () => validateModifierDependencies(project),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'MODIFIER_DEPENDENCY_CYCLE');
      return true;
    },
  );
  const template = objects().objects[0];
  const chain = Array.from({ length: 33 }, (_, index) => ({
    ...structuredClone(template),
    id: `chain-${index}`,
  }));
  chain.forEach((object, index) => {
    if (index < chain.length - 1) boolean(object, chain[index + 1].id, false);
  });
  assert.throws(() => validateModifierDependencies({ objects: [...chain].reverse() }), /32 objects/);
  assert.throws(() => validateModifierDependencies({ objects: chain }), /32 objects/);
});

test('one immutable evaluator caches shared operands but returns independent editable values', () => {
  const project = objects();
  boolean(project.objects[0], 'operand');
  const counts = new Map<string, number>();
  const evaluate = createModifierEvaluator(project, (object, base) => {
    counts.set(object.id, (counts.get(object.id) ?? 0) + 1);
    return source(object, base);
  });
  const first = evaluate('target');
  first.vertices[0][0] = 999;
  const second = evaluate('target');
  close(meshVolume(second), 4);
  assert.equal(counts.get('target'), 1);
  assert.equal(counts.get('operand'), 1);
});

test('Boolean input boundaries fail without mutation, including open surfaces, singular matrices and empty intersections', () => {
  const target = cube();
  const open = { ...cube(), faces: cube().faces.slice(1) };
  assert.throws(() => meshBoolean(target, open, new Matrix4(), 'union'), /closed/);
  assert.throws(() => meshBoolean(target, cube(), new Matrix4().makeScale(0, 1, 1), 'union'), /singular/);
  assert.throws(
    () => meshBoolean(target, cube(), new Matrix4().makeTranslation(100, 0, 0), 'intersect'),
    /empty mesh/,
  );
  assert.deepEqual(target, cube());
});

test('convex-shell bevel modifier retains source and changes real facet count and volume with segments', () => {
  const base = cube();
  const first = meshModifierSchema.parse({ id: 'bevel', type: 'bevel', width: 0.2, segments: 1 });
  const rounded = meshModifierSchema.parse({ id: 'bevel', type: 'bevel', width: 0.2, segments: 3 });
  const chamfer = evaluateModifiers(base, [first]);
  const smooth = evaluateModifiers(base, [rounded]);
  assert.equal(chamfer.faces.length, 18);
  assert.equal(smooth.faces.length, 42);
  assert.ok(meshVolume(smooth) > meshVolume(chamfer));
  assert.ok(meshVolume(smooth) < meshVolume(base));
  const diagnostics = diagnoseMesh(smooth);
  assert.equal(diagnostics.closed, true);
  assert.equal(diagnostics.consistentlyOriented, true);
  assert.deepEqual(base, cube());
  assert.deepEqual(evaluateModifiers(base, [{ ...rounded, enabled: false }]), base);
  assert.throws(
    () => evaluateModifiers({ ...cube(), faces: cube().faces.slice(1) }, [rounded]),
    /closed manifold/,
  );
});

test('explicit stack bake delegates to dependency-aware evaluator and leaves retained stack unchanged', () => {
  const project = objects();
  const object = project.objects[0];
  boolean(object, 'operand');
  const before = structuredClone(object);
  const baked = modifyStack(object, { type: 'modifier.bake', payload: { id: object.id } }, () =>
    evaluateObjectModifiers(project, object.id, source),
  );
  assert.equal(baked.kind, 'mesh');
  close(meshVolume(baked as MeshData), 4);
  assert.deepEqual(object, before);
});
