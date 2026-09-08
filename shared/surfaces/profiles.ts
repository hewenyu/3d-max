import { ShapeUtils, Vector2 } from 'three';
import { reverseProfileCurve, sampleProfileCurve, type Point2 } from './curves';
import { SurfaceError, SURFACE_LIMITS, type SurfaceProfile } from './schema';

const epsilon = SURFACE_LIMITS.epsilon;
export const cross2 = (a: Point2, b: Point2, c: Point2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
export const area2 = (points: Point2[]) =>
  points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;

function onSegment(point: Point2, a: Point2, b: Point2) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return (
    Math.abs(cross2(a, b, point)) <= epsilon * Math.max(1, length) &&
    point[0] >= Math.min(a[0], b[0]) - epsilon &&
    point[0] <= Math.max(a[0], b[0]) + epsilon &&
    point[1] >= Math.min(a[1], b[1]) - epsilon &&
    point[1] <= Math.max(a[1], b[1]) + epsilon
  );
}

function intersects(a: Point2, b: Point2, c: Point2, d: Point2) {
  const abC = cross2(a, b, c),
    abD = cross2(a, b, d);
  const cdA = cross2(c, d, a),
    cdB = cross2(c, d, b);
  return (
    (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) &&
      ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) ||
    onSegment(c, a, b) ||
    onSegment(d, a, b) ||
    onSegment(a, c, d) ||
    onSegment(b, c, d)
  );
}

export function validateContour(points: Point2[], closed = true, label = 'profile') {
  if (points.length < (closed ? 3 : 2))
    throw new SurfaceError(`${label} has too few points`, 'SURFACE_PROFILE');
  const edges = closed ? points.length : points.length - 1;
  for (let i = 0; i < edges; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= epsilon)
      throw new SurfaceError(`${label} has a collapsed edge`, 'SURFACE_PROFILE', { edge: i });
    if (closed || i + 1 < edges) {
      const c = points[(i + 2) % points.length];
      if (
        Math.abs(cross2(a, b, c)) < epsilon * epsilon &&
        (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0
      )
        throw new SurfaceError(`${label} has a reversing spike`, 'SURFACE_PROFILE_INTERSECTION', { edge: i });
    }
    for (let j = i + 1; j < edges; j++) {
      if (j === i + 1 || (closed && i === 0 && j === edges - 1)) continue;
      if (intersects(a, b, points[j], points[(j + 1) % points.length]))
        throw new SurfaceError(`${label} self-intersects or touches itself`, 'SURFACE_PROFILE_INTERSECTION', {
          edges: [i, j],
        });
    }
  }
  if (closed && Math.abs(area2(points)) <= epsilon * epsilon)
    throw new SurfaceError(`${label} encloses no area`, 'SURFACE_PROFILE');
}

function inside(point: Point2, polygon: Point2[]) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      result = !result;
  }
  return result;
}

export interface SampledProfile {
  loops: Point2[][];
  points: Point2[];
  offsets: number[];
  knotCounts: number[];
}

export function sampleProfile(profile: SurfaceProfile, subdivisions: number): SampledProfile {
  const sources = [profile.outer, ...profile.holes];
  const sampleCount = sources.reduce((count, curve) => count + curve.points.length * subdivisions, 0);
  if (sampleCount > SURFACE_LIMITS.profilePoints)
    throw new SurfaceError('A sampled section may contain at most 2048 contour points', 'SURFACE_LIMIT', {
      sampleCount,
    });
  const loops = sources.map((curve, index) => {
    if (!curve.closed)
      throw new SurfaceError('Sweep and loft section contours must be closed', 'SURFACE_PROFILE', {
        loop: index,
      });
    let points = sampleProfileCurve(curve, subdivisions);
    validateContour(points, true, `profile loop ${index}`);
    if (area2(points) > 0 !== (index === 0))
      points = sampleProfileCurve(reverseProfileCurve(curve), subdivisions);
    return points;
  });
  for (let a = 0; a < loops.length; a++) {
    for (let b = a + 1; b < loops.length; b++) {
      for (let i = 0; i < loops[a].length; i++)
        for (let j = 0; j < loops[b].length; j++) {
          if (
            intersects(
              loops[a][i],
              loops[a][(i + 1) % loops[a].length],
              loops[b][j],
              loops[b][(j + 1) % loops[b].length],
            )
          )
            throw new SurfaceError(
              'Profile contours must not intersect or touch',
              'SURFACE_PROFILE_INTERSECTION',
              { loops: [a, b] },
            );
        }
      if (a > 0 && (inside(loops[a][0], loops[b]) || inside(loops[b][0], loops[a])))
        throw new SurfaceError(
          'Nested holes are not supported; use a separate outer contour',
          'SURFACE_PROFILE',
          { loops: [a, b] },
        );
    }
  }
  loops.slice(1).forEach((hole, index) => {
    if (!inside(hole[0], loops[0]))
      throw new SurfaceError('Every hole must lie strictly inside the outer contour', 'SURFACE_PROFILE', {
        hole: index,
      });
  });
  let offset = 0;
  return {
    loops,
    points: loops.flat(),
    offsets: loops.map((loop) => {
      const current = offset;
      offset += loop.length;
      return current;
    }),
    knotCounts: sources.map((curve) => curve.points.length),
  };
}

export function triangulateProfile(profile: Pick<SampledProfile, 'loops' | 'points'>): number[][] {
  let offset = 0;
  const retained = profile.loops.map((loop) => {
    const indices = loop.map((_, index) => offset + index);
    offset += loop.length;
    return indices.filter(
      (index, local) =>
        Math.abs(
          cross2(
            loop[(local + loop.length - 1) % loop.length],
            profile.points[index],
            loop[(local + 1) % loop.length],
          ),
        ) >
        epsilon * epsilon,
    );
  });
  const originalIndices = retained.flat();
  if (retained.some((loop) => loop.length < 3))
    throw new SurfaceError('The profile cannot be triangulated', 'SURFACE_PROFILE');
  const triangles = ShapeUtils.triangulateShape(
    retained[0].map((index) => new Vector2(...profile.points[index])),
    retained.slice(1).map((loop) => loop.map((index) => new Vector2(...profile.points[index]))),
  )
    .map((face) => face.map((index) => originalIndices[index]))
    .map((face) =>
      cross2(...(face.map((index) => profile.points[index]) as [Point2, Point2, Point2])) > 0
        ? face
        : face.reverse(),
    );
  if (!triangles.length) throw new SurfaceError('The profile cannot be triangulated', 'SURFACE_PROFILE');
  // Earcut can omit collinear boundary vertices. Reinsert them so cap and wall edges agree exactly.
  for (let vertex = 0; vertex < profile.points.length; vertex++) {
    if (triangles.some((face) => face.includes(vertex))) continue;
    const point = profile.points[vertex];
    let inserted = false;
    for (let i = 0; i < triangles.length && !inserted; i++) {
      const face = triangles[i];
      for (let edge = 0; edge < 3; edge++) {
        const a = face[edge],
          b = face[(edge + 1) % 3],
          c = face[(edge + 2) % 3];
        if (onSegment(point, profile.points[a], profile.points[b])) {
          triangles.splice(i, 1, [a, vertex, c], [vertex, b, c]);
          inserted = true;
          break;
        }
      }
    }
    if (!inserted)
      throw new SurfaceError('Triangulation could not preserve a contour vertex', 'SURFACE_PROFILE', {
        vertex,
      });
  }
  return triangles;
}
