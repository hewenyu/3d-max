import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Matrix4, Vector3 } from 'three';
import { Store } from '../server/store';
import { applyCommands } from '../shared/commands';
import { createEmptyProject } from '../shared/project';
import { buildTopology, meshFaceNormal } from '../shared/topology';
import { modelingWorldMatrix } from '../shared/modeling-transforms';
import type { Command, Project } from '../shared/types';
import { topologyCube, topologySelection, topologySource } from './fixtures/topology-command-cases';

function commands(): Command[] {
  const mesh = topologyCube();
  return [
    { type: 'object.create', payload: { id: 'target', type: 'box', dimensions: [2, 2, 2] } },
    {
      type: 'mesh.set',
      payload: { id: 'target', mesh: { vertices: mesh.vertices, faces: mesh.faces, smooth: false } },
    },
  ];
}
function fixture(): Project {
  return applyCommands(createEmptyProject('Topology domain'), commands()).project;
}
function transform(project: Project): Command {
  return {
    type: 'topology.transform',
    payload: { id: 'target', selection: topologySelection(project, 'vertex'), translation: [0.25, 0, 0] },
  };
}

test('legacy geometry reads do not migrate snapshots; first topology edit writes stable IDs and retains geometry mapping', () => {
  const project = fixture();
  const original = structuredClone(project);
  assert.equal(topologySource(project).identity, undefined);
  const read = buildTopology(topologySource(project));
  assert.deepEqual(project, original);
  const result = applyCommands(project, [transform(project)]);
  const mesh = topologySource(result.project);
  assert.ok(mesh.identity);
  assert.equal(mesh.identity.namespace, read.mesh.identity.namespace);
  assert.deepEqual(mesh.identity.vertexIds, read.mesh.identity.vertexIds);
  assert.equal(mesh.vertices[0][0], -0.75);
  assert.deepEqual(project, original);
});

test('legacy index add/delete/extrude operations maintain IDs after topology editing', () => {
  let project = fixture();
  project = applyCommands(project, [transform(project)]).project;
  const initial = topologySource(project);
  const identity = structuredClone(initial.identity!);
  project = applyCommands(project, [
    { type: 'mesh.vertex.add', payload: { id: 'target', position: [9, 9, 9] } },
  ]).project;
  const added = topologySource(project).identity!.vertexIds.at(-1)!;
  project = applyCommands(project, [
    { type: 'mesh.vertex.delete', payload: { id: 'target', index: initial.vertices.length } },
  ]).project;
  assert.deepEqual(topologySource(project).identity!.vertexIds, identity.vertexIds);
  project = applyCommands(project, [
    { type: 'mesh.face.extrude', payload: { id: 'target', faceIndex: 3, distance: 0.25 } },
  ]).project;
  const after = topologySource(project);
  assert.equal(after.identity!.namespace, identity.namespace);
  assert.ok(!after.identity!.vertexIds.includes(added));
  assert.equal(after.identity!.vertexIds.length, after.vertices.length);
  assert.equal(after.identity!.faceIds.length, after.faces.length);
  assert.equal(after.identity!.faceIds[3], identity.faceIds[3]);
  assert.ok(after.identity!.nextId > Number(added.slice(1)));
});

test('topology batches roll back earlier edits on stale selection or a later locked object edit', () => {
  const project = fixture();
  const original = structuredClone(project);
  const stale = {
    ...transform(project),
    payload: {
      ...transform(project).payload,
      selection: { ...topologySelection(project, 'face', [0]), namespace: 'outdated-generation' },
    },
  };
  assert.throws(
    () => applyCommands(project, [{ type: 'project.update', payload: { name: 'Must roll back' } }, stale]),
    { code: 'STALE_SELECTION' },
  );
  assert.deepEqual(project, original);
  assert.throws(
    () =>
      applyCommands(project, [
        transform(project),
        { type: 'object.update', payload: { id: 'target', patch: { locked: true } } },
        transform(project),
      ]),
    /locked/i,
  );
  assert.deepEqual(project, original);
});

test('topology source edits respect locked object and scene ownership', () => {
  const project = fixture();
  project.objects[0].locked = true;
  assert.throws(() => applyCommands(project, [transform(project)]), /locked/i);
  project.objects[0].locked = false;
  const initialized = applyCommands(project, [{ type: 'production.initialize', payload: {} }]).project;
  const production = initialized.production!;
  const locked = applyCommands(initialized, [
    { type: 'scene.update', payload: { id: production.activeSceneId, patch: { locked: true } } },
  ]).project;
  const original = structuredClone(locked);
  assert.throws(() => applyCommands(locked, [transform(locked)]), /Scene is locked/i);
  assert.deepEqual(locked, original);
});

test('SQLite persists topology counters and mappings, supports idempotent replay, and exactly restores legacy undo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-topology-'));
  let store = new Store(directory);
  try {
    store.newProject('Topology history', 'empty');
    store.commands({ commands: commands() });
    const legacy = store.project();
    const request = {
      projectId: legacy.id,
      expectedRevision: legacy.revision,
      requestId: 'topology-one',
      commands: [transform(legacy)],
    };
    const applied = store.commands(request);
    const replay = store.commands(request);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.project, applied.project);
    assert.throws(() => store.commands({ ...request, requestId: 'topology-stale-revision' }), {
      code: 'REVISION_CONFLICT',
    });
    const result = structuredClone(applied.project);
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.project(), result);
    assert.deepEqual(store.commands(request).project, result);
    const undone = store.travel(-1, { projectId: result.id, expectedRevision: result.revision });
    assert.deepEqual(undone.objects, legacy.objects);
    assert.equal(topologySource(undone).identity, undefined);
    const redone = store.travel(1, { projectId: undone.id, expectedRevision: undone.revision });
    assert.deepEqual(redone.objects, result.objects);
    const current = store.project();
    assert.throws(() =>
      store.commands({
        projectId: current.id,
        expectedRevision: current.revision,
        commands: [
          { type: 'project.update', payload: { name: 'Not persisted' } },
          {
            type: 'topology.inset',
            payload: { id: 'target', selection: topologySelection(current, 'face', [3]), thickness: 999 },
          },
        ],
      }),
    );
    assert.deepEqual(store.project(), current);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function parentedFixture(): Project {
  return applyCommands(fixture(), [
    {
      type: 'object.create',
      payload: { id: 'parent', type: 'group', position: [4, 2, -3], rotation: [0, 0, 35], scale: [2, 1, 3] },
    },
    {
      type: 'object.update',
      payload: {
        id: 'target',
        patch: { parentId: 'parent', position: [1, 0, 2], rotation: [0, 25, 0], scale: [1, 0.7, 1.3] },
      },
    },
  ]).project;
}

test('affine selection matrices reproduce world-space gizmo rotation under rotated nonuniform parent scales', () => {
  const project = parentedFixture();
  const object = project.objects.find((value) => value.id === 'target')!;
  const world = modelingWorldMatrix(project, object);
  const pivot = new Vector3().applyMatrix4(world);
  const delta = new Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new Matrix4().makeRotationZ(0.25))
    .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  const local = world.clone().invert().multiply(delta).multiply(world);
  const result = applyCommands(project, [
    {
      type: 'topology.transform',
      payload: { id: 'target', selection: topologySelection(project, 'vertex'), matrix: local.toArray() },
    },
  ]).project;
  topologySource(project).vertices.forEach((vertex, index) => {
    const expected = new Vector3(...vertex).applyMatrix4(world).applyMatrix4(delta);
    const actual = new Vector3(...topologySource(result).vertices[index]).applyMatrix4(world);
    assert.ok(actual.distanceTo(expected) < 1e-8);
  });
  assert.deepEqual(result.objects.find((value) => value.id === 'target')!.rotation, object.rotation);
  assert.deepEqual(result.objects.find((value) => value.id === 'target')!.scale, object.scale);
});

test('matrix proportional editing interpolates the affine result using local connected distances', () => {
  const project = parentedFixture();
  const object = project.objects.find((value) => value.id === 'target')!;
  const world = modelingWorldMatrix(project, object);
  const delta = new Matrix4().makeTranslation(0.3, 0.2, -0.1);
  const local = world.clone().invert().multiply(delta).multiply(world);
  const selection = topologySelection(project, 'vertex', [0]);
  const result = applyCommands(project, [
    {
      type: 'topology.transform',
      payload: {
        id: 'target',
        selection,
        matrix: local.toArray(),
        proportional: { radius: 3, falloff: 'linear', connected: true },
      },
    },
  ]).project;
  for (const [index, weight] of [
    [0, 1],
    [1, 1 / 3],
    [2, 0],
    [4, 1 / 3],
  ] as const) {
    const point = new Vector3(...topologySource(project).vertices[index]).applyMatrix4(world);
    const expected = point.clone().lerp(point.clone().applyMatrix4(delta), weight);
    const actual = new Vector3(...topologySource(result).vertices[index]).applyMatrix4(world);
    assert.ok(actual.distanceTo(expected) < 1e-8, `Incorrect weight for vertex ${index}`);
  }
});

test('affine command rejects projective, singular, nonfinite and mixed-space transforms atomically', () => {
  const project = parentedFixture();
  const original = structuredClone(project);
  const matrix = new Matrix4().toArray();
  const projective = [...matrix];
  projective[3] = 0.01;
  const nonfinite = [...matrix];
  nonfinite[0] = Infinity;
  const base = { id: 'target', selection: topologySelection(project, 'vertex') };
  for (const payload of [
    { ...base, matrix: projective },
    { ...base, matrix: new Matrix4().makeScale(0, 1, 1).toArray() },
    { ...base, matrix: nonfinite },
    { ...base, matrix, translation: [1, 0, 0] },
    { ...base, matrix, space: 'world' },
    { ...base, matrix, snap: { translation: 0.1 } },
  ])
    assert.throws(() => applyCommands(project, [{ type: 'topology.transform', payload }]));
  assert.deepEqual(project, original);
});

test('normal-space face movement uses the selected roof normal instead of unselected incident wall normals', () => {
  let project = fixture();
  project = applyCommands(project, [
    { type: 'mesh.vertex.set', payload: { id: 'target', index: 2, position: [1, 0.4, -1] } },
    { type: 'mesh.vertex.set', payload: { id: 'target', index: 3, position: [-1, 0.4, -1] } },
  ]).project;
  const mesh = topologySource(project);
  const face = mesh.faces[3];
  const normal = meshFaceNormal(mesh, face).normalize();
  const result = applyCommands(project, [
    {
      type: 'topology.transform',
      payload: {
        id: 'target',
        selection: topologySelection(project, 'face', [3]),
        space: 'normal',
        translation: [0, 0, 0.2],
      },
    },
  ]).project;
  for (const vertex of face) {
    const delta = new Vector3(...topologySource(result).vertices[vertex]).sub(
      new Vector3(...mesh.vertices[vertex]),
    );
    assert.ok(delta.distanceTo(normal.clone().multiplyScalar(0.2)) < 1e-8);
  }
});

test('component numeric snapping reaches exact translation, rotation and scale endpoints without moving unselected vertices', () => {
  const project = fixture();
  const before = structuredClone(project);
  const selected = 6;
  for (const { settings, endpoint } of [
    { settings: { translation: [0.26, -0.14, 0.06], snap: { translation: 0.1 } }, endpoint: [1.3, 0.9, 1.1] },
    {
      settings: { rotation: [0, 0, 23], pivotMode: 'origin', snap: { rotation: 15 } },
      endpoint: [(Math.sqrt(3) - 1) / 2, (Math.sqrt(3) + 1) / 2, 1],
    },
    {
      settings: { scale: [1.26, 0.86, 1.06], pivotMode: 'origin', snap: { scale: 0.1 } },
      endpoint: [1.3, 0.9, 1.1],
    },
  ]) {
    const result = applyCommands(project, [
      {
        type: 'topology.transform',
        payload: { id: 'target', selection: topologySelection(project, 'vertex', [selected]), ...settings },
      },
    ]).project;
    topologySource(result).vertices.forEach((vertex, index) => {
      if (index === selected) assert.ok(new Vector3(...vertex).distanceTo(new Vector3(...endpoint)) < 1e-10);
      else assert.deepEqual(vertex, topologySource(project).vertices[index]);
    });
    assert.deepEqual(project, before);
  }
});
