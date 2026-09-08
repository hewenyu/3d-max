import { ShapeUtils, Vector2, Vector3 } from 'three';
import { buildTopology, meshFaceNormal } from './adjacency';
import { MeshEditor } from './editor';
import { faceSelection, planarRegion, regionBoundaries, simplePolygon } from './regions';
import {
  TopologyError,
  type ComponentSelection,
  type MeshTopology,
  type TopologyMesh,
  type TopologyVector,
} from './types';

export interface FaceExtrusion {
  selection: ComponentSelection;
  distance: number;
  mode?: 'region' | 'individual';
  direction?: TopologyVector;
}
export interface FaceInset {
  selection: ComponentSelection;
  thickness: number;
  depth?: number;
  mode?: 'region' | 'individual';
}

function checkDistance(value: number, name: string, positive = false) {
  if (!Number.isFinite(value) || Math.abs(value) > 100000 || (positive ? value <= 0 : Math.abs(value) < 1e-8))
    throw new TopologyError(
      `${name} must be ${positive ? 'positive' : 'nonzero'}, finite, and within 100000 meters`,
    );
}

function extrudeGroup(topology: MeshTopology, editor: MeshEditor, faces: number[], request: FaceExtrusion) {
  const loops = regionBoundaries(topology, faces);
  const direction = request.direction
    ? new Vector3(...request.direction)
    : faces.reduce(
        (normal, face) => normal.add(meshFaceNormal(topology.mesh, topology.mesh.faces[face])),
        new Vector3(),
      );
  if (![direction.x, direction.y, direction.z].every(Number.isFinite) || direction.length() < 1e-8)
    throw new TopologyError('Extrusion direction is undefined; supply a nonzero direction');
  const offset = direction.normalize().multiplyScalar(request.distance);
  const vertices = [...new Set(faces.flatMap((face) => topology.mesh.faces[face]))];
  const cap = new Map(
    vertices.map((vertex) => [
      vertex,
      editor.addVertex(
        new Vector3(...topology.mesh.vertices[vertex]).add(offset).toArray() as TopologyVector,
      ),
    ]),
  );
  for (const face of faces)
    editor.replaceFace(
      face,
      topology.mesh.faces[face].map((vertex) => cap.get(vertex)!),
    );
  for (const loop of loops)
    for (let index = 0; index < loop.vertices.length; index++) {
      const left = loop.vertices[index];
      const right = loop.vertices[(index + 1) % loop.vertices.length];
      editor.addFace([left, right, cap.get(right)!, cap.get(left)!]);
    }
  return cap;
}

function pruneUnused(editor: MeshEditor, originalVertices: Set<number>, mappings: Map<number, number[]>) {
  const used = new Set(editor.mesh.faces.flat());
  const removed = [...originalVertices].filter((vertex) => !used.has(vertex));
  for (const [old, created] of mappings) {
    const originalId = editor.before.identity.vertexIds[old];
    editor.map('vertex', originalId, [
      ...(used.has(old) ? [originalId] : []),
      ...created.map((index) => editor.mesh.identity.vertexIds[index]),
    ]);
  }
  editor.removeVertices(removed);
}

export function extrudeFaces(input: TopologyMesh, request: FaceExtrusion) {
  checkDistance(request.distance, 'Extrusion distance');
  const topology = buildTopology(input);
  const faces = faceSelection(topology, request.selection);
  const editor = new MeshEditor(topology.mesh);
  const groups = request.mode === 'individual' ? faces.map((face) => [face]) : [faces];
  const mappings = new Map<number, number[]>();
  for (const group of groups)
    for (const [old, created] of extrudeGroup(topology, editor, group, request))
      mappings.set(old, [...(mappings.get(old) ?? []), created]);
  pruneUnused(editor, new Set(mappings.keys()), mappings);
  return editor.finish();
}

function offsetPolygon(points: Vector2[], distance: number): Vector2[] {
  const offset = points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const incoming = point.clone().sub(previous).normalize();
    const outgoing = next.clone().sub(point).normalize();
    const first = new Vector2(-incoming.y, incoming.x);
    const second = new Vector2(-outgoing.y, outgoing.x);
    const bisector = first.clone().add(second);
    const denominator = bisector.dot(first);
    if (Math.abs(denominator) < 1e-8)
      throw new TopologyError('Inset cannot offset a reversing corner', 'INVALID_INSET');
    return point.clone().add(bisector.multiplyScalar(distance / denominator));
  });
  if (
    !simplePolygon(offset) ||
    Math.sign(ShapeUtils.area(offset)) !== Math.sign(ShapeUtils.area(points)) ||
    Math.abs(ShapeUtils.area(offset)) < 1e-8 ||
    offset.some((point, index) => {
      const before = points[(index + 1) % points.length].clone().sub(points[index]);
      const after = offset[(index + 1) % points.length].clone().sub(point);
      return before.dot(after) <= 0;
    })
  )
    throw new TopologyError('Inset thickness collapses or crosses the boundary', 'INVALID_INSET');
  return offset;
}

function insetGroup(topology: MeshTopology, editor: MeshEditor, faces: number[], request: FaceInset) {
  const frame = planarRegion(topology.mesh, faces);
  const loops = regionBoundaries(topology, faces);
  if (!loops.length) throw new TopologyError('Inset requires an open region boundary');
  const positions = new Map<number, TopologyVector>();
  for (const loop of loops) {
    const points = loop.vertices.map(frame.project);
    if (!simplePolygon(points)) throw new TopologyError('Inset requires simple boundary loops');
    const offset = offsetPolygon(points, request.thickness);
    loop.vertices.forEach((vertex, index) =>
      positions.set(
        vertex,
        frame.origin
          .clone()
          .addScaledVector(frame.u, offset[index].x)
          .addScaledVector(frame.v, offset[index].y)
          .addScaledVector(frame.normal, request.depth ?? 0)
          .toArray() as TopologyVector,
      ),
    );
  }
  const vertices = [...new Set(faces.flatMap((face) => topology.mesh.faces[face]))];
  const inner = new Map(
    vertices.map((vertex) => [
      vertex,
      editor.addVertex(
        positions.get(vertex) ??
          (new Vector3(...topology.mesh.vertices[vertex])
            .addScaledVector(frame.normal, request.depth ?? 0)
            .toArray() as TopologyVector),
      ),
    ]),
  );
  for (const face of faces) {
    const indices = topology.mesh.faces[face].map((vertex) => inner.get(vertex)!);
    const points = indices.map((vertex) => {
      const point = new Vector3(...editor.mesh.vertices[vertex]).sub(frame.origin);
      return new Vector2(point.dot(frame.u), point.dot(frame.v));
    });
    if (!simplePolygon(points) || ShapeUtils.area(points) <= 1e-8)
      throw new TopologyError('Inset thickness inverts an interior face', 'INVALID_INSET');
    editor.replaceFace(face, indices);
  }
  for (const loop of loops)
    for (let index = 0; index < loop.vertices.length; index++) {
      const left = loop.vertices[index];
      const right = loop.vertices[(index + 1) % loop.vertices.length];
      editor.addFace([left, right, inner.get(right)!, inner.get(left)!]);
    }
  return inner;
}

export function insetFaces(input: TopologyMesh, request: FaceInset) {
  checkDistance(request.thickness, 'Inset thickness', true);
  if (request.depth !== undefined && (!Number.isFinite(request.depth) || Math.abs(request.depth) > 100000))
    throw new TopologyError('Inset depth must be finite and within 100000 meters');
  const topology = buildTopology(input);
  const faces = faceSelection(topology, request.selection);
  const editor = new MeshEditor(topology.mesh);
  const groups = request.mode === 'individual' ? faces.map((face) => [face]) : [faces];
  const mappings = new Map<number, number[]>();
  for (const group of groups)
    for (const [old, created] of insetGroup(topology, editor, group, request))
      mappings.set(old, [...(mappings.get(old) ?? []), created]);
  pruneUnused(editor, new Set(mappings.keys()), mappings);
  return editor.finish();
}
