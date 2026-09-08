import { Vector3 } from 'three';
import { buildTopology } from './adjacency';
import { MeshEditor } from './editor';
import { resolveSelection } from './selection';
import { TopologyError, type ComponentSelection, type TopologyMesh, type TopologyVector } from './types';

export function slideComponents(
  input: TopologyMesh,
  request: { selection: ComponentSelection; amount: number },
) {
  if (!Number.isFinite(request.amount) || Math.abs(request.amount) >= 1)
    throw new TopologyError('Slide amount must be strictly between -1 and 1');
  if (request.selection.kind === 'face') throw new TopologyError('Slide requires edge or vertex selection');
  const topology = buildTopology(input);
  const indices = resolveSelection(topology, request.selection);
  const vertexSelection = new Set(indices);
  const edges =
    request.selection.kind === 'edge'
      ? indices
      : topology.edges.flatMap((edge, index) =>
          edge.vertices.every((vertex) => vertexSelection.has(vertex)) ? [index] : [],
        );
  if (!edges.length)
    throw new TopologyError(
      'Slide requires a connected edge chain; isolated vertices have no rail direction',
      'EMPTY_SELECTION',
    );
  const selected = new Set(edges);
  const vertices = [...new Set(edges.flatMap((edge) => topology.edges[edge].vertices))];
  const side = new Map<number, number>();
  const unvisited = new Set(edges);
  while (unvisited.size) {
    const seed = unvisited.values().next().value!;
    side.set(seed, topology.edges[seed].faces[0]);
    const queue = [seed];
    unvisited.delete(seed);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const edgeIndex = queue[cursor];
      const edge = topology.edges[edgeIndex];
      if (edge.faces.length !== 2 || edge.faces.some((face) => input.faces[face].length !== 4))
        throw new TopologyError(
          'Slide requires interior edges between quadrilateral faces',
          'NON_QUAD_SELECTION',
        );
      for (const vertex of edge.vertices) {
        const continuation = topology.vertexEdges[vertex].filter(
          (candidate) => selected.has(candidate) && candidate !== edgeIndex,
        );
        if (continuation.length > 1)
          throw new TopologyError('Slide edge selection branches', 'AMBIGUOUS_SELECTION');
        for (const next of continuation) {
          const sourceFace = side.get(edgeIndex)!;
          const sourceRails = topology.faceEdges[sourceFace].filter(
            (candidate) => !selected.has(candidate) && topology.edges[candidate].vertices.includes(vertex),
          );
          const candidates = topology.edges[next].faces.filter(
            (face) =>
              face === sourceFace ||
              topology.faceEdges[face].some((candidate) => sourceRails.includes(candidate)),
          );
          if (candidates.length !== 1)
            throw new TopologyError(
              'Slide cannot determine consistent rails at this vertex',
              'AMBIGUOUS_RAILS',
            );
          if (side.has(next) && side.get(next) !== candidates[0])
            throw new TopologyError('Slide loop has inconsistent side orientation', 'NON_ORIENTABLE_STRIP');
          side.set(next, candidates[0]);
          if (unvisited.delete(next)) queue.push(next);
        }
      }
    }
  }
  const editor = new MeshEditor(topology.mesh);
  const rails: { id: string; toward: string; amount: number }[] = [];
  for (const vertex of vertices) {
    const incident = topology.vertexEdges[vertex].filter((edge) => selected.has(edge));
    const candidates = new Set<number>();
    for (const edgeIndex of incident) {
      const edge = topology.edges[edgeIndex];
      const face =
        request.amount >= 0
          ? side.get(edgeIndex)!
          : edge.faces.find((value) => value !== side.get(edgeIndex))!;
      for (const rail of topology.faceEdges[face])
        if (!selected.has(rail) && topology.edges[rail].vertices.includes(vertex)) candidates.add(rail);
    }
    if (candidates.size !== 1)
      throw new TopologyError('Slide has ambiguous or missing side rails', 'AMBIGUOUS_RAILS');
    const rail = topology.edges[[...candidates][0]];
    const target = rail.vertices.find((index) => index !== vertex)!;
    if (vertices.includes(target))
      throw new TopologyError('Slide rail ends on another selected vertex', 'AMBIGUOUS_RAILS');
    editor.mesh.vertices[vertex] = new Vector3(...input.vertices[vertex])
      .lerp(new Vector3(...input.vertices[target]), Math.abs(request.amount))
      .toArray() as TopologyVector;
    rails.push({
      id: editor.mesh.identity.vertexIds[vertex],
      toward: editor.mesh.identity.vertexIds[target],
      amount: Math.abs(request.amount),
    });
  }
  return { ...editor.finish(), rails };
}
