import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommands } from '../shared/commands';
import { createEmptyProject, createObject } from '../shared/project';
import { modelingToMesh, meshVolume } from '../shared/modeling-geometry';
import { projectSchema } from '../shared/schema';
import type { Project } from '../shared/types';

function fixture() {
  const project = createEmptyProject('Modifiers');
  project.objects.push({ ...createObject('box'), id: 'box', dimensions: [2, 2, 2] });
  return project;
}
function edit(project: Project, type: string, payload: Record<string, unknown> = {}) {
  return applyCommands(project, [{ type, payload: { id: 'box', ...payload } }]).project;
}
function mesh(project: Project) {
  return modelingToMesh(project.objects[0].modeling!);
}
function bounds(project: Project) {
  const vertices = mesh(project).vertices;
  return [Math.min(...vertices.map((vertex) => vertex[0])), Math.max(...vertices.map((vertex) => vertex[0]))];
}

test('modifier order is meaningful, settings stay editable, and disabling/removing restores source', () => {
  const original = fixture();
  let project = edit(original, 'modifier.add', {
    modifier: { id: 'array', type: 'array', count: 2, offset: [3, 0, 0] },
  });
  project = edit(project, 'modifier.add', {
    modifier: { id: 'mirror', type: 'mirror', axis: 'x', offset: 0, keepOriginal: false },
  });
  assert.deepEqual(bounds(project), [-4, 1]);
  assert.ok(Math.abs(meshVolume(mesh(project)) - 16) < 1e-6);
  project = edit(project, 'modifier.reorder', { modifierId: 'mirror', index: 0 });
  assert.deepEqual(bounds(project), [-1, 4]);
  project = edit(project, 'modifier.set', {
    modifier: { id: 'array', type: 'array', count: 3, offset: [3, 0, 0], enabled: false },
  });
  assert.deepEqual(bounds(project), [-1, 1]);
  project = edit(project, 'modifier.remove', { modifierId: 'array' });
  project = edit(project, 'modifier.remove', { modifierId: 'mirror' });
  assert.equal(project.objects[0].modeling!.kind, 'mesh');
  assert.equal(mesh(project).vertices.length, 8);
  assert.equal(original.objects[0].modeling, undefined);
});

test('source topology edits recompute modifiers and baking preserves evaluated geometry', () => {
  let project = edit(fixture(), 'modifier.add', {
    modifier: { id: 'array', type: 'array', count: 3, offset: [4, 0, 0] },
  });
  project = edit(project, 'mesh.face.extrude', { faceIndex: 4, distance: 1 });
  const stack = project.objects[0].modeling!;
  assert.equal(stack.kind, 'stack');
  if (stack.kind !== 'stack' || stack.base.kind !== 'mesh') throw new Error('Missing source mesh');
  assert.equal(stack.base.vertices.length, 12);
  assert.equal(mesh(project).vertices.length, 36);
  assert.ok(Math.abs(meshVolume(mesh(project)) - 36) < 1e-6);
  const result = mesh(project);
  const restored = projectSchema.parse(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(mesh(restored), result);
  project = edit(project, 'modifier.bake');
  assert.equal(project.objects[0].modeling!.kind, 'mesh');
  assert.deepEqual(mesh(project), result);
});

test('Loop subdivision increases real topology and changes geometry; flat subdivision preserves volume', () => {
  const original = fixture();
  const smooth = edit(original, 'modifier.add', {
    modifier: { id: 'subdivision', type: 'subdivision', iterations: 2 },
  });
  const flat = edit(original, 'modifier.add', {
    modifier: { id: 'subdivision', type: 'subdivision', iterations: 2, flatOnly: true },
  });
  assert.equal(mesh(smooth).faces.length, 12 * 16);
  assert.equal(mesh(flat).faces.length, 12 * 16);
  assert.ok(meshVolume(mesh(smooth)) < 8);
  assert.ok(Math.abs(meshVolume(mesh(flat)) - 8) < 1e-6);
  assert.equal(mesh(smooth).smooth, true);
});

test('curve and terrain controls edit retained parametric sources under the stack', () => {
  let curve = edit(fixture(), 'curve.set', {
    curve: {
      points: [
        [0, 0, 0],
        [0, 0, 4],
      ],
      profile: 'road',
      segments: 8,
      width: 2,
    },
  });
  curve = edit(curve, 'modifier.add', { modifier: { id: 'array', type: 'array', offset: [5, 0, 0] } });
  curve = edit(curve, 'curve.set', {
    curve: {
      points: [
        [0, 0, 0],
        [0, 0, 8],
      ],
      profile: 'road',
      segments: 8,
      width: 2,
    },
  });
  assert.equal(curve.objects[0].modeling!.kind, 'stack');
  assert.equal(Math.max(...mesh(curve).vertices.map((vertex) => vertex[2])), 8);
  let terrain = edit(fixture(), 'terrain.set', {
    terrain: { sizeX: 4, sizeZ: 4, segmentsX: 2, segmentsZ: 2 },
  });
  terrain = edit(terrain, 'modifier.add', { modifier: { id: 'array', type: 'array', offset: [6, 0, 0] } });
  terrain = edit(terrain, 'terrain.point.set', { row: 1, column: 1, height: 2 });
  assert.equal(terrain.objects[0].modeling!.kind, 'stack');
  assert.equal(mesh(terrain).vertices.filter((vertex) => vertex[1] === 2).length, 2);
});

test('invalid stack edits, expensive geometry, locked objects and Boolean source edits fail atomically', () => {
  let project = edit(fixture(), 'modifier.add', {
    modifier: { id: 'array', type: 'array', count: 32, offset: [3, 0, 0] },
  });
  const snapshot = structuredClone(project);
  assert.throws(() => edit(project, 'modifier.add', { modifier: { id: 'array', type: 'mirror' } }), {
    code: 'CONFLICT',
  });
  assert.throws(() => edit(project, 'modifier.reorder', { modifierId: 'array', index: 1 }), /out of range/);
  assert.throws(
    () => edit(project, 'modifier.add', { modifier: { id: 'zero', type: 'array', offset: [0, 0, 0] } }),
    /nonzero/,
  );
  assert.throws(
    () =>
      applyCommands(project, [
        {
          type: 'modifier.add',
          payload: { id: 'box', modifier: { id: 'b', type: 'array', count: 32, offset: [0, 4, 0] } },
        },
        {
          type: 'modifier.add',
          payload: { id: 'box', modifier: { id: 'c', type: 'array', count: 32, offset: [0, 0, 4] } },
        },
      ]),
    { code: 'MODELING_LIMIT' },
  );
  assert.deepEqual(project, snapshot);
  assert.throws(() => edit(project, 'mesh.boolean', { operandId: 'other', operation: 'union' }), /Bake/);
  project.objects[0].locked = true;
  assert.throws(() => edit(project, 'modifier.bake'), { code: 'LOCKED' });
});
