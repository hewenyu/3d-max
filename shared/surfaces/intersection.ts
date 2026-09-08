import { Plane, Vector3 } from 'three';
import type { ExtendedTriangle } from 'three-mesh-bvh';
import { SURFACE_LIMITS } from './schema';

export function trianglesIntersect(a: ExtendedTriangle, b: ExtendedTriangle): boolean {
  const pointsA = [a.a, a.b, a.c],
    pointsB = [b.a, b.b, b.c];
  const planeA = a.getPlane(new Plane()),
    planeB = b.getPlane(new Plane());
  const scale = Math.max(1, ...[...pointsA, ...pointsB].map((point) => point.distanceTo(a.a)));
  const parallel = new Vector3().crossVectors(planeA.normal, planeB.normal).lengthSq() < 1e-10;
  const coplanar =
    parallel &&
    pointsB.every(
      (point) => Math.abs(planeA.distanceToPoint(point)) <= SURFACE_LIMITS.epsilon + scale * 1e-12,
    );
  if (!coplanar) return a.intersectsTriangle(b);
  // Rotated caps accumulate roundoff that can send the library's exact plane test down its noncoplanar path.
  const axis = new Vector3();
  for (const points of [pointsA, pointsB]) {
    for (let edge = 0; edge < 3; edge++) {
      axis
        .subVectors(points[(edge + 1) % 3], points[edge])
        .cross(planeA.normal)
        .normalize();
      const project = (point: Vector3) => axis.dot(new Vector3().subVectors(point, a.a));
      const left = pointsA.map(project),
        right = pointsB.map(project);
      if (
        Math.max(...left) < Math.min(...right) - scale * 1e-12 ||
        Math.max(...right) < Math.min(...left) - scale * 1e-12
      )
        return false;
    }
  }
  return true;
}
