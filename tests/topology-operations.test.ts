import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import {
  bisectMesh,
  bridgeBoundaries,
  buildTopology,
  diagnoseMesh,
  dissolveEdges,
  dissolveVertices,
  extrudeFaces,
  fillBoundaries,
  insetFaces,
  loopCut,
  selectComponents,
  slideComponents,
  stableEdgeId,
  weldVertices,
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
function grid(columns = 3, rows = 3): TopologyMesh {
  const vertices: TopologyMesh['vertices'] = [];
  const faces: number[][] = [];
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) vertices.push([x, y, 0]);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const a = y * (columns + 1) + x;
      faces.push([a, a + 1, a + columns + 2, a + columns + 1]);
    }
  return { kind: 'mesh', vertices, faces, smooth: false };
}
function select(mesh: TopologyMesh, kind: ComponentSelection['kind'], indices: number[]): ComponentSelection {
  const topology = buildTopology(mesh);
  const ids =
    kind === 'vertex'
      ? topology.mesh.identity.vertexIds
      : kind === 'face'
        ? topology.mesh.identity.faceIds
        : topology.edges.map((edge) => edge.id);
  return { namespace: topology.mesh.identity.namespace, kind, ids: indices.map((index) => ids[index]) };
}
function edgeSelection(mesh: TopologyMesh, pairs: [number, number][]): ComponentSelection {
  const topology = buildTopology(mesh);
  return {
    namespace: topology.mesh.identity.namespace,
    kind: 'edge',
    ids: pairs.map(([a, b]) =>
      stableEdgeId(topology.mesh.identity.vertexIds[a], topology.mesh.identity.vertexIds[b]),
    ),
  };
}
function boundaries(mesh: TopologyMesh): ComponentSelection {
  const topology = buildTopology(mesh);
  return {
    namespace: topology.mesh.identity.namespace,
    kind: 'edge',
    ids: topology.edges.filter((edge) => edge.faces.length === 1).map((edge) => edge.id),
  };
}
function volume(mesh: TopologyMesh): number {
  let value = 0;
  for (const face of mesh.faces)
    for (let corner = 1; corner < face.length - 1; corner++) {
      const a = new Vector3(...mesh.vertices[face[0]]);
      const b = new Vector3(...mesh.vertices[face[corner]]);
      const c = new Vector3(...mesh.vertices[face[corner + 1]]);
      value += a.dot(b.cross(c)) / 6;
    }
  return value;
}
function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
}

test('region extrusion preserves a closed solid and maps duplicated vertices while retaining cap face IDs', () => {
  const mesh = cube();
  const original = structuredClone(mesh);
  const selection = select(mesh, 'face', [3]);
  const result = extrudeFaces(mesh, { selection, distance: 1 });
  close(volume(result.mesh), 12);
  assert.equal(diagnoseMesh(result.mesh).closed, true);
  assert.equal(result.mesh.faces.length, 10);
  assert.equal(result.changes.vertex.created.length, 4);
  assert.deepEqual(result.changes.face.replacements[selection.ids[0]], [selection.ids[0]]);
  assert.ok(Object.values(result.changes.vertex.replacements).some((ids) => ids.length === 2));
  assert.deepEqual(mesh, original);
});

test('region extrusion omits internal walls and individual extrusion creates one wall set per face', () => {
  const mesh = grid(2, 1);
  const selection = select(mesh, 'face', [0, 1]);
  const region = extrudeFaces(mesh, { selection, distance: 1, mode: 'region' });
  const individual = extrudeFaces(mesh, { selection, distance: 1, mode: 'individual' });
  assert.equal(region.mesh.faces.length, 8);
  assert.equal(individual.mesh.faces.length, 10);
  assert.equal(region.changes.vertex.created.length, 6);
  assert.equal(individual.changes.vertex.created.length, 8);
  const full = grid();
  const all = extrudeFaces(full, {
    selection: select(
      full,
      'face',
      full.faces.map((_, index) => index),
    ),
    distance: 1,
  });
  assert.equal(all.changes.vertex.deleted.length, 4);
  assert.equal(diagnoseMesh(all.mesh).looseVertices.length, 0);
});

test('true inset offsets boundary edges in their plane and depth changes the enclosed volume', () => {
  const mesh = cube();
  const selection = select(mesh, 'face', [3]);
  const result = insetFaces(mesh, { selection, thickness: 0.25, depth: -0.5 });
  assert.equal(result.mesh.faces.length, 10);
  assert.equal(diagnoseMesh(result.mesh).closed, true);
  const capIndex = result.mesh.identity.faceIds.indexOf(selection.ids[0]);
  const cap = result.mesh.faces[capIndex].map((vertex) => result.mesh.vertices[vertex]);
  cap.forEach(([x, y, z]) => {
    close(Math.abs(x), 0.75);
    close(y, 0.5);
    close(Math.abs(z), 0.75);
  });
  assert.ok(volume(result.mesh) < 8);
  assert.throws(() => insetFaces(mesh, { selection, thickness: 1.5 }), { code: 'INVALID_INSET' });
  assert.throws(() => insetFaces(mesh, { selection: select(mesh, 'face', [1, 3]), thickness: 0.1 }), {
    code: 'NON_PLANAR_SELECTION',
  });
});

test('region inset keeps the connected interior and does not create internal walls', () => {
  const mesh = grid(2, 1);
  const region = insetFaces(mesh, { selection: select(mesh, 'face', [0, 1]), thickness: 0.1 });
  const individual = insetFaces(mesh, {
    selection: select(mesh, 'face', [0, 1]),
    thickness: 0.1,
    mode: 'individual',
  });
  assert.equal(region.mesh.faces.length, 8);
  assert.equal(individual.mesh.faces.length, 10);
  assert.equal(diagnoseMesh(region.mesh).nonManifoldEdges.length, 0);
});

test('filling an actual hole restores winding and closed volume with polygon or triangulated caps', () => {
  const mesh = cube();
  mesh.faces.splice(3, 1);
  for (const triangulate of [false, true]) {
    const result = fillBoundaries(mesh, { selection: boundaries(mesh), triangulate });
    assert.equal(diagnoseMesh(result.mesh).closed, true);
    assert.equal(diagnoseMesh(result.mesh).consistentlyOriented, true);
    close(volume(result.mesh), 8);
  }
  assert.throws(
    () => fillBoundaries(mesh, { selection: { ...boundaries(mesh), ids: boundaries(mesh).ids.slice(0, 2) } }),
    { code: 'INCOMPLETE_BOUNDARY' },
  );
});

test('bridge connects two boundary loops with coherent orientation and intermediate segments', () => {
  const mesh = cube();
  mesh.faces = [mesh.faces[0], mesh.faces[1]];
  const result = bridgeBoundaries(mesh, { selection: boundaries(mesh), segments: 3 });
  assert.equal(result.mesh.faces.length, 14);
  assert.equal(result.changes.vertex.created.length, 8);
  assert.equal(diagnoseMesh(result.mesh).closed, true);
  assert.equal(diagnoseMesh(result.mesh).consistentlyOriented, true);
  close(volume(result.mesh), 8);
  const one = { ...mesh, faces: [mesh.faces[0]] };
  assert.throws(() => bridgeBoundaries(one, { selection: boundaries(one) }), /exactly two/);
});

test('weld joins duplicate triangle corners, retains oldest vertex identities and maps every old edge', () => {
  const mesh: TopologyMesh = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
    faces: [
      [0, 1, 2],
      [3, 4, 5],
    ],
  };
  const result = weldVertices(mesh, {
    selection: select(mesh, 'vertex', [0, 1, 2, 3, 4, 5]),
    tolerance: 1e-6,
  });
  assert.equal(result.mesh.vertices.length, 4);
  assert.equal(result.mergedGroups.length, 2);
  assert.equal(diagnoseMesh(result.mesh).counts.connectedComponents, 1);
  assert.equal(diagnoseMesh(result.mesh).boundaryEdges.length, 4);
  const old = buildTopology(mesh).mesh.identity;
  assert.deepEqual(result.changes.vertex.replacements[old.vertexIds[3]], [old.vertexIds[0]]);
  assert.equal(result.changes.vertex.deleted.length, 2);
  assert.deepEqual(mesh.identity, undefined);
});

test('dissolve merges only selected coplanar face regions and retains a stable surviving face', () => {
  const mesh = grid(2, 1);
  const result = dissolveEdges(mesh, { selection: edgeSelection(mesh, [[1, 4]]) });
  assert.equal(result.mesh.faces.length, 1);
  assert.equal(result.mesh.faces[0].length, 6);
  assert.equal(result.changes.face.deleted.length, 1);
  assert.equal(
    Object.values(result.changes.face.replacements).every(
      (ids) => ids[0] === result.mesh.identity.faceIds[0],
    ),
    true,
  );
  const solid = cube();
  assert.throws(() => dissolveEdges(solid, { selection: edgeSelection(solid, [[0, 1]]) }), {
    code: 'NON_PLANAR_SELECTION',
  });
  assert.throws(() => dissolveEdges(mesh, { selection: boundaries(mesh) }), { code: 'NOT_INTERIOR_EDGE' });
});

test('vertex dissolve removes collinear subdivisions without changing the polygon silhouette', () => {
  const mesh: TopologyMesh = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [0.5, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
    faces: [[0, 1, 2, 3, 4]],
  };
  const result = dissolveVertices(mesh, { selection: select(mesh, 'vertex', [1]) });
  assert.equal(result.mesh.vertices.length, 4);
  assert.equal(result.mesh.faces[0].length, 4);
  assert.throws(() => dissolveVertices(mesh, { selection: select(mesh, 'vertex', [0]) }), {
    code: 'NON_COLLINEAR_VERTEX',
  });
});

test('loop cut creates conforming quad strips with no loose vertices and explicit one-to-many maps', () => {
  const mesh = grid(3, 2);
  const result = loopCut(mesh, { selection: edgeSelection(mesh, [[5, 6]]), cuts: 2, slide: 0.2 });
  assert.equal(result.mesh.faces.length, 10);
  assert.equal(result.changes.vertex.created.length, 6);
  assert.equal(result.changes.face.created.length, 4);
  assert.equal(diagnoseMesh(result.mesh).looseVertices.length, 0);
  assert.equal(diagnoseMesh(result.mesh).nonManifoldEdges.length, 0);
  assert.ok(Object.values(result.changes.edge.replacements).some((ids) => ids.length === 3));
  assert.ok(Object.values(result.changes.face.replacements).some((ids) => ids.length === 3));
  const changed = result.mesh.vertices.filter((_, index) =>
    result.changes.vertex.created.includes(result.mesh.identity.vertexIds[index]),
  );
  changed.forEach(([x]) => assert.ok(Math.abs(x - 1.4) < 1e-8 || Math.abs(x - 1.7333333333333334) < 1e-8));
});

test('loop cut on a closed cube preserves manifold volume and accepts subsequent loop editing', () => {
  const mesh = cube();
  const result = loopCut(mesh, { selection: edgeSelection(mesh, [[0, 1]]), cuts: 1 });
  assert.equal(diagnoseMesh(result.mesh).closed, true);
  close(volume(result.mesh), 8);
  const newEdges = result.changes.edge.created.filter(
    (id) => !Object.values(result.changes.edge.replacements).some((ids) => ids.includes(id)),
  );
  const loop = selectComponents(result.mesh, {
    namespace: result.mesh.identity.namespace,
    kind: 'edge',
    ids: [newEdges[0]],
    operation: 'loop',
  });
  const slid = slideComponents(result.mesh, { selection: loop, amount: 0.25 });
  assert.equal(diagnoseMesh(slid.mesh).closed, true);
  close(volume(slid.mesh), 8);
  assert.ok(slid.rails.length > 0);
});

test('edge slide follows consistent side rails across an open strip', () => {
  const mesh = grid(3, 2);
  const edges = edgeSelection(mesh, [
    [4, 5],
    [5, 6],
    [6, 7],
  ]);
  const result = slideComponents(mesh, { selection: edges, amount: 0.5 });
  const heights = [4, 5, 6, 7].map((index) => result.mesh.vertices[index][1]);
  assert.ok(heights.every((value) => Math.abs(value - heights[0]) < 1e-8));
  assert.ok(Math.abs(heights[0] - 1) === 0.5);
  assert.throws(() => slideComponents(mesh, { selection: edges, amount: 1 }));
});

test('bisect produces a capped half solid and preserves exact plane intersections', () => {
  const mesh = cube();
  const original = structuredClone(mesh);
  for (const keep of ['positive', 'negative'] as const) {
    const result = bisectMesh(mesh, { normal: [1, 0, 0], offset: 0, keep, fill: true });
    close(volume(result.mesh), 4);
    const diagnostics = diagnoseMesh(result.mesh);
    assert.equal(diagnostics.closed, true);
    assert.equal(diagnostics.consistentlyOriented, true);
    assert.ok(result.mesh.vertices.every(([x]) => (keep === 'positive' ? x >= 0 : x <= 0)));
    assert.equal(result.changes.vertex.created.length, 4);
    assert.equal(result.changes.vertex.deleted.length, 4);
  }
  assert.deepEqual(mesh, original);
});

test('bisect both sides retains a closed surface and reuses cut vertices between adjacent faces', () => {
  const mesh = cube();
  const result = bisectMesh(mesh, { normal: [2, 0, 0], offset: 0.5, keep: 'both' });
  close(volume(result.mesh), 8);
  assert.equal(diagnoseMesh(result.mesh).closed, true);
  assert.equal(result.changes.vertex.created.length, 4);
  assert.equal(result.changes.face.created.length, 4);
  const created = new Set(result.changes.vertex.created);
  result.mesh.vertices.forEach(([x], index) => {
    if (created.has(result.mesh.identity.vertexIds[index])) close(x, 0.25);
  });
  assert.throws(() => bisectMesh(mesh, { normal: [0, 0, 0], offset: 0 }));
  assert.throws(() => bisectMesh(mesh, { normal: [1, 0, 0], offset: 0, fill: true }));
});
