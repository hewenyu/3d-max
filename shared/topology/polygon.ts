import type { Vector2 } from 'three';

function orient(a: Vector2, b: Vector2, c: Vector2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function simplePolygon(points: Vector2[], epsilon = 1e-10): boolean {
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    if (a.distanceTo(b) < epsilon) return false;
    for (let other = index + 2; other < points.length; other++) {
      if (index === 0 && other === points.length - 1) continue;
      const c = points[other];
      const d = points[(other + 1) % points.length];
      const abC = orient(a, b, c);
      const abD = orient(a, b, d);
      const cdA = orient(c, d, a);
      const cdB = orient(c, d, b);
      if (abC * abD < -epsilon && cdA * cdB < -epsilon) return false;
      const touches = (p: Vector2, q: Vector2, r: Vector2, signed: number) =>
        Math.abs(signed) <= epsilon &&
        r.x >= Math.min(p.x, q.x) - epsilon &&
        r.x <= Math.max(p.x, q.x) + epsilon &&
        r.y >= Math.min(p.y, q.y) - epsilon &&
        r.y <= Math.max(p.y, q.y) + epsilon;
      if (touches(a, b, c, abC) || touches(a, b, d, abD) || touches(c, d, a, cdA) || touches(c, d, b, cdB))
        return false;
    }
  }
  return true;
}
