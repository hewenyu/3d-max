import { Vector2, Vector3 } from 'three';
import { buildTopology, meshFaceNormal } from './adjacency';
import { simplePolygon } from './regions';
import { TOPOLOGY_LIMITS, TopologyError, type TopologyMesh } from './types';

export interface MeshDiagnostics {
  namespace: string;
  counts: { vertices: number; edges: number; faces: number; triangles: number; connectedComponents: number };
  boundaryEdges: string[];
  nonManifoldEdges: string[];
  inconsistentEdges: string[];
  nonManifoldVertices: string[];
  looseVertices: string[];
  degenerateFaces: string[];
  nonPlanarFaces: string[];
  selfIntersectingFaces: string[];
  duplicateVertices: string[][];
  duplicateFaces: string[][];
  closed: boolean;
  consistentlyOriented: boolean;
  tolerance: number;
}

export function duplicateVertexGroups(mesh: TopologyMesh, tolerance: number): number[][] {
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1000)
    throw new TopologyError('Duplicate tolerance must be greater than zero and at most 1000 meters');
  const parent = mesh.vertices.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const cells = new Map<string, number[]>();
  let comparisons = 0;
  mesh.vertices.forEach((vertex, index) => {
    const cell = vertex.map((value) => Math.floor(value / tolerance));
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          const candidates = cells.get(`${cell[0] + x},${cell[1] + y},${cell[2] + z}`) ?? [];
          for (const candidate of candidates) {
            if (++comparisons > TOPOLOGY_LIMITS.diagnosticComparisons)
              throw new TopologyError(
                'Duplicate search exceeds the comparison limit; reduce tolerance or selection',
                'TOPOLOGY_LIMIT',
              );
            const other = mesh.vertices[candidate];
            if (Math.hypot(vertex[0] - other[0], vertex[1] - other[1], vertex[2] - other[2]) <= tolerance)
              parent[find(index)] = find(candidate);
          }
        }
    const key = cell.join(',');
    const bucket = cells.get(key) ?? [];
    bucket.push(index);
    cells.set(key, bucket);
  });
  const groups = new Map<number, number[]>();
  parent.forEach((_, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

function faceSignature(face: number[]): string {
  const smallest = Math.min(...face);
  const index = face.indexOf(smallest);
  const forward = [...face.slice(index), ...face.slice(0, index)];
  const reversed = [forward[0], ...forward.slice(1).reverse()];
  return forward[1] < reversed[1] ? forward.join(',') : reversed.join(',');
}

export function diagnoseMesh(input: TopologyMesh, options: { tolerance?: number } = {}): MeshDiagnostics {
  const topology = buildTopology(input);
  const mesh = topology.mesh;
  const tolerance = options.tolerance ?? 1e-6;
  const duplicateVertices = duplicateVertexGroups(mesh, tolerance).map((group) =>
    group.map((index) => mesh.identity.vertexIds[index]),
  );
  const groups = new Map<string, number[]>();
  const degenerateFaces: string[] = [];
  const nonPlanarFaces: string[] = [];
  const selfIntersectingFaces: string[] = [];
  mesh.faces.forEach((face, index) => {
    const normal = meshFaceNormal(mesh, face);
    if (normal.length() < 1e-8) degenerateFaces.push(mesh.identity.faceIds[index]);
    else {
      normal.normalize();
      const first = new Vector3(...mesh.vertices[face[0]]);
      if (
        face.some(
          (vertex) => Math.abs(new Vector3(...mesh.vertices[vertex]).sub(first).dot(normal)) > tolerance,
        )
      )
        nonPlanarFaces.push(mesh.identity.faceIds[index]);
    }
    const bounds = [0, 1, 2].map((axis) => {
      const values = face.map((vertex) => mesh.vertices[vertex][axis]);
      return Math.max(...values) - Math.min(...values);
    });
    const drop =
      normal.lengthSq() > 0.5
        ? normal
            .toArray()
            .map(Math.abs)
            .indexOf(Math.max(...normal.toArray().map(Math.abs)))
        : bounds.indexOf(Math.min(...bounds));
    const axes = [0, 1, 2].filter((axis) => axis !== drop);
    if (
      !simplePolygon(
        face.map((vertex) => new Vector2(mesh.vertices[vertex][axes[0]], mesh.vertices[vertex][axes[1]])),
      )
    )
      selfIntersectingFaces.push(mesh.identity.faceIds[index]);
    const signature = faceSignature(face);
    const group = groups.get(signature) ?? [];
    group.push(index);
    groups.set(signature, group);
  });
  const nonManifoldVertices: string[] = [];
  mesh.vertices.forEach((_, vertex) => {
    const incident = topology.vertexFaces[vertex];
    if (!incident.length) return;
    const remaining = new Set(incident);
    const queue = [incident[0]];
    remaining.delete(incident[0]);
    for (let cursor = 0; cursor < queue.length; cursor++)
      for (const edgeIndex of topology.faceEdges[queue[cursor]]) {
        const edge = topology.edges[edgeIndex];
        if (!edge.vertices.includes(vertex)) continue;
        for (const face of edge.faces) if (remaining.delete(face)) queue.push(face);
      }
    if (remaining.size || topology.vertexEdges[vertex].some((edge) => topology.edges[edge].faces.length > 2))
      nonManifoldVertices.push(mesh.identity.vertexIds[vertex]);
  });
  const unvisited = new Set(mesh.vertices.map((_, index) => index));
  let connectedComponents = 0;
  while (unvisited.size) {
    const seed = unvisited.values().next().value!;
    const queue = [seed];
    unvisited.delete(seed);
    connectedComponents++;
    for (let cursor = 0; cursor < queue.length; cursor++)
      for (const edge of topology.vertexEdges[queue[cursor]])
        for (const vertex of topology.edges[edge].vertices) if (unvisited.delete(vertex)) queue.push(vertex);
  }
  const boundaryEdges = topology.edges.filter((edge) => edge.faces.length === 1).map((edge) => edge.id);
  const nonManifoldEdges = topology.edges.filter((edge) => edge.faces.length > 2).map((edge) => edge.id);
  const inconsistentEdges = topology.edges
    .filter((edge) => edge.faces.length === 2 && edge.directions[0] === edge.directions[1])
    .map((edge) => edge.id);
  return {
    namespace: mesh.identity.namespace,
    counts: {
      vertices: mesh.vertices.length,
      edges: topology.edges.length,
      faces: mesh.faces.length,
      triangles: mesh.faces.reduce((sum, face) => sum + face.length - 2, 0),
      connectedComponents,
    },
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    nonManifoldVertices,
    looseVertices: mesh.identity.vertexIds.filter((_, index) => topology.vertexFaces[index].length === 0),
    degenerateFaces,
    nonPlanarFaces,
    selfIntersectingFaces,
    duplicateVertices,
    duplicateFaces: [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => group.map((index) => mesh.identity.faceIds[index])),
    closed: boundaryEdges.length === 0 && nonManifoldEdges.length === 0 && nonManifoldVertices.length === 0,
    consistentlyOriented: inconsistentEdges.length === 0 && nonManifoldEdges.length === 0,
    tolerance,
  };
}
