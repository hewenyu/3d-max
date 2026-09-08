import { Vector3 } from 'three';
import { buildTopology, meshFaceNormal } from './adjacency';
import { duplicateVertexGroups } from './diagnostics';
import { MeshEditor } from './editor';
import { stableEdgeId } from './identity';
import { planarRegion, regionBoundaries, simplePolygon } from './regions';
import { resolveSelection, selectionVertices } from './selection';
import { TopologyError, type ComponentSelection, type TopologyMesh, type TopologyVector } from './types';

export function weldVertices(
  input: TopologyMesh,
  request: { selection: ComponentSelection; tolerance: number; position?: 'first' | 'center' },
) {
  const topology = buildTopology(input);
  const selected = selectionVertices(topology, request.selection);
  if (selected.length < 2)
    throw new TopologyError('Weld requires at least two selected vertices', 'EMPTY_SELECTION');
  const groups = duplicateVertexGroups(
    { ...input, vertices: selected.map((index) => input.vertices[index]) },
    request.tolerance,
  ).map((group) => group.map((index) => selected[index]));
  const editor = new MeshEditor(topology.mesh);
  const aliases = new Map<number, number>();
  for (const group of groups) {
    group.sort(
      (left, right) =>
        Number(editor.mesh.identity.vertexIds[left].slice(1)) -
        Number(editor.mesh.identity.vertexIds[right].slice(1)),
    );
    const kept = group[0];
    if (request.position === 'center')
      editor.mesh.vertices[kept] = group
        .reduce((point, index) => point.add(new Vector3(...input.vertices[index])), new Vector3())
        .multiplyScalar(1 / group.length)
        .toArray() as TopologyVector;
    for (const vertex of group) {
      aliases.set(vertex, kept);
      editor.map('vertex', editor.mesh.identity.vertexIds[vertex], [editor.mesh.identity.vertexIds[kept]]);
    }
  }
  const removedFaces: number[] = [];
  const signatures = new Map<string, number>();
  editor.mesh.faces = editor.mesh.faces.map((face, index) => {
    const mapped = face.map((vertex) => aliases.get(vertex) ?? vertex);
    const compressed = mapped.filter(
      (vertex, corner) => vertex !== mapped[(corner + mapped.length - 1) % mapped.length],
    );
    if (compressed.length < 3) {
      removedFaces.push(index);
      return compressed;
    }
    if (new Set(compressed).size !== compressed.length)
      throw new TopologyError('Weld would make a self-touching face; reduce tolerance', 'INVALID_WELD');
    if (meshFaceNormal(editor.mesh, compressed).length() < 1e-8) {
      removedFaces.push(index);
      return compressed;
    }
    const minimum = Math.min(...compressed);
    const start = compressed.indexOf(minimum);
    const rotated = [...compressed.slice(start), ...compressed.slice(0, start)];
    const reverse = [rotated[0], ...rotated.slice(1).reverse()];
    const signature = (rotated[1] < reverse[1] ? rotated : reverse).join(',');
    const previous = signatures.get(signature);
    if (previous === undefined) signatures.set(signature, index);
    else {
      removedFaces.push(index);
      editor.map('face', editor.mesh.identity.faceIds[index], [editor.mesh.identity.faceIds[previous]]);
    }
    return compressed;
  });
  for (const edge of topology.edges) {
    const left = aliases.get(edge.vertices[0]) ?? edge.vertices[0];
    const right = aliases.get(edge.vertices[1]) ?? edge.vertices[1];
    editor.map(
      'edge',
      edge.id,
      left === right
        ? []
        : [stableEdgeId(editor.mesh.identity.vertexIds[left], editor.mesh.identity.vertexIds[right])],
    );
  }
  editor.removeFaces(removedFaces);
  editor.removeVertices(
    [...aliases.entries()].filter(([vertex, target]) => vertex !== target).map(([vertex]) => vertex),
  );
  const actualEdges = buildTopology(editor.mesh).edgeById;
  for (const [id, replacements] of Object.entries(editor.replacements.edge ?? {}))
    editor.map(
      'edge',
      id,
      replacements.filter((edge) => actualEdges.has(edge)),
    );
  return {
    ...editor.finish(),
    mergedGroups: groups.map((group) => group.map((index) => topology.mesh.identity.vertexIds[index])),
  };
}

export function dissolveEdges(input: TopologyMesh, request: { selection: ComponentSelection }) {
  if (request.selection.kind !== 'edge') throw new TopologyError('Edge dissolve requires edge selection');
  const topology = buildTopology(input);
  const edges = resolveSelection(topology, request.selection);
  if (!edges.length) throw new TopologyError('Select an interior edge', 'EMPTY_SELECTION');
  const selected = new Set(edges);
  const adjacent = new Map<number, number[]>();
  for (const edgeIndex of edges) {
    const edge = topology.edges[edgeIndex];
    if (edge.faces.length !== 2 || edge.directions[0] === edge.directions[1])
      throw new TopologyError(
        'Dissolve requires consistently oriented manifold interior edges',
        'NOT_INTERIOR_EDGE',
      );
    for (const face of edge.faces)
      adjacent.set(face, [...(adjacent.get(face) ?? []), ...edge.faces.filter((value) => value !== face)]);
  }
  const unvisited = new Set(adjacent.keys());
  const editor = new MeshEditor(topology.mesh);
  const removed: number[] = [];
  while (unvisited.size) {
    const first = unvisited.values().next().value!;
    const faces = [first];
    unvisited.delete(first);
    for (let cursor = 0; cursor < faces.length; cursor++)
      for (const next of adjacent.get(faces[cursor]) ?? []) if (unvisited.delete(next)) faces.push(next);
    const faceSet = new Set(faces);
    for (const face of faces)
      for (const edge of topology.faceEdges[face])
        if (
          topology.edges[edge].faces.filter((index) => faceSet.has(index)).length === 2 &&
          !selected.has(edge)
        )
          throw new TopologyError(
            'Dissolve would remove an unselected internal edge; select it explicitly',
            'INCOMPLETE_SELECTION',
          );
    const frame = planarRegion(input, faces);
    const loops = regionBoundaries(topology, faces);
    if (
      loops.length !== 1 ||
      loops[0].vertices.length > 256 ||
      !simplePolygon(loops[0].vertices.map(frame.project))
    )
      throw new TopologyError(
        'Dissolve requires one simple boundary with at most 256 vertices',
        'INVALID_DISSOLVE',
      );
    faces.sort((left, right) => left - right);
    const kept = faces[0];
    editor.replaceFace(kept, loops[0].vertices);
    for (const face of faces)
      editor.map('face', editor.mesh.identity.faceIds[face], [editor.mesh.identity.faceIds[kept]]);
    removed.push(...faces.slice(1));
  }
  editor.removeFaces(removed);
  const used = new Set(editor.mesh.faces.flat());
  const candidates = new Set(edges.flatMap((edge) => topology.edges[edge].vertices));
  editor.removeVertices([...candidates].filter((vertex) => !used.has(vertex)));
  return editor.finish();
}

export function dissolveVertices(
  input: TopologyMesh,
  request: { selection: ComponentSelection; tolerance?: number },
) {
  if (request.selection.kind !== 'vertex')
    throw new TopologyError('Vertex dissolve requires vertex selection');
  const topology = buildTopology(input);
  const vertices = resolveSelection(topology, request.selection);
  if (!vertices.length) throw new TopologyError('Select a vertex', 'EMPTY_SELECTION');
  const tolerance = request.tolerance ?? 1e-6;
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1)
    throw new TopologyError('Dissolve tolerance must be greater than zero and at most one meter');
  const selected = new Set(vertices);
  for (const vertex of vertices) {
    const edges = topology.vertexEdges[vertex];
    if (edges.length !== 2)
      throw new TopologyError(
        'Vertex dissolve requires exactly two incident edges',
        'UNSUPPORTED_VERTEX_VALENCE',
      );
    const neighbors = edges.map((edge) => topology.edges[edge].vertices.find((index) => index !== vertex)!);
    const a = new Vector3(...input.vertices[neighbors[0]]);
    const b = new Vector3(...input.vertices[neighbors[1]]);
    const point = new Vector3(...input.vertices[vertex]);
    const line = b.clone().sub(a);
    const parameter = point.clone().sub(a).dot(line) / line.lengthSq();
    if (
      !Number.isFinite(parameter) ||
      parameter <= 0 ||
      parameter >= 1 ||
      a.addScaledVector(line, parameter).distanceTo(point) > tolerance
    )
      throw new TopologyError(
        'Vertex dissolve only removes collinear points inside their neighboring edge',
        'NON_COLLINEAR_VERTEX',
      );
  }
  const editor = new MeshEditor(topology.mesh);
  editor.mesh.faces = editor.mesh.faces.map((face) => face.filter((vertex) => !selected.has(vertex)));
  editor.removeVertices(vertices);
  return editor.finish();
}
