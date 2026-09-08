import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vector3 } from 'three';
import { applyCommands } from '../shared/commands';
import { createEmptyProject } from '../shared/project';
import { evaluateModelObject } from '../shared/object-modeling';
import { captureTemplate } from '../shared/templates';
import { ensureMeshIdentity } from '../shared/topology';
import { referencedOperandIds } from '../shared/modifiers/dependencies';
import type { Command, Project, SceneObject } from '../shared/types';
import { Store } from '../server/store';
import { prepareDirectories, type ServerConfig } from '../server/config';
import { exportProjectPackage, importProjectPackage } from '../server/project-packages';
import { topologyCube } from './fixtures/topology-command-cases';

function object(project: Project, id: string): SceneObject {
  const result = project.objects.find((candidate) => candidate.id === id);
  assert.ok(result, `Missing fixture object ${id}`);
  return result;
}

function boolean(id = 'target', operandId = 'operand', enabled = true): Command {
  return {
    type: 'modifier.add',
    payload: {
      id,
      modifier: { id: `cut-${operandId}`, type: 'boolean', operandId, operation: 'subtract', enabled },
    },
  };
}

function setup(): Command[] {
  return [
    { type: 'object.create', payload: { id: 'target', type: 'box', name: 'Target' } },
    {
      type: 'mesh.set',
      payload: { id: 'target', mesh: ensureMeshIdentity(topologyCube(), 'target-mesh') },
    },
    {
      type: 'object.create',
      payload: { id: 'operand-parent', type: 'group', position: [1, 0, 0], name: 'Operand parent' },
    },
    {
      type: 'object.create',
      payload: { id: 'operand', type: 'box', parentId: 'operand-parent', name: 'Operand' },
    },
    {
      type: 'mesh.set',
      payload: { id: 'operand', mesh: ensureMeshIdentity(topologyCube(), 'operand-mesh') },
    },
  ];
}

function fixture(): Project {
  return applyCommands(createEmptyProject('Editable dependencies'), [...setup(), boolean()]).project;
}

function volume(project: Project, id = 'target'): number {
  const mesh = evaluateModelObject(project, object(project, id));
  let result = 0;
  for (const face of mesh.faces) {
    const a = new Vector3(...mesh.vertices[face[0]]);
    for (let index = 1; index < face.length - 1; index++) {
      const b = new Vector3(...mesh.vertices[face[index]]);
      const c = new Vector3(...mesh.vertices[face[index + 1]]);
      result += a.dot(b.cross(c)) / 6;
    }
  }
  return Math.abs(result);
}

function approximately(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-5, `Expected volume ${expected}, received ${actual}`);
}

function moveOperandParent(position: [number, number, number]): Command {
  return { type: 'object.update', payload: { id: 'operand-parent', patch: { position } } };
}

test('hidden locked operands are read without mutation and the Boolean remains editable', () => {
  const source = applyCommands(createEmptyProject(), [
    ...setup(),
    { type: 'object.update', payload: { id: 'operand', patch: { locked: true, visible: false } } },
  ]).project;
  const retained = structuredClone(object(source, 'operand'));
  const result = applyCommands(source, [boolean()]).project;
  approximately(volume(result), 4);
  assert.deepEqual(object(result, 'operand'), retained);
  assert.deepEqual(referencedOperandIds(object(result, 'target')), ['operand']);
  const moved = applyCommands(result, [moveOperandParent([0.5, 0, 0])]).project;
  approximately(volume(moved), 2);
  assert.deepEqual(object(moved, 'operand'), retained);
  assert.deepEqual(object(moved, 'target').modeling, object(result, 'target').modeling);
});

test('a locked Boolean result protects operand geometry and ancestors while allowing unrelated metadata edits', () => {
  const project = applyCommands(fixture(), [
    { type: 'object.update', payload: { id: 'target', patch: { locked: true } } },
  ]).project;
  const before = structuredClone(project);
  const changedMesh = topologyCube();
  changedMesh.vertices.forEach((vertex) => {
    vertex[0] *= 1.25;
  });
  const blocked: Command[] = [
    { type: 'mesh.set', payload: { id: 'operand', mesh: changedMesh } },
    moveOperandParent([0.5, 0, 0]),
    { type: 'object.update', payload: { id: 'operand-parent', patch: { rotation: [0, 30, 0] } } },
    { type: 'object.update', payload: { id: 'operand-parent', patch: { scale: [1.5, 1, 1] } } },
  ];
  for (const command of blocked) {
    assert.throws(
      () =>
        applyCommands(project, [{ type: 'project.update', payload: { name: 'Must roll back' } }, command]),
      { code: 'LOCKED' },
    );
    assert.deepEqual(project, before);
  }
  const renamed = applyCommands(project, [
    { type: 'object.update', payload: { id: 'operand', patch: { name: 'Hidden cutter', visible: false } } },
    { type: 'object.update', payload: { id: 'operand-parent', patch: { name: 'Renamed parent' } } },
    { type: 'object.create', payload: { id: 'unrelated', type: 'box', position: [20, 0, 0] } },
  ]).project;
  assert.equal(object(renamed, 'operand').visible, false);
  assert.equal(object(renamed, 'operand-parent').name, 'Renamed parent');
  approximately(volume(renamed), 4);
  assert.deepEqual(object(renamed, 'target'), object(project, 'target'));
});

test('missing and cyclic references fail atomically for enabled and disabled modifiers', () => {
  for (const enabled of [true, false]) {
    const project = applyCommands(createEmptyProject(), setup()).project;
    const before = structuredClone(project);
    assert.throws(
      () =>
        applyCommands(project, [
          { type: 'project.update', payload: { name: 'Must roll back' } },
          boolean('target', 'missing', enabled),
        ]),
      { code: 'MODIFIER_DEPENDENCY_MISSING' },
    );
    assert.deepEqual(project, before);
    const linked = applyCommands(project, [boolean('target', 'operand', enabled)]).project;
    const linkedBefore = structuredClone(linked);
    assert.throws(
      () =>
        applyCommands(linked, [
          { type: 'project.update', payload: { name: 'Must roll back' } },
          boolean('operand', 'target', enabled),
        ]),
      { code: 'MODIFIER_DEPENDENCY_CYCLE' },
    );
    assert.deepEqual(linked, linkedBefore);
    assert.throws(() => applyCommands(project, [boolean('target', 'target', enabled)]), {
      code: 'MODIFIER_DEPENDENCY_CYCLE',
    });
  }
});

test('deleting operands or their ancestors requires removing or baking all surviving references', () => {
  for (const enabled of [true, false]) {
    const project = applyCommands(createEmptyProject(), [
      ...setup(),
      boolean('target', 'operand', enabled),
    ]).project;
    const before = structuredClone(project);
    for (const id of ['operand', 'operand-parent']) {
      assert.throws(() => applyCommands(project, [{ type: 'object.delete', payload: { id } }]), {
        code: 'MODIFIER_DEPENDENCY_REFERENCED',
      });
      assert.deepEqual(project, before);
    }
    const baked = applyCommands(project, [
      { type: 'modifier.bake', payload: { id: 'target' } },
      { type: 'object.delete', payload: { id: 'operand-parent' } },
    ]).project;
    assert.deepEqual(
      baked.objects.map((candidate) => candidate.id),
      ['target'],
    );
    assert.equal(object(baked, 'target').modeling?.kind, 'mesh');
    approximately(volume(baked), enabled ? 4 : 8);
  }
});

test('group duplication remaps internal dependencies, preserves external references and edits independently', () => {
  const project = applyCommands(fixture(), [
    { type: 'object.create', payload: { id: 'assembly', type: 'group' } },
    { type: 'object.update', payload: { id: 'target', patch: { parentId: 'assembly' } } },
    { type: 'object.update', payload: { id: 'operand-parent', patch: { parentId: 'assembly' } } },
    { type: 'object.create', payload: { id: 'external', type: 'box', position: [10, 0, 0] } },
    boolean('target', 'external', false),
  ]).project;
  const result = applyCommands(project, [
    { type: 'object.duplicate', payload: { id: 'assembly', newId: 'copy' } },
  ]).project;
  const oldIds = new Set(project.objects.map((candidate) => candidate.id));
  const clones = result.objects.filter((candidate) => !oldIds.has(candidate.id));
  assert.equal(clones.length, 4);
  const target = clones.find((candidate) => candidate.name === 'Target')!;
  const operand = clones.find((candidate) => candidate.name === 'Operand')!;
  const parent = clones.find((candidate) => candidate.name === 'Operand parent')!;
  assert.equal(operand.parentId, parent.id);
  assert.equal(parent.parentId, 'copy');
  assert.deepEqual(referencedOperandIds(target), [operand.id, 'external']);
  assert.deepEqual(
    result.objects.filter((candidate) => oldIds.has(candidate.id)),
    project.objects,
  );
  approximately(volume(result, target.id), 4);
  const changed = applyCommands(result, [
    { type: 'object.update', payload: { id: parent.id, patch: { position: [0.5, 0, 0] } } },
  ]).project;
  approximately(volume(changed, target.id), 2);
  approximately(volume(changed, 'target'), 4);
});

test('template capture includes transitive dependencies and instantiation retains editable mesh identity', () => {
  const project = applyCommands(fixture(), [
    {
      type: 'object.create',
      payload: { id: 'transitive', type: 'box', name: 'Transitive', position: [10, 0, 0] },
    },
    boolean('operand', 'transitive', false),
    { type: 'object.create', payload: { id: 'unrelated', type: 'box' } },
  ]).project;
  const before = structuredClone(project);
  const template = captureTemplate(project, {
    kind: 'objects',
    name: 'Boolean assembly',
    objectIds: ['target'],
  });
  assert.deepEqual(
    new Set(template.project.objects.map((candidate) => candidate.id)),
    new Set(['target', 'operand', 'operand-parent', 'transitive']),
  );
  assert.deepEqual(project, before);
  const first = applyCommands(createEmptyProject(), [
    { type: 'template.instantiate', payload: { template } },
  ]).project;
  const second = applyCommands(first, [{ type: 'template.instantiate', payload: { template } }]).project;
  const existing = new Set(first.objects.map((candidate) => candidate.id));
  const newObjects = second.objects.filter((candidate) => !existing.has(candidate.id));
  assert.equal(newObjects.length, 5);
  const target = newObjects.find((candidate) => candidate.name === 'Target')!;
  const operand = newObjects.find((candidate) => candidate.name === 'Operand')!;
  const transitive = newObjects.find((candidate) => candidate.name === 'Transitive')!;
  assert.deepEqual(referencedOperandIds(target), [operand.id]);
  assert.deepEqual(referencedOperandIds(operand), [transitive.id]);
  const originalModeling = object(project, 'target').modeling;
  assert.equal(originalModeling?.kind, 'stack');
  assert.equal(target.modeling?.kind, 'stack');
  if (originalModeling?.kind !== 'stack' || target.modeling?.kind !== 'stack')
    assert.fail('Expected modifier stacks');
  assert.equal(target.modeling.base.kind, 'mesh');
  assert.equal(originalModeling.base.kind, 'mesh');
  if (target.modeling.base.kind !== 'mesh' || originalModeling.base.kind !== 'mesh')
    assert.fail('Expected mesh bases');
  assert.deepEqual(target.modeling.base.identity, originalModeling.base.identity);
  assert.equal(target.modeling.base.identity?.namespace, 'target-mesh');
  approximately(volume(second, target.id), 4);
  const edited = applyCommands(second, [
    { type: 'object.update', payload: { id: operand.parentId, patch: { position: [0.5, 0, 0] } } },
  ]).project;
  approximately(volume(edited, target.id), 2);
  assert.deepEqual(
    edited.objects.filter((candidate) => existing.has(candidate.id)),
    first.objects,
  );
});

const configFor = (directory: string): ServerConfig => ({
  port: 4173,
  dataDir: directory,
  distDir: join(directory, 'dist'),
  appUrl: 'http://127.0.0.1:5173',
  apiUrl: 'http://127.0.0.1:4173',
});

test('SQLite history, restart and portable package restore retain dependencies and editable source IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-dependency-history-'));
  const sourceConfig = configFor(join(directory, 'source'));
  const targetConfig = configFor(join(directory, 'target'));
  prepareDirectories(sourceConfig);
  prepareDirectories(targetConfig);
  let source = new Store(sourceConfig.dataDir);
  let target = new Store(targetConfig.dataDir);
  try {
    source.newProject('Dependency history', 'empty');
    source.commands({ commands: [...setup(), boolean()] });
    const original = source.project();
    source.commands({ commands: [moveOperandParent([0.5, 0, 0])] });
    approximately(volume(source.project()), 2);
    source.travel(-1);
    assert.deepEqual(source.project().objects, original.objects);
    source.close();
    source = new Store(sourceConfig.dataDir);
    approximately(volume(source.project()), 4);
    approximately(volume(source.travel(1)), 2);
    source.travel(-1);
    const archive = await exportProjectPackage(source, sourceConfig, { includeVideos: false });
    assert.equal(archive.assets, 0);
    const restored = await importProjectPackage(target, targetConfig, archive.data);
    assert.notEqual(restored.project.id, original.id);
    assert.deepEqual(restored.project.objects, original.objects);
    assert.deepEqual(target.history(), { canUndo: true, canRedo: true });
    target.close();
    target = new Store(targetConfig.dataDir);
    approximately(volume(target.project()), 4);
    approximately(volume(target.travel(1)), 2);
    target.travel(-1);
    const beforeFailure = target.project();
    const historyBeforeFailure = target.history();
    assert.throws(
      () =>
        target.commands({
          commands: [
            { type: 'project.update', payload: { name: 'Must roll back' } },
            boolean('operand', 'target', false),
          ],
        }),
      { code: 'MODIFIER_DEPENDENCY_CYCLE' },
    );
    assert.deepEqual(target.project(), beforeFailure);
    assert.deepEqual(target.history(), historyBeforeFailure);
    target.commands({ commands: [moveOperandParent([1.5, 0, 0])] });
    approximately(volume(target.project()), 6);
    assert.deepEqual(object(target.project(), 'target').modeling, object(original, 'target').modeling);
    assert.deepEqual(referencedOperandIds(object(target.project(), 'target')), ['operand']);
    approximately(volume(target.travel(-1)), 4);
  } finally {
    source.close();
    target.close();
    await rm(directory, { recursive: true, force: true });
  }
});
