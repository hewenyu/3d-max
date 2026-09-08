import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MeshEditor,
  buildTopology,
  diagnoseMesh,
  ensureMeshIdentity,
  meshIdentitySchema,
  selectComponents,
  stableEdgeId,
  transformComponents,
  type ComponentSelection,
  type TopologyMesh,
} from '../shared/topology';

function grid(columns = 3, rows = 3): TopologyMesh {
  const vertices: TopologyMesh['vertices'] = [];
  const faces: number[][] = [];
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) vertices.push([x, y, 0]);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const start = y * (columns + 1) + x;
      faces.push([start, start + 1, start + columns + 2, start + columns + 1]);
    }
  return { kind: 'mesh', vertices, faces, smooth: false };
}

function selection(
  mesh: TopologyMesh,
  kind: ComponentSelection['kind'],
  indices: number[],
): ComponentSelection {
  const topology = buildTopology(mesh);
  const ids =
    kind === 'vertex'
      ? topology.mesh.identity.vertexIds
      : kind === 'face'
        ? topology.mesh.identity.faceIds
        : topology.edges.map((edge) => edge.id);
  return { namespace: topology.mesh.identity.namespace, kind, ids: indices.map((index) => ids[index]) };
}

test('legacy geometry receives deterministic read-only identity; real edits retain IDs and allocation never reuses deleted IDs', () => {
  const legacy = grid(1, 1);
  const original = structuredClone(legacy);
  const first = ensureMeshIdentity(legacy);
  assert.deepEqual(first, ensureMeshIdentity(legacy));
  assert.deepEqual(legacy, original);
  assert.equal(legacy.identity, undefined);
  const editor = new MeshEditor(first);
  const added = editor.addVertex([2, 0, 0]);
  const addedId = editor.mesh.identity.vertexIds[added];
  editor.removeVertices([added]);
  const next = editor.addVertex([3, 0, 0]);
  assert.notEqual(editor.mesh.identity.vertexIds[next], addedId);
  const result = editor.finish();
  assert.deepEqual(result.changes.vertex.preserved, first.identity.vertexIds);
  assert.equal(result.changes.vertex.created.length, 1);
  assert.deepEqual(result.changes.vertex.deleted, []);
  assert.equal(result.mesh.identity.namespace, first.identity.namespace);
  assert.ok(result.mesh.identity.nextId > first.identity.nextId);
  assert.deepEqual(legacy, original);
});

test('identity schema rejects reused numbers, invalid counters and stale geometry metadata', () => {
  const mesh = ensureMeshIdentity(grid(1, 1));
  assert.equal(meshIdentitySchema.safeParse({ ...mesh.identity, nextId: 1 }).success, false);
  assert.equal(meshIdentitySchema.safeParse({ ...mesh.identity, faceIds: ['f1'] }).success, false);
  assert.equal(
    meshIdentitySchema.safeParse({ ...mesh.identity, namespace: 'invalid:namespace' }).success,
    false,
  );
  assert.throws(() => ensureMeshIdentity({ ...mesh, vertices: mesh.vertices.slice(1) }), {
    code: 'INVALID_IDENTITY',
  });
  assert.throws(() => ensureMeshIdentity(mesh, 'other'), { code: 'STALE_SELECTION' });
});

test('stable vertex and edge identity survives index compaction with explicit removed mappings', () => {
  const mesh = ensureMeshIdentity({
    ...grid(1, 1),
    vertices: [[9, 9, 9], ...grid(1, 1).vertices],
    faces: [[1, 2, 4, 3]],
  });
  const before = buildTopology(mesh);
  const editor = new MeshEditor(mesh);
  editor.removeVertices([0]);
  const result = editor.finish();
  assert.equal(result.mesh.identity.vertexIds[0], mesh.identity.vertexIds[1]);
  assert.deepEqual(result.mesh.faces, [[0, 1, 3, 2]]);
  assert.deepEqual(result.changes.vertex.deleted, [mesh.identity.vertexIds[0]]);
  assert.deepEqual(result.changes.vertex.replacements[mesh.identity.vertexIds[0]], []);
  assert.deepEqual(
    result.changes.edge.preserved,
    before.edges.map((edge) => edge.id),
  );
  assert.equal(stableEdgeId('v10', 'v2'), 'e:v2:v10');
});

test('adjacency records oriented shared edges and rejects structural errors before traversal', () => {
  const topology = buildTopology(grid(2, 1));
  assert.equal(topology.edges.length, 7);
  const shared = topology.edges.find((edge) => edge.faces.length === 2)!;
  assert.equal(shared.directions[0], -shared.directions[1]);
  assert.equal(topology.vertexFaces[1].length, 2);
  assert.throws(() => buildTopology({ ...grid(1, 1), faces: [[0, 0, 2]] }), { code: 'INVALID_FACE' });
  assert.throws(() => buildTopology({ ...grid(1, 1), faces: [[0, 1, 99]] }), { code: 'INVALID_FACE' });
  assert.throws(() =>
    buildTopology({
      ...grid(1, 1),
      vertices: [
        [Infinity, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    }),
  );
});

test('face selection grows through shared edges, shrinks boundaries and inverts deterministically', () => {
  const mesh = grid();
  const center = selection(mesh, 'face', [4]);
  const grown = selectComponents(mesh, { ...center, operation: 'grow' });
  assert.deepEqual(grown.indices, [1, 3, 4, 5, 7]);
  assert.deepEqual(selectComponents(mesh, { ...grown, operation: 'shrink' }).indices, [4]);
  assert.deepEqual(
    selectComponents(mesh, { ...center, operation: 'invert' }).indices,
    [0, 1, 2, 3, 5, 6, 7, 8],
  );
  assert.equal(selectComponents(mesh, { ...center, operation: 'connected' }).ids.length, 9);
  assert.throws(() => selectComponents(mesh, { ...center, namespace: 'stale', operation: 'grow' }), {
    code: 'STALE_SELECTION',
  });
  assert.throws(() => selectComponents(mesh, { ...center, ids: ['f999'], operation: 'grow' }), {
    code: 'COMPONENT_NOT_FOUND',
  });
});

test('edge loops follow the quad strip while rings cross opposite quad edges and stop at boundaries', () => {
  const mesh = grid(3, 2);
  const topology = buildTopology(mesh);
  const edgeId = stableEdgeId(topology.mesh.identity.vertexIds[5], topology.mesh.identity.vertexIds[6]);
  const seed = { namespace: topology.mesh.identity.namespace, kind: 'edge' as const, ids: [edgeId] };
  const loop = selectComponents(mesh, { ...seed, operation: 'loop' });
  assert.equal(loop.ids.length, 3);
  for (const index of loop.indices)
    assert.ok(topology.edges[index].vertices.every((vertex) => mesh.vertices[vertex][1] === 1));
  const ring = selectComponents(mesh, { ...seed, operation: 'ring' });
  assert.equal(ring.ids.length, 3);
  for (const index of ring.indices)
    assert.deepEqual(topology.edges[index].vertices.map((vertex) => mesh.vertices[vertex][0]).sort(), [1, 2]);
  assert.ok(ring.stopped.some((stop) => stop.reason === 'boundary'));
  assert.throws(() => selectComponents(mesh, { ...selection(mesh, 'face', [0]), operation: 'loop' }));
});

test('diagnostics distinguish disconnected, non-manifold, reversed and degenerate geometry', () => {
  const mesh: TopologyMesh = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, 0],
      [8, 8, 8],
    ],
    faces: [
      [0, 1, 2],
      [0, 1, 3],
      [1, 0, 4],
    ],
  };
  const diagnostics = diagnoseMesh(mesh);
  assert.equal(diagnostics.nonManifoldEdges.length, 1);
  assert.equal(diagnostics.nonManifoldVertices.length, 2);
  assert.equal(diagnostics.duplicateVertices.length, 1);
  assert.equal(diagnostics.looseVertices.length, 2);
  assert.equal(diagnostics.closed, false);
  assert.equal(diagnostics.counts.connectedComponents, 3);
  const reversed = diagnoseMesh({ ...mesh, faces: mesh.faces.slice(0, 2) });
  assert.equal(reversed.inconsistentEdges.length, 1);
  assert.equal(reversed.consistentlyOriented, false);
  const degenerate = diagnoseMesh({
    ...grid(1, 1),
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ],
  });
  assert.equal(degenerate.degenerateFaces.length, 1);
});

test('diagnostics detect duplicate face winding, nonplanarity and disconnected fans at a vertex', () => {
  const quad = grid(1, 1);
  const duplicates = diagnoseMesh({ ...quad, faces: [quad.faces[0], [...quad.faces[0]].reverse()] });
  assert.equal(duplicates.duplicateFaces.length, 1);
  const nonplanar = structuredClone(quad);
  nonplanar.vertices[3][2] = 1;
  assert.equal(diagnoseMesh(nonplanar).nonPlanarFaces.length, 1);
  const fan: TopologyMesh = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
    ],
    faces: [
      [0, 1, 2],
      [0, 3, 4],
    ],
  };
  assert.equal(diagnoseMesh(fan).nonManifoldVertices.length, 1);
});

test('component transforms use pivot and orientation, preserve all IDs and never mutate input', () => {
  const mesh = grid(1, 1);
  const original = structuredClone(mesh);
  const result = transformComponents(mesh, {
    selection: selection(mesh, 'face', [0]),
    rotation: [0, 0, 90],
    scale: [2, 1, 1],
    pivot: [0, 0, 0],
    translation: [1, 0, 0],
  });
  const point = result.mesh.vertices[1];
  assert.ok(Math.abs(point[0] - 1) < 1e-9 && Math.abs(point[1] - 2) < 1e-9);
  assert.deepEqual(result.changes.vertex.created, []);
  assert.deepEqual(result.changes.face.deleted, []);
  assert.deepEqual(mesh, original);
  const oriented = transformComponents(mesh, {
    selection: selection(mesh, 'face', [0]),
    translation: [1, 0, 0],
    orientation: [0, 0, 90],
  });
  assert.ok(Math.abs(oriented.mesh.vertices[0][0]) < 1e-9);
  assert.ok(Math.abs(oriented.mesh.vertices[0][1] - 1) < 1e-9);
});

test('connected proportional editing excludes a nearby disconnected island and reports evaluated weights', () => {
  const base = grid(1, 1);
  const mesh: TopologyMesh = {
    ...base,
    vertices: [...base.vertices, [0, 0, 0.1], [1, 0, 0.1], [0, 1, 0.1]],
    faces: [...base.faces, [4, 5, 6]],
  };
  const request = {
    selection: selection(mesh, 'vertex', [0]),
    translation: [0, 0, 1] as [number, number, number],
    proportional: { radius: 2, falloff: 'linear' as const, connected: true },
  };
  const connected = transformComponents(mesh, request);
  assert.deepEqual(connected.mesh.vertices[4], mesh.vertices[4]);
  assert.equal(connected.mesh.vertices[1][2], 0.5);
  assert.equal(
    connected.weights.find((entry) => entry.id === connected.mesh.identity.vertexIds[0])?.weight,
    1,
  );
  const spatial = transformComponents(mesh, {
    ...request,
    proportional: { ...request.proportional, connected: false },
  });
  assert.ok(spatial.mesh.vertices[4][2] > 1);
  assert.throws(() =>
    transformComponents(mesh, { ...request, proportional: { ...request.proportional, radius: 0 } }),
  );
});

test('invalid transforms reject atomically without preserving corrupted geometry', () => {
  const mesh = grid(1, 1);
  const original = structuredClone(mesh);
  assert.throws(() =>
    transformComponents(mesh, { selection: selection(mesh, 'face', [0]), scale: [0, 1, 1] }),
  );
  assert.throws(
    () => transformComponents(mesh, { selection: selection(mesh, 'vertex', [1]), translation: [-1, 0, 0] }),
    { code: 'DEGENERATE_FACE' },
  );
  assert.throws(
    () => transformComponents(mesh, { selection: selection(mesh, 'vertex', [1]), translation: [-2, 0.5, 0] }),
    { code: 'SELF_INTERSECTION' },
  );
  assert.deepEqual(mesh, original);
});
