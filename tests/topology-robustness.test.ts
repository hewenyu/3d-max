import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import {
  bisectMesh,
  buildTopology,
  diagnoseMesh,
  fillBoundaries,
  insetFaces,
  repairMesh,
  selectComponents,
  stableEdgeId,
  type ComponentSelection,
  type TopologyMesh,
} from '../shared/topology';

function cube(): TopologyMesh {
  return {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
    faces: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [3, 7, 6, 2],
      [0, 4, 7, 3],
      [1, 2, 6, 5],
    ],
  };
}
function all(mesh: TopologyMesh, kind: ComponentSelection['kind']): ComponentSelection {
  const topology = buildTopology(mesh);
  return {
    namespace: topology.mesh.identity.namespace,
    kind,
    ids:
      kind === 'face'
        ? topology.mesh.identity.faceIds
        : kind === 'vertex'
          ? topology.mesh.identity.vertexIds
          : topology.edges.map((edge) => edge.id),
  };
}
function area(mesh: TopologyMesh): number {
  let value = 0;
  for (const face of mesh.faces)
    for (let index = 1; index < face.length - 1; index++) {
      const a = new Vector3(...mesh.vertices[face[0]]);
      const b = new Vector3(...mesh.vertices[face[index]]);
      const c = new Vector3(...mesh.vertices[face[index + 1]]);
      value += b.sub(a).cross(c.sub(a)).z / 2;
    }
  return value;
}
function volume(mesh: TopologyMesh): number {
  let value = 0;
  for (const face of mesh.faces)
    for (let index = 1; index < face.length - 1; index++)
      value +=
        new Vector3(...mesh.vertices[face[0]]).dot(
          new Vector3(...mesh.vertices[face[index]]).cross(new Vector3(...mesh.vertices[face[index + 1]])),
        ) / 6;
  return value;
}
function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
}

test('concave polygon bisection preserves area without connecting separated clipped islands', () => {
  const mesh: TopologyMesh = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [3, 0, 0],
      [3, 1, 0],
      [1, 1, 0],
      [1, 3, 0],
      [0, 3, 0],
    ],
    faces: [[0, 1, 2, 3, 4, 5]],
  };
  const positive = bisectMesh(mesh, { normal: [1, 0, 0], offset: 1.5, keep: 'positive' });
  const negative = bisectMesh(mesh, { normal: [1, 0, 0], offset: 1.5, keep: 'negative' });
  close(area(positive.mesh), 1.5);
  close(area(negative.mesh), 3.5);
  assert.equal(diagnoseMesh(positive.mesh).nonManifoldEdges.length, 0);
  assert.equal(diagnoseMesh(negative.mesh).selfIntersectingFaces.length, 0);
  const u: TopologyMesh = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [3, 0, 0],
      [3, 3, 0],
      [2, 3, 0],
      [2, 1, 0],
      [1, 1, 0],
      [1, 3, 0],
      [0, 3, 0],
    ],
    faces: [[0, 1, 2, 3, 4, 5, 6, 7]],
  };
  const separated = bisectMesh(u, { normal: [0, 1, 0], offset: 2, keep: 'positive' });
  close(area(separated.mesh), 2);
  assert.equal(diagnoseMesh(separated.mesh).counts.connectedComponents, 2);
});

test('plane through existing edges and vertices produces no duplicate cut vertices or degenerate faces', () => {
  const mesh = cube();
  const result = bisectMesh(mesh, { normal: [1, 1, 0], offset: 0, keep: 'positive', fill: true });
  close(volume(result.mesh), 4);
  assert.equal(diagnoseMesh(result.mesh).closed, true);
  assert.equal(result.changes.vertex.created.length, 0);
  assert.equal(diagnoseMesh(result.mesh).degenerateFaces.length, 0);
  const untouched = bisectMesh(mesh, { normal: [1, 0, 0], offset: -4, keep: 'positive' });
  assert.deepEqual(untouched.mesh.faces, mesh.faces);
  assert.deepEqual(untouched.mesh.vertices, mesh.vertices);
});

test('hollow tube caps preserve the inner void using triangulated nested boundary loops', () => {
  const vertices: TopologyMesh['vertices'] = [];
  for (const z of [0, 2])
    for (const radius of [2, 1])
      for (const [x, y] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ])
        vertices.push([x * radius, y * radius, z]);
  const faces: number[][] = [];
  for (let index = 0; index < 4; index++) {
    const next = (index + 1) % 4;
    faces.push([index, next, next + 8, index + 8]);
    faces.push([index + 4, index + 12, next + 12, next + 4]);
  }
  const mesh: TopologyMesh = { kind: 'mesh', smooth: false, vertices, faces };
  const topology = buildTopology(mesh);
  const selection = {
    ...all(mesh, 'edge'),
    ids: topology.edges.filter((edge) => edge.faces.length === 1).map((edge) => edge.id),
  };
  const result = fillBoundaries(mesh, { selection });
  close(volume(result.mesh), 24);
  const diagnostics = diagnoseMesh(result.mesh);
  assert.equal(diagnostics.closed, true);
  assert.equal(diagnostics.consistentlyOriented, true);
  assert.equal(diagnostics.duplicateFaces.length, 0);
  const half = bisectMesh(result.mesh, { normal: [0, 0, 1], offset: 1, keep: 'positive', fill: true });
  close(volume(half.mesh), 12);
  assert.equal(diagnoseMesh(half.mesh).closed, true);
});

test('diagnostics expose a self-intersecting face even when Newell area remains nonzero', () => {
  const mesh: TopologyMesh = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [3, 2, 0],
      [0, 2, 0],
      [1, 0, 0],
    ],
    faces: [[0, 1, 2, 3]],
  };
  assert.equal(diagnoseMesh(mesh).selfIntersectingFaces.length, 1);
  assert.throws(() => insetFaces(mesh, { selection: all(mesh, 'face'), thickness: 0.1 }), /simple/);
});

test('orientation repair fixes a closed solid globally and reports unchanged stable face IDs', () => {
  const mesh = cube();
  mesh.faces[0].reverse();
  mesh.faces[3].reverse();
  assert.ok(diagnoseMesh(mesh).inconsistentEdges.length > 0);
  const result = repairMesh(mesh, { orientFaces: 'outward' });
  close(volume(result.mesh), 8);
  assert.equal(diagnoseMesh(result.mesh).consistentlyOriented, true);
  assert.equal(result.flippedFaces.length, 2);
  assert.equal(result.changes.face.deleted.length, 0);
  const inverted = cube();
  inverted.faces.forEach((face) => face.reverse());
  close(volume(repairMesh(inverted, { orientFaces: 'outward' }).mesh), 8);
});

test('partial orientation repair uses untouched neighboring faces as fixed constraints', () => {
  const mesh = cube();
  mesh.faces[1].reverse();
  const selection = all(mesh, 'face');
  selection.ids = [selection.ids[1]];
  const original = structuredClone(mesh);
  const result = repairMesh(mesh, { selection, orientFaces: 'consistent' });
  assert.equal(result.flippedFaces.length, 1);
  assert.equal(diagnoseMesh(result.mesh).consistentlyOriented, true);
  for (const index of [0, 2, 3, 4, 5]) assert.deepEqual(result.mesh.faces[index], original.faces[index]);
  assert.throws(() => repairMesh(mesh, { selection, orientFaces: 'outward' }), { code: 'OPEN_COMPONENT' });
});

test('scoped cleanup removes only selected duplicate and loose components, preserving surviving ID maps', () => {
  const mesh = cube();
  mesh.faces.push([...mesh.faces[0]].reverse());
  mesh.vertices.push([9, 9, 9]);
  const faces = all(mesh, 'face');
  const duplicate = faces.ids.at(-1)!;
  faces.ids = [duplicate];
  const result = repairMesh(mesh, {
    selection: faces,
    removeDuplicateFaces: true,
    removeLooseVertices: true,
  });
  assert.equal(result.mesh.faces.length, 6);
  assert.equal(result.mesh.vertices.length, 9);
  assert.deepEqual(result.changes.face.replacements[duplicate], [result.mesh.identity.faceIds[0]]);
  const clean = repairMesh(result.mesh, { removeLooseVertices: true });
  assert.equal(clean.mesh.vertices.length, 8);
  assert.equal(clean.changes.vertex.deleted.length, 1);
});

test('degenerate cleanup is explicit and impossible repair leaves the input intact', () => {
  const mesh = cube();
  mesh.vertices.push([0, 0, 0], [1, 0, 0], [2, 0, 0]);
  mesh.faces.push([8, 9, 10]);
  const original = structuredClone(mesh);
  const result = repairMesh(mesh, { removeDegenerateFaces: true, removeLooseVertices: true });
  assert.equal(result.mesh.faces.length, 6);
  assert.equal(result.mesh.vertices.length, 8);
  assert.deepEqual(mesh, original);
  assert.throws(() => repairMesh(mesh, {}));
  const open: TopologyMesh = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    faces: [[0, 1, 2]],
  };
  assert.throws(() => repairMesh(open, { orientFaces: 'outward' }), { code: 'OPEN_COMPONENT' });
});

test('edge ring selection stops explicitly at non-quad faces instead of guessing a continuation', () => {
  const mesh: TopologyMesh = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [2, 0, 0],
    ],
    faces: [
      [0, 1, 2, 3],
      [1, 4, 2],
    ],
  };
  const topology = buildTopology(mesh);
  const seed = stableEdgeId(topology.mesh.identity.vertexIds[0], topology.mesh.identity.vertexIds[3]);
  const result = selectComponents(mesh, {
    namespace: topology.mesh.identity.namespace,
    kind: 'edge',
    ids: [seed],
    operation: 'ring',
  });
  assert.equal(result.ids.length, 2);
  assert.ok(result.stopped.some((stop) => stop.reason === 'non-quad'));
});
