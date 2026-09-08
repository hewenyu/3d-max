import { Vector2, Vector3 } from 'three';
import { meshFaceNormal } from './adjacency';
import { resolveSelection } from './selection';
import { TopologyError, type ComponentSelection, type MeshTopology, type TopologyMesh } from './types';
export { simplePolygon } from './polygon';

export interface RegionBoundary {
  vertices: number[];
  edges: number[];
}

function traceBoundary(oriented: { left: number; right: number; edge: number }[]): RegionBoundary[] {
  const outgoing = new Map<number, (typeof oriented)[number]>();
  const incoming = new Set<number>();
  for (const edge of oriented) {
    if (outgoing.has(edge.left) || incoming.has(edge.right))
      throw new TopologyError('Region boundaries branch or touch at a vertex', 'AMBIGUOUS_BOUNDARY');
    outgoing.set(edge.left, edge);
    incoming.add(edge.right);
  }
  const loops: RegionBoundary[] = [];
  while (outgoing.size) {
    const first = outgoing.values().next().value!;
    const loop: RegionBoundary = { vertices: [], edges: [] };
    let vertex = first.left;
    do {
      const next = outgoing.get(vertex);
      if (!next)
        throw new TopologyError('Select complete, non-branching boundary loops', 'INCOMPLETE_BOUNDARY');
      loop.vertices.push(vertex);
      loop.edges.push(next.edge);
      outgoing.delete(vertex);
      vertex = next.right;
    } while (vertex !== first.left);
    if (loop.vertices.length < 3) throw new TopologyError('Region boundary requires at least three vertices');
    loops.push(loop);
  }
  return loops;
}

export function faceSelection(topology: MeshTopology, selection: ComponentSelection): number[] {
  if (selection.kind !== 'face') throw new TopologyError('This operation requires face selection');
  const faces = resolveSelection(topology, selection);
  if (!faces.length) throw new TopologyError('Select at least one face', 'EMPTY_SELECTION');
  return faces;
}

export function regionBoundaries(topology: MeshTopology, faces: number[]): RegionBoundary[] {
  const selected = new Set(faces);
  const oriented: { left: number; right: number; edge: number }[] = [];
  for (const faceIndex of faces) {
    const face = topology.mesh.faces[faceIndex];
    topology.faceEdges[faceIndex].forEach((edgeIndex, corner) => {
      const edge = topology.edges[edgeIndex];
      if (edge.faces.length > 2 || (edge.faces.length === 2 && edge.directions[0] === edge.directions[1]))
        throw new TopologyError(
          'Selected region requires manifold, consistently oriented edges',
          'NON_MANIFOLD_SELECTION',
          400,
          { edgeId: edge.id },
        );
      if (edge.faces.filter((index) => selected.has(index)).length === 1)
        oriented.push({ left: face[corner], right: face[(corner + 1) % face.length], edge: edgeIndex });
    });
  }
  return traceBoundary(oriented);
}

export function planarRegion(mesh: TopologyMesh, faces: number[], tolerance = 1e-6) {
  const first = mesh.faces[faces[0]];
  const normal = meshFaceNormal(mesh, first).normalize();
  if (normal.lengthSq() < 0.5) throw new TopologyError('Selected face is degenerate', 'DEGENERATE_FACE');
  const origin = new Vector3(...mesh.vertices[first[0]]);
  for (const index of faces) {
    if (
      meshFaceNormal(mesh, mesh.faces[index]).normalize().dot(normal) < 1 - 1e-6 ||
      mesh.faces[index].some(
        (vertex) => Math.abs(new Vector3(...mesh.vertices[vertex]).sub(origin).dot(normal)) > tolerance,
      )
    )
      throw new TopologyError(
        'This operation requires coplanar faces with matching orientation',
        'NON_PLANAR_SELECTION',
      );
  }
  const axis = Math.abs(normal.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const u = axis.cross(normal).normalize();
  const v = normal.clone().cross(u);
  return {
    normal,
    origin,
    u,
    v,
    project: (index: number) => {
      const point = new Vector3(...mesh.vertices[index]).sub(origin);
      return new Vector2(point.dot(u), point.dot(v));
    },
  };
}

export function boundaryLoops(topology: MeshTopology, edgeIndices: number[]): RegionBoundary[] {
  const selected = new Set(edgeIndices);
  if (!selected.size) throw new TopologyError('Select boundary edges', 'EMPTY_SELECTION');
  const oriented: { left: number; right: number; edge: number }[] = [];
  for (const edgeIndex of selected) {
    const edge = topology.edges[edgeIndex];
    if (edge.faces.length !== 1)
      throw new TopologyError('Selected edges must be open mesh boundaries', 'NOT_BOUNDARY', 400, {
        edgeId: edge.id,
      });
    const face = topology.mesh.faces[edge.faces[0]];
    const corner = topology.faceEdges[edge.faces[0]].indexOf(edgeIndex);
    oriented.push({ left: face[corner], right: face[(corner + 1) % face.length], edge: edgeIndex });
  }
  return traceBoundary(oriented);
}
