import { Vector3 } from 'three';
import { DomainError } from '../domain-error';
import type { MeshData } from '../modeling';

export interface EdgeUse {
  face: number;
  from: number;
  to: number;
}
export function indexedEdges(mesh: MeshData) {
  const edges = new Map<string, EdgeUse[]>();
  mesh.faces.forEach((face, faceIndex) => {
    face.forEach((from, index) => {
      const to = face[(index + 1) % face.length];
      const key = `${Math.min(from, to)}:${Math.max(from, to)}`;
      const uses = edges.get(key) ?? [];
      uses.push({ face: faceIndex, from, to });
      edges.set(key, uses);
    });
  });
  return edges;
}

export function polygonUnitNormal(mesh: MeshData, face: number[]): Vector3 {
  const normal = new Vector3();
  for (let index = 0; index < face.length; index++) {
    const a = mesh.vertices[face[index]];
    const b = mesh.vertices[face[(index + 1) % face.length]];
    normal.x += (a[1] - b[1]) * (a[2] + b[2]);
    normal.y += (a[2] - b[2]) * (a[0] + b[0]);
    normal.z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  if (normal.lengthSq() < 1e-16)
    throw new DomainError('Modifier source contains a degenerate face', 'MODELING_TOPOLOGY');
  return normal.normalize();
}

export function orientedManifold(mesh: MeshData) {
  const edges = indexedEdges(mesh);
  const incident = mesh.vertices.map(() => new Set<number>());
  mesh.faces.forEach((face, index) => face.forEach((vertex) => incident[vertex].add(index)));
  const boundaryCount = new Uint8Array(mesh.vertices.length);
  const faceNeighbors = mesh.vertices.map(() => new Map<number, Set<number>>());
  for (const uses of edges.values()) {
    if (uses.length > 2 || (uses.length === 2 && uses[0].from === uses[1].from))
      throw new DomainError('Modifier requires consistently oriented manifold edges', 'MODELING_TOPOLOGY');
    for (const vertex of [uses[0].from, uses[0].to]) {
      if (uses.length === 1) boundaryCount[vertex]++;
      else {
        for (const [a, b] of [
          [uses[0].face, uses[1].face],
          [uses[1].face, uses[0].face],
        ]) {
          const neighbors = faceNeighbors[vertex].get(a) ?? new Set<number>();
          neighbors.add(b);
          faceNeighbors[vertex].set(a, neighbors);
        }
      }
    }
  }
  incident.forEach((faces, vertex) => {
    if (!faces.size || (boundaryCount[vertex] !== 0 && boundaryCount[vertex] !== 2))
      throw new DomainError('Modifier source has isolated or non-manifold vertices', 'MODELING_TOPOLOGY');
    const pending = [faces.values().next().value!];
    const visited = new Set<number>();
    while (pending.length) {
      const face = pending.pop()!;
      if (visited.has(face)) continue;
      visited.add(face);
      for (const next of faceNeighbors[vertex].get(face) ?? []) pending.push(next);
    }
    if (visited.size !== faces.size)
      throw new DomainError('Modifier source contains a disconnected vertex fan', 'MODELING_TOPOLOGY');
  });
  return edges;
}

export function assertMeshCapacity(vertices: number, triangles: number) {
  if (vertices > 100000 || triangles > 150000)
    throw new DomainError('Modifier result exceeds 100000 vertices or 150000 triangles', 'MODELING_LIMIT');
}
