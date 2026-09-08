import { CubicBezierCurve3, Curve, LineCurve3, Vector3 } from 'three';
import { SurfaceError, SURFACE_LIMITS, type SurfaceCurve2, type SurfaceCurve3 } from './schema';

export type Point2 = [number, number];
export type Point3 = [number, number, number];
const epsilon = SURFACE_LIMITS.epsilon;

function rejectInteriorCusp(curve: CubicBezierCurve3, span: number) {
  const a = curve.v3
    .clone()
    .addScaledVector(curve.v2, -3)
    .addScaledVector(curve.v1, 3)
    .sub(curve.v0)
    .multiplyScalar(3);
  const b = curve.v2.clone().addScaledVector(curve.v1, -2).add(curve.v0).multiplyScalar(6);
  const c = curve.v1.clone().sub(curve.v0).multiplyScalar(3);
  const axis = [0, 1, 2].sort(
    (left, right) =>
      Math.abs(a.getComponent(right)) +
      Math.abs(b.getComponent(right)) +
      Math.abs(c.getComponent(right)) -
      Math.abs(a.getComponent(left)) -
      Math.abs(b.getComponent(left)) -
      Math.abs(c.getComponent(left)),
  )[0];
  const aa = a.getComponent(axis),
    bb = b.getComponent(axis),
    cc = c.getComponent(axis);
  const discriminant = bb * bb - 4 * aa * cc;
  const roots =
    Math.abs(aa) < epsilon
      ? Math.abs(bb) < epsilon
        ? []
        : [-cc / bb]
      : discriminant < 0
        ? []
        : [(-bb - Math.sqrt(discriminant)) / (2 * aa), (-bb + Math.sqrt(discriminant)) / (2 * aa)];
  for (const time of roots) {
    if (
      time <= 1e-8 ||
      time >= 1 - 1e-8 ||
      a
        .clone()
        .multiplyScalar(time * time)
        .addScaledVector(b, time)
        .add(c)
        .length() > epsilon
    )
      continue;
    const incoming = curve
      .getPoint(time)
      .sub(curve.getPoint(time - 1e-5))
      .normalize();
    const outgoing = curve
      .getPoint(time + 1e-5)
      .sub(curve.getPoint(time))
      .normalize();
    if (incoming.dot(outgoing) < -0.99)
      throw new SurfaceError(
        'A Bezier span contains an interior reversing cusp; edit its handles',
        'SURFACE_CUSP',
        { span, time },
      );
  }
}

export class SurfacePath extends Curve<Vector3> {
  readonly spans: Curve<Vector3>[];
  readonly closed: boolean;

  constructor(source: SurfaceCurve3) {
    super();
    this.closed = source.closed;
    if (source.closed && source.points.length < 3)
      throw new SurfaceError('A closed path requires at least three distinct knots', 'SURFACE_CURVE');
    const spanCount = source.points.length - (source.closed ? 0 : 1);
    this.spans = Array.from({ length: spanCount }, (_, index) => {
      const a = source.points[index];
      const b = source.points[(index + 1) % source.points.length];
      const start = new Vector3(...a.position);
      const end = new Vector3(...b.position);
      if (start.distanceTo(end) <= epsilon)
        throw new SurfaceError(
          'Adjacent knots must be distinct; closed paths close automatically',
          'SURFACE_CURVE',
          { span: index },
        );
      if (!a.outTangent && !b.inTangent) return new LineCurve3(start, end);
      const chord = end.clone().sub(start);
      const outgoing = a.outTangent ? new Vector3(...a.outTangent) : chord.clone().multiplyScalar(1 / 3);
      const incoming = b.inTangent ? new Vector3(...b.inTangent) : chord.clone().multiplyScalar(-1 / 3);
      const curve = new CubicBezierCurve3(start, start.clone().add(outgoing), end.clone().add(incoming), end);
      rejectInteriorCusp(curve, index);
      return curve;
    });
  }

  private location(time: number) {
    const t = Math.min(1, Math.max(0, time));
    const scaled = t * this.spans.length;
    const index = Math.min(this.spans.length - 1, Math.floor(scaled));
    return { index, local: scaled - index };
  }

  getPoint(time: number, target = new Vector3()): Vector3 {
    const { index, local } = this.location(time);
    return this.spans[index].getPoint(local, target);
  }

  getPointAt(time: number, target = new Vector3()): Vector3 {
    return this.getPoint(time, target);
  }

  private spanTangent(index: number, local: number) {
    const span = this.spans[index];
    const tangent = span.getTangent(local);
    if (tangent.lengthSq() <= epsilon * epsilon) {
      const before = span.getPoint(Math.max(0, local - 1e-5));
      tangent
        .copy(span.getPoint(Math.min(1, local + 1e-5)))
        .sub(before)
        .normalize();
    }
    if (tangent.lengthSq() <= epsilon * epsilon)
      throw new SurfaceError('The curve has a stationary or collapsed tangent', 'SURFACE_CUSP', {
        span: index,
        local,
      });
    return tangent;
  }

  getTangent(time: number, target = new Vector3()): Vector3 {
    const { index, local } = this.location(time);
    let tangent = this.spanTangent(index, local);
    if (local <= 1e-10 && (index > 0 || this.closed)) {
      const previous = this.spanTangent((index + this.spans.length - 1) % this.spans.length, 1);
      if (previous.dot(tangent) < -0.999)
        throw new SurfaceError(
          'A reversing cusp needs separate segments or edited tangents',
          'SURFACE_CUSP',
          { knot: index },
        );
      tangent = tangent.add(previous).normalize();
    } else if (time === 1 && this.closed) return this.getTangent(0, target);
    return target.copy(tangent);
  }

  getTangentAt(time: number, target = new Vector3()): Vector3 {
    return this.getTangent(time, target);
  }
}

export function pathFrom2(source: SurfaceCurve2): SurfacePath {
  return new SurfacePath({
    closed: source.closed,
    points: source.points.map((knot) => ({
      position: [knot.position[0], knot.position[1], 0],
      ...(knot.inTangent ? { inTangent: [knot.inTangent[0], knot.inTangent[1], 0] as Point3 } : {}),
      ...(knot.outTangent ? { outTangent: [knot.outTangent[0], knot.outTangent[1], 0] as Point3 } : {}),
    })),
  });
}

export function sampleProfileCurve(source: SurfaceCurve2, subdivisions: number): Point2[] {
  const curve = pathFrom2(source);
  const segments = curve.spans.length * subdivisions;
  const count = source.closed ? segments : segments + 1;
  return Array.from({ length: count }, (_, i) => {
    const point = curve.getPoint(i / segments);
    return [point.x, point.y];
  });
}

export function reverseProfileCurve(source: SurfaceCurve2): SurfaceCurve2 {
  const points = source.closed
    ? [source.points[0], ...source.points.slice(1).reverse()]
    : source.points.slice().reverse();
  return {
    closed: source.closed,
    points: points.map((knot) => ({
      position: [...knot.position],
      ...(knot.outTangent ? { inTangent: [...knot.outTangent] as Point2 } : {}),
      ...(knot.inTangent ? { outTangent: [...knot.inTangent] as Point2 } : {}),
    })),
  };
}

export function validateSampledPath(path: SurfacePath, segments: number): Vector3[] {
  const points = Array.from({ length: segments + 1 }, (_, i) => path.getPoint(i / segments));
  for (let i = 0; i < segments; i++) {
    if (points[i].distanceTo(points[i + 1]) <= epsilon)
      throw new SurfaceError('A sampled path segment collapsed; edit the source curve', 'SURFACE_CURVE', {
        segment: i,
      });
    const tangent = path.getTangent(i / segments);
    const next = path.getTangent((i + 1) / segments);
    if (tangent.dot(next) < -0.95)
      throw new SurfaceError(
        'Path sampling crosses a reversing cusp; edit tangents or increase segments',
        'SURFACE_CUSP',
        { segment: i },
      );
  }
  return points;
}
