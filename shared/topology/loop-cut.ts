import { Vector3 } from 'three';
import { buildTopology } from './adjacency';
import { MeshEditor } from './editor';
import { stableEdgeId } from './identity';
import { resolveSelection, selectComponents } from './selection';
import { TopologyError, type ComponentSelection, type TopologyMesh, type TopologyVector } from './types';

export function loopCut(
  input: TopologyMesh,
  request: { selection: ComponentSelection; cuts?: number; slide?: number },
) {
  if (request.selection.kind !== 'edge' || request.selection.ids.length !== 1)
    throw new TopologyError('Loop cut requires exactly one seed edge');
  const cuts = request.cuts ?? 1;
  const slide = request.slide ?? 0;
  if (!Number.isInteger(cuts) || cuts < 1 || cuts > 32 || !Number.isFinite(slide) || Math.abs(slide) >= 1)
    throw new TopologyError('Loop cuts must be 1..32 and slide strictly between -1 and 1');
  const topology = buildTopology(input);
  const ring = selectComponents(input, { ...request.selection, operation: 'ring' });
  const selected = new Set(ring.indices);
  const incompatible = ring.indices.filter((index) => {
    const edge = topology.edges[index];
    return edge.faces.length > 2 || (edge.faces.length === 2 && edge.directions[0] === edge.directions[1]);
  });
  if (incompatible.length)
    throw new TopologyError(
      'Loop cut requires manifold, consistently oriented strip edges',
      'NON_MANIFOLD_SELECTION',
      400,
      { edgeIds: incompatible.map((index) => topology.edges[index].id) },
    );
  const seed = resolveSelection(topology, request.selection)[0];
  if (!topology.edges[seed].faces.some((face) => input.faces[face].length === 4))
    throw new TopologyError('Loop cut requires a quadrilateral strip', 'NON_QUAD_SELECTION');
  const [seedLeft, seedRight] = topology.edges[seed].vertices;
  const seedDirection =
    Number(topology.mesh.identity.vertexIds[seedLeft].slice(1)) <
    Number(topology.mesh.identity.vertexIds[seedRight].slice(1))
      ? 1
      : -1;
  const orientation = new Map<number, number>([[seed, seedDirection]]);
  const queue = [seed];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const edgeIndex = queue[cursor];
    for (const faceIndex of topology.edges[edgeIndex].faces) {
      const faceEdges = topology.faceEdges[faceIndex];
      if (faceEdges.length !== 4) continue;
      const corner = faceEdges.indexOf(edgeIndex);
      const opposite = faceEdges[(corner + 2) % 4];
      const face = input.faces[faceIndex];
      const direction = topology.edges[edgeIndex].vertices[0] === face[corner] ? 1 : -1;
      const otherDirection = topology.edges[opposite].vertices[0] === face[(corner + 2) % 4] ? 1 : -1;
      const next = -orientation.get(edgeIndex)! * direction * otherDirection;
      if (orientation.has(opposite)) {
        if (orientation.get(opposite) !== next)
          throw new TopologyError('Loop cut strip has inconsistent orientation', 'NON_ORIENTABLE_STRIP');
      } else {
        orientation.set(opposite, next);
        queue.push(opposite);
      }
    }
  }
  const editor = new MeshEditor(topology.mesh);
  const inserted = new Map<number, number[]>();
  for (const edgeIndex of selected) {
    const edge = topology.edges[edgeIndex];
    const [left, right] = edge.vertices;
    const points = Array.from({ length: cuts }, (_, index) => {
      const base = (index + 1) / (cuts + 1);
      let time = base + slide * Math.min(base, 1 - base);
      if (orientation.get(edgeIndex) === -1) time = 1 - time;
      return {
        time,
        vertex: editor.addVertex(
          new Vector3(...input.vertices[left])
            .lerp(new Vector3(...input.vertices[right]), time)
            .toArray() as TopologyVector,
        ),
      };
    })
      .sort((a, b) => a.time - b.time)
      .map((point) => point.vertex);
    inserted.set(edgeIndex, points);
    const chain = [left, ...points, right];
    editor.map(
      'edge',
      edge.id,
      chain
        .slice(1)
        .map((vertex, index) =>
          stableEdgeId(editor.mesh.identity.vertexIds[chain[index]], editor.mesh.identity.vertexIds[vertex]),
        ),
    );
  }
  const alongFace = (edge: number, start: number) =>
    topology.edges[edge].vertices[0] === start ? inserted.get(edge)! : [...inserted.get(edge)!].reverse();
  input.faces.forEach((face, faceIndex) => {
    const edges = topology.faceEdges[faceIndex];
    const crossing = edges.filter((edge) => selected.has(edge));
    if (!crossing.length) return;
    if (face.length === 4 && crossing.length === 2) {
      const corner = edges.indexOf(crossing[0]);
      if (edges[(corner + 2) % 4] !== crossing[1])
        throw new TopologyError('Loop cut cannot cross adjacent quad edges', 'AMBIGUOUS_STRIP');
      const [a, b, c, d] = [0, 1, 2, 3].map((offset) => face[(corner + offset) % 4]);
      const left = [a, ...alongFace(crossing[0], a), b];
      const right = [d, ...[...alongFace(crossing[1], c)].reverse(), c];
      const replacements = [editor.mesh.identity.faceIds[faceIndex]];
      for (let segment = 0; segment <= cuts; segment++) {
        const polygon = [left[segment], left[segment + 1], right[segment + 1], right[segment]];
        if (segment === 0) editor.replaceFace(faceIndex, polygon);
        else replacements.push(editor.mesh.identity.faceIds[editor.addFace(polygon)]);
      }
      editor.map('face', editor.mesh.identity.faceIds[faceIndex], replacements);
    } else if (face.length === 4 && crossing.length > 2)
      throw new TopologyError('Loop cut strip intersects itself', 'AMBIGUOUS_STRIP');
    else
      editor.replaceFace(
        faceIndex,
        face.flatMap((vertex, corner) => [
          vertex,
          ...(selected.has(edges[corner]) ? alongFace(edges[corner], vertex) : []),
        ]),
      );
  });
  return { ...editor.finish(), stopped: ring.stopped };
}
