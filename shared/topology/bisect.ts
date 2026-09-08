import { ShapeUtils, Vector3 } from 'three';
import { buildTopology } from './adjacency';
import { fillBoundaries } from './boundaries';
import { MeshEditor, meshEditResult } from './editor';
import { stableEdgeId } from './identity';
import { planarRegion, simplePolygon } from './regions';
import { TopologyError, type TopologyMesh, type TopologyVector } from './types';

export interface MeshBisect {
  normal: TopologyVector;
  offset: number;
  keep?: 'both' | 'positive' | 'negative';
  fill?: boolean;
  tolerance?: number;
}

export function bisectMesh(input: TopologyMesh, request: MeshBisect) {
  const normal = new Vector3(...request.normal);
  const length = normal.length();
  if (
    !Number.isFinite(length) ||
    length < 1e-8 ||
    !Number.isFinite(request.offset) ||
    Math.abs(request.offset) > 100000
  )
    throw new TopologyError(
      'Bisect requires a nonzero finite plane normal and a finite offset within 100000 meters',
    );
  normal.normalize();
  const offset = request.offset / length;
  const tolerance = request.tolerance ?? 1e-7;
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1)
    throw new TopologyError('Bisect tolerance must be greater than zero and at most one meter');
  const keep = request.keep ?? 'both';
  if (request.fill && keep === 'both')
    throw new TopologyError('Capping requires keeping one side of the plane');
  const topology = buildTopology(input);
  const editor = new MeshEditor(topology.mesh);
  const distances = input.vertices.map((vertex) => new Vector3(...vertex).dot(normal) - offset);
  const intersections = new Map<string, number>();
  const splitEdges = new Map<string, string[]>();
  const intersection = (left: number, right: number): number => {
    if (Math.abs(distances[left]) <= tolerance) return left;
    if (Math.abs(distances[right]) <= tolerance) return right;
    const key = `${Math.min(left, right)}:${Math.max(left, right)}`;
    const existing = intersections.get(key);
    if (existing !== undefined) return existing;
    const time = distances[left] / (distances[left] - distances[right]);
    const vertex = editor.addVertex(
      new Vector3(...input.vertices[left])
        .lerp(new Vector3(...input.vertices[right]), time)
        .toArray() as TopologyVector,
    );
    distances[vertex] = 0;
    intersections.set(key, vertex);
    const old = stableEdgeId(editor.mesh.identity.vertexIds[left], editor.mesh.identity.vertexIds[right]);
    if (topology.edgeById.has(old))
      splitEdges.set(old, [
        stableEdgeId(editor.mesh.identity.vertexIds[left], editor.mesh.identity.vertexIds[vertex]),
        stableEdgeId(editor.mesh.identity.vertexIds[vertex], editor.mesh.identity.vertexIds[right]),
      ]);
    return vertex;
  };
  const clip = (face: number[], positive: boolean) => {
    const polygon: number[] = [];
    const inside = (vertex: number) =>
      positive ? distances[vertex] >= -tolerance : distances[vertex] <= tolerance;
    for (let index = 0; index < face.length; index++) {
      const left = face[index];
      const right = face[(index + 1) % face.length];
      if (inside(left)) polygon.push(left);
      if (inside(left) !== inside(right)) polygon.push(intersection(left, right));
    }
    return polygon.filter(
      (vertex, index) => vertex !== polygon[(index + polygon.length - 1) % polygon.length],
    );
  };
  const removed: number[] = [];
  input.faces.forEach((face, faceIndex) => {
    const positive = face.some((vertex) => distances[vertex] > tolerance);
    const negative = face.some((vertex) => distances[vertex] < -tolerance);
    if (!positive || !negative) {
      if ((keep === 'positive' && negative && !positive) || (keep === 'negative' && positive && !negative))
        removed.push(faceIndex);
      return;
    }
    const frame = planarRegion(input, [faceIndex]);
    const points = face.map(frame.project);
    if (!simplePolygon(points))
      throw new TopologyError('Bisect requires simple planar polygons', 'SELF_INTERSECTION');
    const turns = points
      .map((point, index) => {
        const next = points[(index + 1) % points.length];
        const after = points[(index + 2) % points.length];
        return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
      })
      .filter((value) => Math.abs(value) > 1e-10);
    const convex = turns.every((value) => Math.sign(value) === Math.sign(turns[0]));
    const sources = convex
      ? [face]
      : ShapeUtils.triangulateShape(points, []).map((triangle) => triangle.map((index) => face[index]));
    const polygons = sources
      .flatMap((source) => [
        ...(keep !== 'negative' ? [clip(source, true)] : []),
        ...(keep !== 'positive' ? [clip(source, false)] : []),
      ])
      .filter((polygon) => polygon.length >= 3);
    if (!polygons.length) {
      removed.push(faceIndex);
      return;
    }
    editor.replaceFace(faceIndex, polygons[0]);
    const replacements = [editor.mesh.identity.faceIds[faceIndex]];
    for (const polygon of polygons.slice(1))
      replacements.push(editor.mesh.identity.faceIds[editor.addFace(polygon)]);
    editor.map('face', editor.mesh.identity.faceIds[faceIndex], replacements);
  });
  editor.removeFaces(removed);
  const used = new Set(editor.mesh.faces.flat());
  editor.removeVertices(editor.mesh.vertices.flatMap((_, index) => (used.has(index) ? [] : [index])));
  let output = editor.mesh;
  if (request.fill) {
    const clipped = buildTopology(output);
    const capEdges = clipped.edges.filter(
      (edge) =>
        edge.faces.length === 1 &&
        edge.vertices.every(
          (vertex) => Math.abs(new Vector3(...output.vertices[vertex]).dot(normal) - offset) <= tolerance * 2,
        ),
    );
    if (capEdges.length)
      output = fillBoundaries(output, {
        selection: {
          namespace: output.identity.namespace,
          kind: 'edge',
          ids: capEdges.map((edge) => edge.id),
        },
        triangulate: false,
      }).mesh;
  }
  const final = buildTopology(output);
  for (const [edge, replacements] of splitEdges)
    editor.map(
      'edge',
      edge,
      replacements.filter((id) => final.edgeById.has(id)),
    );
  return meshEditResult(editor.before, output, editor.replacements);
}
