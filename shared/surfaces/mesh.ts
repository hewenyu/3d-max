import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { normalOffset } from '../normal-offset';
import { ExtendedTriangle, MeshBVH } from 'three-mesh-bvh';
import type { MeshData } from '../modeling';
import type { Point2, Point3 } from './curves';
import { triangulateProfile, validateContour } from './profiles';
import { SurfaceError, SURFACE_LIMITS } from './schema';
import { trianglesIntersect } from './intersection';

const epsilon = SURFACE_LIMITS.epsilon;

export function checkSurfaceBudget(vertices: number, triangles: number) {
  if (vertices > SURFACE_LIMITS.vertices || triangles > SURFACE_LIMITS.triangles)
    throw new SurfaceError(
      'Reduce surface segments: generated meshes are limited to 70000 vertices and 150000 triangles',
      'SURFACE_LIMIT',
      { vertices, triangles },
    );
}

export function triangulatedFaces(mesh: MeshData): number[][] {
  const triangles: number[][] = [];
  for (const [faceIndex, face] of mesh.faces.entries()) {
    if (
      face.length < 3 ||
      new Set(face).size !== face.length ||
      face.some((index) => !Number.isInteger(index) || index < 0 || index >= mesh.vertices.length)
    )
      throw new SurfaceError('A face contains invalid or repeated vertex indices', 'SURFACE_TOPOLOGY', {
        face: faceIndex,
      });
    if (face.length === 3) {
      triangles.push(face);
      continue;
    }
    const normal = new Vector3();
    face.forEach((index, i) => {
      const a = mesh.vertices[index],
        b = mesh.vertices[face[(i + 1) % face.length]];
      normal.x += (a[1] - b[1]) * (a[2] + b[2]);
      normal.y += (a[2] - b[2]) * (a[0] + b[0]);
      normal.z += (a[0] - b[0]) * (a[1] + b[1]);
    });
    if (normal.lengthSq() <= epsilon ** 4)
      throw new SurfaceError('A face has no area', 'SURFACE_DEGENERATE', { face: faceIndex });
    const axes = [0, 1, 2].filter(
      (axis) =>
        axis !==
        normal
          .toArray()
          .map(Math.abs)
          .indexOf(Math.max(...normal.toArray().map(Math.abs))),
    );
    const contour: Point2[] = face.map((index) => [
      mesh.vertices[index][axes[0]],
      mesh.vertices[index][axes[1]],
    ]);
    validateContour(contour, true, `mesh face ${faceIndex}`);
    for (const triangle of triangulateProfile({ loops: [contour], points: contour })) {
      const indices = triangle.map((index) => face[index]);
      const a = new Vector3(...mesh.vertices[indices[0]]);
      const cross = new Vector3(...mesh.vertices[indices[1]])
        .sub(a)
        .cross(new Vector3(...mesh.vertices[indices[2]]).sub(a));
      triangles.push(cross.dot(normal) >= 0 ? indices : indices.reverse());
    }
  }
  return triangles;
}

function triangleNormal(vertices: Point3[], face: number[]) {
  const a = new Vector3(...vertices[face[0]]);
  return new Vector3(...vertices[face[1]]).sub(a).cross(new Vector3(...vertices[face[2]]).sub(a));
}

function edgeMap(faces: number[][]) {
  const edges = new Map<string, { from: number; to: number; face: number }[]>();
  faces.forEach((face, index) =>
    face.forEach((from, side) => {
      const to = face[(side + 1) % face.length];
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const incidents = edges.get(key) ?? [];
      incidents.push({ from, to, face: index });
      edges.set(key, incidents);
    }),
  );
  return edges;
}

function assertFiniteVertices(mesh: MeshData) {
  if (
    mesh.vertices.some((point) => point.some((value) => !Number.isFinite(value) || Math.abs(value) > 100000))
  )
    throw new SurfaceError('Mesh input contains nonfinite or out-of-range coordinates', 'SURFACE_RANGE');
}

export function assertNoSelfIntersections(mesh: MeshData): void {
  assertFiniteVertices(mesh);
  const faces = triangulatedFaces(mesh);
  checkSurfaceBudget(mesh.vertices.length, faces.length);
  if (!faces.length || faces.some((face) => triangleNormal(mesh.vertices, face).lengthSq() <= epsilon ** 4))
    throw new SurfaceError('Intersection input has an empty or degenerate triangle', 'SURFACE_DEGENERATE');
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float64Array(mesh.vertices.flat()), 3));
  geometry.setIndex(faces.flat());
  const tree = new MeshBVH(geometry, { indirect: true, targetLeafSize: 8 });
  let pairs = 0;
  const a = new ExtendedTriangle(),
    b = new ExtendedTriangle();
  const centerA = new Vector3(),
    centerB = new Vector3();
  let offending: [number, number] | undefined;
  try {
    tree.bvhcast(tree, new Matrix4(), {
      intersectsTriangles: (left, right, firstIndex, secondIndex) => {
        const first = tree.resolveTriangleIndex(firstIndex);
        const second = tree.resolveTriangleIndex(secondIndex);
        if (first >= second) return false;
        if (++pairs > SURFACE_LIMITS.intersectionPairs)
          throw new SurfaceError(
            'Self-intersection validation exceeded 3000000 candidate triangle pairs; simplify the input',
            'SURFACE_LIMIT',
            { pairs },
          );
        const shared = faces[first].some((index) => faces[second].includes(index));
        if (shared) {
          // Adjacent triangles legitimately meet on their indexed boundary. Test their interiors.
          left.getMidpoint(centerA);
          right.getMidpoint(centerB);
          a.set(
            left.a.clone().lerp(centerA, 1e-6),
            left.b.clone().lerp(centerA, 1e-6),
            left.c.clone().lerp(centerA, 1e-6),
          );
          b.set(
            right.a.clone().lerp(centerB, 1e-6),
            right.b.clone().lerp(centerB, 1e-6),
            right.c.clone().lerp(centerB, 1e-6),
          );
          a.needsUpdate = true;
          b.needsUpdate = true;
          if (!trianglesIntersect(a, b)) return false;
        } else if (!trianglesIntersect(left, right)) return false;
        offending = [first, second];
        return true;
      },
    });
    if (offending)
      throw new SurfaceError(
        'The evaluated surface self-intersects or has coincident nonadjacent faces',
        'SURFACE_SELF_INTERSECTION',
        { triangles: offending },
      );
  } finally {
    geometry.dispose();
  }
}

export function assertSurfaceMeshValid(
  mesh: MeshData,
  options: { closed?: boolean; selfIntersections?: boolean } = {},
): void {
  assertFiniteVertices(mesh);
  const faces = triangulatedFaces(mesh);
  checkSurfaceBudget(mesh.vertices.length, faces.length);
  if (mesh.vertices.length < 3 || !faces.length)
    throw new SurfaceError('The evaluated surface is empty', 'SURFACE_DEGENERATE');
  faces.forEach((face, index) => {
    if (triangleNormal(mesh.vertices, face).lengthSq() <= epsilon ** 4)
      throw new SurfaceError(
        'A generated triangle has zero area; edit the source controls',
        'SURFACE_DEGENERATE',
        { triangle: index },
      );
  });
  const incidentFaces = mesh.vertices.map(() => new Set<number>());
  const fans = mesh.vertices.map(() => new Map<number, number[]>());
  const boundaryDegrees = mesh.vertices.map(() => 0);
  mesh.faces.forEach((face, index) => face.forEach((vertex) => incidentFaces[vertex].add(index)));
  for (const [edge, incidents] of edgeMap(mesh.faces)) {
    if (incidents.length > 2 || (options.closed && incidents.length !== 2))
      throw new SurfaceError(
        'Generated topology has an unexpected boundary or a non-manifold edge',
        'SURFACE_TOPOLOGY',
        { edge, faces: incidents.map((item) => item.face) },
      );
    if (incidents.length === 2 && incidents[0].from === incidents[1].from)
      throw new SurfaceError('Adjacent faces have inconsistent winding', 'SURFACE_WINDING', { edge });
    for (const vertex of [incidents[0].from, incidents[0].to]) {
      if (incidents.length === 1) boundaryDegrees[vertex]++;
      else
        for (const [a, b] of [
          [incidents[0].face, incidents[1].face],
          [incidents[1].face, incidents[0].face],
        ]) {
          const connected = fans[vertex].get(a) ?? [];
          connected.push(b);
          fans[vertex].set(a, connected);
        }
    }
  }
  incidentFaces.forEach((incidents, vertex) => {
    if (!incidents.size)
      throw new SurfaceError('The evaluated surface contains an isolated vertex', 'SURFACE_TOPOLOGY', {
        vertex,
      });
    if (boundaryDegrees[vertex] !== 0 && boundaryDegrees[vertex] !== 2)
      throw new SurfaceError('A vertex has a non-manifold boundary fan', 'SURFACE_TOPOLOGY', { vertex });
    const visited = new Set<number>();
    const pending = [incidents.values().next().value!];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(fans[vertex].get(current) ?? []).filter((face) => !visited.has(face)));
    }
    if (visited.size !== incidents.size)
      throw new SurfaceError('A vertex joins disconnected face fans', 'SURFACE_TOPOLOGY', { vertex });
  });
  if (options.selfIntersections !== false) assertNoSelfIntersections(mesh);
}

export function shellMesh(mesh: MeshData, thickness: number): MeshData {
  if (!Number.isFinite(thickness) || thickness <= 0)
    throw new SurfaceError('Shell thickness must be positive and finite', 'SURFACE_THICKNESS');
  const faces = triangulatedFaces(mesh);
  const boundaries = [...edgeMap(faces).values()].filter((incidents) => incidents.length === 1);
  checkSurfaceBudget(mesh.vertices.length * 2, faces.length * 2 + boundaries.length * 2);
  const incidentNormals: Vector3[][] = mesh.vertices.map(() => []);
  for (const face of faces) {
    const normal = triangleNormal(mesh.vertices, face).normalize();
    face.forEach((index) => {
      if (!incidentNormals[index].some((previous) => previous.dot(normal) > 1 - 1e-10))
        incidentNormals[index].push(normal);
    });
  }
  const inner = mesh.vertices.map((point, index): Point3 => {
    const displacement = normalOffset(incidentNormals[index], 1e-8);
    const minimum = Math.min(...incidentNormals[index].map((normal) => normal.dot(displacement)));
    if (!Number.isFinite(minimum) || minimum <= 0)
      throw new SurfaceError('Thickness has no stable inward offset direction', 'SURFACE_THICKNESS', {
        vertex: index,
      });
    displacement.multiplyScalar(thickness / minimum);
    if (displacement.length() > thickness * 4)
      throw new SurfaceError(
        'Thickness requires a miter above 4x or a concave fold; reduce corner sharpness',
        'SURFACE_THICKNESS',
        { vertex: index },
      );
    return new Vector3(...point).sub(displacement).toArray() as Point3;
  });
  const offset = mesh.vertices.length;
  const result: MeshData = {
    kind: 'mesh',
    smooth: mesh.smooth,
    vertices: [...mesh.vertices.map((point) => [...point] as Point3), ...inner],
    faces: [
      ...faces.map((face) => [...face]),
      ...faces.map((face) => face.map((index) => index + offset).reverse()),
    ],
  };
  for (const incidents of edgeMap(faces).values())
    if (incidents.length === 1) {
      const { from: a, to: b } = incidents[0];
      result.faces.push([b, a, a + offset], [b, a + offset, b + offset]);
    }
  for (const [index, face] of faces.entries()) {
    const outer = triangleNormal(mesh.vertices, face),
      innerNormal = triangleNormal(inner, face);
    if (outer.dot(innerNormal) <= epsilon ** 4)
      throw new SurfaceError(
        'Thickness collapsed or inverted an inner face; reduce thickness',
        'SURFACE_THICKNESS',
        { triangle: index },
      );
  }
  assertSurfaceMeshValid(result, { closed: true });
  return result;
}
