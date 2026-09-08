import { ShapeUtils, Vector2, Vector3 } from 'three';
import { buildTopology } from './adjacency';
import { MeshEditor } from './editor';
import { boundaryLoops, planarRegion, simplePolygon } from './regions';
import { resolveSelection } from './selection';
import { TopologyError, type ComponentSelection, type TopologyMesh, type TopologyVector } from './types';

function contains(points: Vector2[], point: Vector2): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index];
    const b = points[previous];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

export function fillBoundaries(
  input: TopologyMesh,
  request: { selection: ComponentSelection; triangulate?: boolean },
) {
  if (request.selection.kind !== 'edge') throw new TopologyError('Fill requires boundary edge selection');
  const topology = buildTopology(input);
  const loops = boundaryLoops(topology, resolveSelection(topology, request.selection));
  const editor = new MeshEditor(topology.mesh);
  const prepared = loops.map((loop) => {
    if (loop.vertices.length > (request.triangulate ? 2048 : 256))
      throw new TopologyError('Boundary exceeds the fill polygon capacity', 'TOPOLOGY_LIMIT');
    const face = [...loop.vertices].reverse();
    const temporary = { ...topology.mesh, faces: [face] };
    const frame = planarRegion(temporary, [0]);
    const points = face.map(frame.project);
    if (!simplePolygon(points)) throw new TopologyError('Fill boundary crosses itself', 'SELF_INTERSECTION');
    return { face, frame, points, area: Math.abs(ShapeUtils.area(points)), parent: -1 };
  });
  prepared.forEach((loop, index) => {
    for (let outer = 0; outer < prepared.length; outer++) {
      if (index === outer) continue;
      const candidate = prepared[outer];
      if (
        candidate.area <= loop.area ||
        Math.abs(candidate.frame.normal.dot(loop.frame.normal)) < 1 - 1e-6 ||
        loop.face.some(
          (vertex) =>
            Math.abs(
              new Vector3(...input.vertices[vertex]).sub(candidate.frame.origin).dot(candidate.frame.normal),
            ) > 1e-6,
        )
      )
        continue;
      if (
        contains(candidate.points, candidate.frame.project(loop.face[0])) &&
        (loop.parent < 0 || candidate.area < prepared[loop.parent].area)
      )
        loop.parent = outer;
    }
  });
  const depth = (index: number): number =>
    prepared[index].parent < 0 ? 0 : 1 + depth(prepared[index].parent);
  prepared.forEach((loop, index) => {
    if (depth(index) % 2) return;
    const holes = prepared.filter((candidate, child) => candidate.parent === index && depth(child) % 2 === 1);
    if (holes.some((hole) => hole.frame.normal.dot(loop.frame.normal) > -1 + 1e-6))
      throw new TopologyError('Nested fill boundaries must have opposite winding', 'INCONSISTENT_BOUNDARY');
    const holePoints = holes.map((hole) => hole.face.map(loop.frame.project));
    if (request.triangulate || holes.length) {
      const all = [...loop.face, ...holes.flatMap((hole) => hole.face)];
      const triangles = ShapeUtils.triangulateShape(loop.points, holePoints);
      if (triangles.length !== all.length + 2 * holes.length - 2)
        throw new TopologyError('Boundary triangulation failed');
      for (const triangle of triangles) {
        const vertices = triangle.map((point) => all[point]);
        const a = new Vector3(...input.vertices[vertices[0]]);
        const b = new Vector3(...input.vertices[vertices[1]]);
        const c = new Vector3(...input.vertices[vertices[2]]);
        if (b.sub(a).cross(c.sub(a)).dot(loop.frame.normal) < 0) vertices.reverse();
        editor.addFace(vertices);
      }
    } else editor.addFace(loop.face);
  });
  return editor.finish();
}

export function bridgeBoundaries(
  input: TopologyMesh,
  request: { selection: ComponentSelection; segments?: number; twist?: number },
) {
  if (request.selection.kind !== 'edge') throw new TopologyError('Bridge requires boundary edge selection');
  const topology = buildTopology(input);
  const loops = boundaryLoops(topology, resolveSelection(topology, request.selection));
  if (loops.length !== 2) throw new TopologyError('Bridge requires exactly two complete boundary loops');
  const [leftLoop, rightLoop] = loops;
  const count = leftLoop.vertices.length;
  if (count !== rightLoop.vertices.length)
    throw new TopologyError('Bridge loops must have the same vertex count', 'INCOMPATIBLE_LOOPS');
  if (count > 2048) throw new TopologyError('Bridge loops exceed capacity', 'TOPOLOGY_LIMIT');
  if (leftLoop.vertices.some((vertex) => rightLoop.vertices.includes(vertex)))
    throw new TopologyError('Bridge loops must not share vertices');
  const segments = request.segments ?? 1;
  const twist = request.twist ?? 0;
  if (
    !Number.isInteger(segments) ||
    segments < 1 ||
    segments > 64 ||
    !Number.isInteger(twist) ||
    Math.abs(twist) > count
  )
    throw new TopologyError('Bridge segments must be 1..64 and twist an integer within the loop size');
  const left = leftLoop.vertices;
  const reversed = [...rightLoop.vertices].reverse();
  let best = Infinity;
  let start = 0;
  for (let offset = 0; offset < count; offset++) {
    let distance = 0;
    for (let index = 0; index < count; index++)
      distance += new Vector3(...input.vertices[left[index]]).distanceToSquared(
        new Vector3(...input.vertices[reversed[(index + offset) % count]]),
      );
    if (distance < best) {
      best = distance;
      start = offset;
    }
  }
  const right = left.map((_, index) => reversed[(index + start + twist + count) % count]);
  const editor = new MeshEditor(topology.mesh);
  const rings = [left];
  for (let segment = 1; segment < segments; segment++)
    rings.push(
      left.map((vertex, index) =>
        editor.addVertex(
          new Vector3(...input.vertices[vertex])
            .lerp(new Vector3(...input.vertices[right[index]]), segment / segments)
            .toArray() as TopologyVector,
        ),
      ),
    );
  rings.push(right);
  for (let ring = 0; ring < rings.length - 1; ring++)
    for (let index = 0; index < count; index++) {
      const next = (index + 1) % count;
      editor.addFace([rings[ring][index], rings[ring + 1][index], rings[ring + 1][next], rings[ring][next]]);
    }
  return editor.finish();
}
