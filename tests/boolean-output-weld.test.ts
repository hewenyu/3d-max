import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommands } from '../shared/commands';
import { createEmptyProject } from '../shared/project';
import { evaluateModelObject } from '../shared/object-modeling';
import { meshVolume } from '../shared/modeling-geometry';
import { diagnoseMesh } from '../shared/topology/diagnostics';
import type { Project } from '../shared/types';
import type { MeshData } from '../shared/modeling';
import { weldBooleanOutput } from '../shared/modifiers/boolean';
import { architectureArchCommands, archOpeningArea } from './fixtures/boolean-arches';

const wall = (project: Project) =>
  evaluateModelObject(
    project,
    project.objects.find((object) => object.id === 'front-wall')!,
  );
const close = (actual: number, expected: number, tolerance = 0.00001) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('production arch Boolean output welds near vertices across quantization cells without losing wall volume', () => {
  const project = applyCommands(createEmptyProject(), architectureArchCommands()).project;
  const before = structuredClone(project);
  const mesh = wall(project);
  const diagnostics = diagnoseMesh(mesh);
  assert.deepEqual(diagnostics.duplicateVertices, []);
  assert.deepEqual(diagnostics.boundaryEdges, []);
  assert.equal(diagnostics.closed, true);
  assert.equal(diagnostics.consistentlyOriented, true);
  assert.equal(diagnostics.counts.connectedComponents, 1);
  const unBeveledVolume = 12 * 4.4 * 0.36 - 3 * archOpeningArea * 0.36;
  assert.ok(meshVolume(mesh) < unBeveledVolume);
  assert.ok(meshVolume(mesh) > unBeveledVolume - 0.1);
  assert.deepEqual(project, before);
});

test('arch dependency changes remain watertight and preserve independently calculated opening volumes', () => {
  const project = applyCommands(createEmptyProject(), architectureArchCommands(false)).project;
  const original = wall(project);
  close(meshVolume(original), 12 * 4.4 * 0.36 - 3 * archOpeningArea * 0.36);
  const changed = applyCommands(project, [
    { type: 'object.update', payload: { id: 'arch-cutter-0', patch: { scale: [1, 1.12, 1] } } },
  ]).project;
  const edited = wall(changed);
  close(meshVolume(edited), 12 * 4.4 * 0.36 - 3.12 * archOpeningArea * 0.36);
  for (const mesh of [original, edited]) {
    const diagnostics = diagnoseMesh(mesh);
    assert.equal(diagnostics.closed, true);
    assert.deepEqual(diagnostics.duplicateVertices, []);
    assert.deepEqual(diagnostics.nonManifoldEdges, []);
  }
  assert.deepEqual(changed.objects[0].modeling, project.objects[0].modeling);
});

test('Boolean weld preserves faces and its micron tolerance, rejecting ambiguous chains or collapsed features', () => {
  const split: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0.4999998, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 0.5000001, 0],
      [-1, 1, 0],
    ],
    faces: [
      [0, 1, 2],
      [3, 2, 4],
    ],
  };
  const before = structuredClone(split);
  const welded = weldBooleanOutput(split);
  assert.equal(welded.vertices.length, 4);
  assert.equal(welded.faces.length, split.faces.length);
  assert.deepEqual(welded.vertices[0], split.vertices[0]);
  assert.deepEqual(split, before);
  const outside = structuredClone(split);
  outside.vertices[3][1] = outside.vertices[0][1] + 0.00000101;
  assert.deepEqual(weldBooleanOutput(outside), outside);
  const chain = structuredClone(split);
  chain.vertices[3][1] = chain.vertices[0][1] + 0.00000075;
  chain.vertices.push([0, chain.vertices[0][1] + 0.0000015, 0]);
  assert.throws(() => weldBooleanOutput(chain), { code: 'MODELING_PRECISION' });
  const feature: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [0.00000075, 0, 0],
      [0, 1, 0],
    ],
    faces: [[0, 1, 2]],
  };
  const retained = structuredClone(feature);
  assert.throws(() => weldBooleanOutput(feature), { code: 'MODELING_PRECISION' });
  assert.deepEqual(feature, retained);
});
