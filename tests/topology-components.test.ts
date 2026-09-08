import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTopology,
  deleteComponents,
  diagnoseMesh,
  mergeVertices,
  splitFaces,
  type ComponentSelection,
  type TopologyMesh,
} from '../shared/topology';

function grid(): TopologyMesh {
  return {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [2, 1, 0],
    ],
    faces: [
      [0, 1, 4, 3],
      [1, 2, 5, 4],
    ],
  };
}
function select(mesh: TopologyMesh, kind: ComponentSelection['kind'], indices: number[]): ComponentSelection {
  const topology = buildTopology(mesh);
  const ids =
    kind === 'face'
      ? topology.mesh.identity.faceIds
      : kind === 'vertex'
        ? topology.mesh.identity.vertexIds
        : topology.edges.map((edge) => edge.id);
  return { namespace: topology.mesh.identity.namespace, kind, ids: indices.map((index) => ids[index]) };
}

test('splitting a selected region duplicates only shared boundary vertices and preserves face IDs', () => {
  const mesh = grid();
  const original = structuredClone(mesh);
  const result = splitFaces(mesh, { selection: select(mesh, 'face', [0]) });
  assert.equal(result.mesh.vertices.length, 8);
  assert.equal(result.mesh.faces.length, 2);
  assert.equal(result.changes.vertex.created.length, 2);
  assert.equal(result.changes.vertex.deleted.length, 0);
  assert.equal(result.changes.face.created.length, 0);
  assert.equal(diagnoseMesh(result.mesh).counts.connectedComponents, 2);
  assert.deepEqual(result.mesh.faces[1], mesh.faces[1]);
  assert.ok(Object.values(result.changes.vertex.replacements).some((ids) => ids.length === 2));
  assert.deepEqual(mesh, original);
});

test('individual splitting separates neighboring selected faces while boundary splitting keeps their connection', () => {
  const mesh = grid();
  const selection = select(mesh, 'face', [0, 1]);
  const boundary = splitFaces(mesh, { selection, mode: 'boundary' });
  assert.equal(boundary.changes.vertex.created.length, 0);
  const individual = splitFaces(mesh, { selection, mode: 'individual' });
  assert.equal(diagnoseMesh(individual.mesh).counts.connectedComponents, 2);
  assert.equal(diagnoseMesh(individual.mesh).looseVertices.length, 0);
  assert.equal(individual.changes.vertex.deleted.length, 2);
  assert.equal(individual.changes.vertex.created.length, 4);
});

test('vertex and edge deletion require an explicit incident face policy and reject atomically', () => {
  const mesh = grid();
  const original = structuredClone(mesh);
  const selection = select(mesh, 'vertex', [0]);
  assert.throws(() => deleteComponents(mesh, { selection }), { code: 'INCIDENT_FACE_POLICY_REQUIRED' });
  assert.throws(() => deleteComponents(mesh, { selection, incidentFaces: 'reject' }), {
    code: 'INCIDENT_FACES',
  });
  const result = deleteComponents(mesh, { selection, incidentFaces: 'delete', removeLooseVertices: true });
  assert.equal(result.mesh.faces.length, 1);
  assert.equal(result.mesh.vertices.length, 4);
  assert.equal(result.changes.face.deleted.length, 1);
  assert.equal(result.changes.vertex.deleted.length, 2);
  const topology = buildTopology(mesh);
  const interior = topology.edges.findIndex((edge) => edge.faces.length === 2);
  assert.throws(
    () => deleteComponents(mesh, { selection: select(mesh, 'edge', [interior]), incidentFaces: 'delete' }),
    { code: 'EMPTY_MESH' },
  );
  assert.deepEqual(mesh, original);
});

test('face deletion removes local loose vertices only when requested', () => {
  const mesh = grid();
  mesh.vertices.push([9, 9, 9]);
  const selection = select(mesh, 'face', [0]);
  const kept = deleteComponents(mesh, { selection });
  assert.equal(kept.mesh.vertices.length, 7);
  const clean = deleteComponents(mesh, { selection, removeLooseVertices: true });
  assert.equal(clean.mesh.vertices.length, 5);
  assert.deepEqual(clean.mesh.vertices.at(-1), [9, 9, 9]);
});

test('merge first follows ordered selection, center averages, and cursor uses an explicit position', () => {
  const mesh = grid();
  const selection = select(mesh, 'vertex', [1, 0]);
  const first = mergeVertices(mesh, { selection, target: 'first' });
  assert.equal(first.mergedInto, selection.ids[0]);
  const index = first.mesh.identity.vertexIds.indexOf(first.mergedInto);
  assert.deepEqual(first.mesh.vertices[index], [1, 0, 0]);
  assert.equal(first.mesh.faces[0].length, 3);
  assert.deepEqual(first.changes.vertex.replacements[selection.ids[1]], [selection.ids[0]]);
  const center = mergeVertices(mesh, { selection, target: 'center' });
  assert.deepEqual(
    center.mesh.vertices[center.mesh.identity.vertexIds.indexOf(center.mergedInto)],
    [0.5, 0, 0],
  );
  const cursor = mergeVertices(mesh, { selection, target: 'cursor', position: [0.7, 0.1, 0] });
  assert.deepEqual(
    cursor.mesh.vertices[cursor.mesh.identity.vertexIds.indexOf(cursor.mergedInto)],
    [0.7, 0.1, 0],
  );
  assert.throws(() => mergeVertices(mesh, { selection, target: 'cursor' }));
});

test('merge can explicitly reject collapsed faces and never commits partial geometry', () => {
  const mesh = grid();
  const original = structuredClone(mesh);
  const selection = select(mesh, 'vertex', [0, 1, 4]);
  assert.throws(() => mergeVertices(mesh, { selection, target: 'center', collapseFaces: 'reject' }), {
    code: 'COLLAPSED_FACE',
  });
  const result = mergeVertices(mesh, { selection, target: 'center', collapseFaces: 'remove' });
  assert.equal(result.mesh.faces.length, 1);
  assert.equal(result.changes.face.deleted.length, 1);
  assert.deepEqual(mesh, original);
});
