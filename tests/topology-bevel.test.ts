import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { bevelMesh, buildTopology, diagnoseMesh, stableEdgeId, type TopologyMesh } from '../shared/topology';

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
function edgeSelection(mesh: TopologyMesh, pairs: [number, number][]) {
  const topology = buildTopology(mesh);
  return {
    namespace: topology.mesh.identity.namespace,
    kind: 'edge' as const,
    ids: pairs.map(([a, b]) =>
      stableEdgeId(topology.mesh.identity.vertexIds[a], topology.mesh.identity.vertexIds[b]),
    ),
  };
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
function close(actual: number, expected: number, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

test('single edge chamfer cuts an actual wedge and closes its endpoint miters', () => {
  const mesh = cube();
  const original = structuredClone(mesh);
  const result = bevelMesh(mesh, { selection: edgeSelection(mesh, [[2, 6]]), width: 0.2, segments: 1 });
  close(volume(result.mesh), 8 - 0.2 * 0.2);
  assert.equal(result.mesh.faces.length, 7);
  assert.equal(result.profiles.length, 1);
  const diagnostics = diagnoseMesh(result.mesh);
  assert.equal(diagnostics.closed, true);
  assert.equal(diagnostics.consistentlyOriented, true);
  assert.equal(diagnostics.selfIntersectingFaces.length, 0);
  assert.equal(result.changes.vertex.deleted.length, 2);
  assert.equal(result.changes.vertex.created.length, 4);
  assert.deepEqual(mesh, original);
});

test('rounded bevel segments lie on the specified circular cross-section and produce distinct facets', () => {
  const mesh = cube();
  const selection = edgeSelection(mesh, [[2, 6]]);
  const result = bevelMesh(mesh, { selection, width: 0.2, segments: 4, shape: 1 });
  const chamfer = bevelMesh(mesh, { selection, width: 0.2, segments: 1 });
  assert.equal(result.profiles.length, 4);
  assert.equal(result.mesh.faces.length, 10);
  assert.ok(volume(result.mesh) > volume(chamfer.mesh));
  const profileVertices = new Set(
    result.profiles.flatMap(
      (profile) => result.mesh.faces[result.mesh.identity.faceIds.indexOf(profile.faceId)],
    ),
  );
  for (const vertex of profileVertices) {
    const [x, y] = result.mesh.vertices[vertex];
    close(Math.hypot(x - 0.8, y - 0.8), 0.2);
  }
  const angles = [...profileVertices].map((vertex) =>
    Math.atan2(result.mesh.vertices[vertex][1] - 0.8, result.mesh.vertices[vertex][0] - 0.8),
  );
  assert.ok(angles.some((angle) => Math.abs(angle - Math.PI / 4) < 1e-7));
});

test('all cube edges produce a closed miter network without unfilled corner holes', () => {
  const mesh = cube();
  const result = bevelMesh(mesh, { width: 0.2, segments: 3 });
  const diagnostics = diagnoseMesh(result.mesh);
  assert.equal(result.beveledEdges.length, 12);
  assert.equal(result.profiles.length, 36);
  assert.equal(result.mesh.faces.length, 42);
  assert.equal(diagnostics.closed, true);
  assert.equal(diagnostics.consistentlyOriented, true);
  assert.equal(diagnostics.nonManifoldVertices.length, 0);
  assert.equal(diagnostics.looseVertices.length, 0);
  assert.equal(diagnostics.selfIntersectingFaces.length, 0);
  assert.ok(volume(result.mesh) < 8 && volume(result.mesh) > 7);
  const topology = buildTopology(result.mesh);
  assert.ok(
    topology.edges.every((edge) => edge.faces.length === 2 && edge.directions[0] !== edge.directions[1]),
  );
  assert.equal(result.cornerMode, 'miter');
});

test('adjacent selected edges share closed corner geometry while unselected edges remain addressable', () => {
  const mesh = cube();
  const selected = edgeSelection(mesh, [
    [2, 6],
    [3, 2],
  ]);
  const result = bevelMesh(mesh, { selection: selected, width: 0.15, segments: 2 });
  assert.equal(result.profiles.length, 4);
  assert.equal(diagnoseMesh(result.mesh).closed, true);
  const untouched = edgeSelection(mesh, [[0, 4]]).ids[0];
  assert.ok(result.changes.edge.preserved.includes(untouched));
  assert.ok(selected.ids.every((id) => result.changes.edge.deleted.includes(id)));
  assert.equal(result.changes.face.deleted.length, 0);
});

test('shape changes real bevel geometry and flat profile reports its effective segment count', () => {
  const mesh = cube();
  const selection = edgeSelection(mesh, [[2, 6]]);
  const flat = bevelMesh(mesh, { selection, width: 0.2, segments: 4, shape: 0 });
  const middle = bevelMesh(mesh, { selection, width: 0.2, segments: 4, shape: 0.5 });
  const round = bevelMesh(mesh, { selection, width: 0.2, segments: 4, shape: 1 });
  assert.equal(flat.effectiveSegments, 1);
  assert.equal(flat.profiles.length, 1);
  assert.ok(volume(flat.mesh) < volume(middle.mesh));
  assert.ok(volume(middle.mesh) < volume(round.mesh));
});

test('a skewed convex vehicle shell bevels in its actual face planes', () => {
  const mesh = cube();
  mesh.vertices = mesh.vertices.map(([x, y, z]) => [
    x * (y > 0 ? 0.65 : 1),
    y * 0.6,
    z * 2 + (y > 0 ? 0.15 : 0),
  ]);
  const before = volume(mesh);
  const result = bevelMesh(mesh, { width: 0.08, segments: 2 });
  assert.equal(diagnoseMesh(result.mesh).closed, true);
  assert.equal(result.profiles.length, 24);
  assert.ok(volume(result.mesh) < before);
});

test('open boundaries, concave shells and excessive width fail with actionable diagnostics and no mutation', () => {
  const mesh = cube();
  const original = structuredClone(mesh);
  const open = cube();
  open.faces.pop();
  assert.throws(
    () => bevelMesh(open, { width: 0.2 }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'BEVEL_REQUIRES_CLOSED');
      assert.ok((error as { details: { boundaryEdges: string[] } }).details.boundaryEdges.length > 0);
      return true;
    },
  );
  const inward = cube();
  inward.faces.forEach((face) => face.reverse());
  assert.throws(() => bevelMesh(inward, { width: 0.2 }), { code: 'NON_CONVEX_BEVEL' });
  assert.throws(
    () => bevelMesh(mesh, { width: 1.1, segments: 2 }),
    (error: unknown) =>
      ['BEVEL_OVERLAP', 'INVALID_BEVEL_WIDTH', 'UNRESOLVED_BEVEL_PROFILE'].includes(
        (error as { code: string }).code,
      ),
  );
  assert.throws(() => bevelMesh(mesh, { width: 0.2, segments: 17 }));
  assert.deepEqual(mesh, original);
});
