import { CatmullRomCurve3, Euler, MathUtils, Vector3 } from 'three';
import type { MeshData } from '../modeling';
import { sampleProfileCurve, SurfacePath, validateSampledPath, type Point2, type Point3 } from './curves';
import { assertSurfaceMeshValid, checkSurfaceBudget, shellMesh } from './mesh';
import { area2, sampleProfile, triangulateProfile, validateContour, type SampledProfile } from './profiles';
import {
  surfaceDataSchema,
  SurfaceError,
  SURFACE_LIMITS,
  type SurfaceData,
  type SurfaceLoft,
  type SurfaceRevolve,
  type SurfaceSweep,
} from './schema';

const epsilon = SURFACE_LIMITS.epsilon;

class Builder {
  readonly mesh: MeshData;
  constructor(smooth: boolean) {
    this.mesh = { kind: 'mesh', vertices: [], faces: [], smooth };
  }
  vertex(point: Vector3 | Point3) {
    this.mesh.vertices.push(point instanceof Vector3 ? (point.toArray() as Point3) : point);
    return this.mesh.vertices.length - 1;
  }
  triangle(a: number, b: number, c: number) {
    if (a !== b && b !== c && c !== a) this.mesh.faces.push([a, b, c]);
  }
  quad(a: number, b: number, c: number, d: number) {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }
  cap(profile: Pick<SampledProfile, 'loops' | 'points'>, indices: number[], reverse: boolean) {
    for (const triangle of triangulateProfile(profile)) {
      const [a, b, c] = triangle.map((index) => indices[index]);
      this.triangle(a, reverse ? c : b, reverse ? b : c);
    }
  }
}

function joinProfileRings(builder: Builder, rings: number[][], profile: SampledProfile, closed: boolean) {
  const gaps = rings.length - (closed ? 0 : 1);
  for (let ring = 0; ring < gaps; ring++) {
    const next = (ring + 1) % rings.length;
    profile.loops.forEach((loop, l) =>
      loop.forEach((_, side) => {
        const a = profile.offsets[l] + side;
        const b = profile.offsets[l] + ((side + 1) % loop.length);
        builder.quad(rings[ring][a], rings[ring][b], rings[next][b], rings[next][a]);
      }),
    );
  }
}

function budget(rings: number, profilePoints: number, surface: SurfaceData) {
  const layers = surface.thickness > 0 ? 2 : 1;
  checkSurfaceBudget(
    rings * profilePoints * layers,
    (rings * profilePoints * 2 + profilePoints * 2) * layers,
  );
}

function sweepMesh(surface: SurfaceSweep): { mesh: MeshData; closed: boolean } {
  const profile = sampleProfile(surface.profile, surface.profileSegments);
  const path = new SurfacePath(surface.path);
  const segments = path.spans.length * surface.segments;
  if (surface.path.closed && segments < 3)
    throw new SurfaceError('Closed sweeps need at least three rings', 'SURFACE_LIMIT');
  const count = segments + (surface.path.closed ? 0 : 1);
  budget(count, profile.points.length, surface);
  const points = validateSampledPath(path, segments);
  const frames = path.computeFrenetFrames(segments, surface.path.closed);
  const builder = new Builder(surface.smooth);
  const rings = Array.from({ length: count }, (_, ring) =>
    profile.points.map(([x, y]) =>
      builder.vertex(
        points[ring]
          .clone()
          .addScaledVector(frames.normals[ring], x)
          .addScaledVector(frames.binormals[ring], y),
      ),
    ),
  );
  joinProfileRings(builder, rings, profile, surface.path.closed);
  if (surface.caps && !surface.path.closed) {
    builder.cap(profile, rings[0], true);
    builder.cap(profile, rings[rings.length - 1], false);
  }
  return { mesh: builder.mesh, closed: surface.path.closed || surface.caps };
}

function revolveMesh(surface: SurfaceRevolve): { mesh: MeshData; closed: boolean } {
  const samples =
    surface.profileSegments * (surface.profile.points.length - (surface.profile.closed ? 0 : 1)) +
    (surface.profile.closed ? 0 : 1);
  if (samples > SURFACE_LIMITS.profilePoints)
    throw new SurfaceError('A sampled meridian may contain at most 2048 points', 'SURFACE_LIMIT', {
      samples,
    });
  let profile = sampleProfileCurve(surface.profile, surface.profileSegments);
  validateContour(profile, surface.profile.closed, 'revolution meridian');
  profile.forEach(([radius], index) => {
    if (radius < -epsilon)
      throw new SurfaceError('Revolution radii must be nonnegative', 'SURFACE_RADIUS', { point: index });
    if (radius <= epsilon && (surface.profile.closed || (index > 0 && index < profile.length - 1)))
      throw new SurfaceError(
        'Only endpoints of an open meridian may touch the revolution axis',
        'SURFACE_AXIS',
        { point: index },
      );
  });
  const closeToAxis = (points: Point2[]): Point2[] => {
    const loop = points.map((point) => [...point] as Point2);
    if (loop[loop.length - 1][0] > epsilon) loop.push([0, loop[loop.length - 1][1]]);
    if (loop[0][0] > epsilon) loop.push([0, loop[0][1]]);
    return loop;
  };
  const region = surface.profile.closed ? profile : closeToAxis(profile);
  validateContour(region, true, 'revolution enclosed meridian');
  if (area2(region) < 0) profile = profile.slice().reverse();
  const contour = surface.profile.closed ? profile : surface.caps ? closeToAxis(profile) : profile;
  const loopClosed = surface.profile.closed || surface.caps;
  const full = Math.abs(surface.angle - 360) < 1e-9;
  if (full && surface.segments < 3)
    throw new SurfaceError('A full revolution requires at least three angular segments', 'SURFACE_LIMIT');
  const count = surface.segments + (full ? 0 : 1);
  budget(count, contour.length, surface);
  const builder = new Builder(surface.smooth);
  const poles = new Map<number, number>();
  const rings = Array.from({ length: count }, (_, ring) => {
    const angle = MathUtils.degToRad(surface.startAngle + (surface.angle * ring) / surface.segments);
    return contour.map(([radius, y]) => {
      if (radius <= epsilon) {
        const previous = poles.get(y);
        if (previous !== undefined) return previous;
        const index = builder.vertex([0, y, 0]);
        poles.set(y, index);
        return index;
      }
      return builder.vertex([radius * Math.cos(angle), y, -radius * Math.sin(angle)]);
    });
  });
  for (let ring = 0; ring < surface.segments; ring++) {
    const next = (ring + 1) % count;
    for (let side = 0; side < contour.length - (loopClosed ? 0 : 1); side++) {
      const following = (side + 1) % contour.length;
      builder.quad(rings[ring][side], rings[next][side], rings[next][following], rings[ring][following]);
    }
  }
  if (!full && surface.caps) {
    const cap = { points: contour, loops: [contour] };
    builder.cap(cap, rings[0], false);
    builder.cap(cap, rings[rings.length - 1], true);
  }
  const polesClose = profile[0][0] <= epsilon && profile[profile.length - 1][0] <= epsilon;
  return { mesh: builder.mesh, closed: surface.caps || (full && (surface.profile.closed || polesClose)) };
}

function loftMesh(surface: SurfaceLoft): { mesh: MeshData; closed: boolean } {
  if (surface.closed && surface.sections.length < 3)
    throw new SurfaceError('Closed lofts require at least three sections', 'SURFACE_LOFT');
  const profiles = surface.sections.map((section) => sampleProfile(section.profile, surface.profileSegments));
  const first = profiles[0];
  profiles.forEach((profile, index) => {
    if (
      profile.knotCounts.length !== first.knotCounts.length ||
      profile.knotCounts.some((count, loop) => count !== first.knotCounts[loop])
    )
      throw new SurfaceError(
        'Loft sections require matching contour, hole and knot counts; their first knot defines the seam',
        'SURFACE_LOFT_INCOMPATIBLE',
        { section: index },
      );
  });
  const sectionCount = surface.sections.length;
  const gaps = sectionCount - (surface.closed ? 0 : 1);
  const segmentCount = gaps * surface.segments;
  const count = segmentCount + (surface.closed ? 0 : 1);
  budget(count, first.points.length, surface);
  const normals: Vector3[] = [];
  const controls = surface.sections.map((section, index) => {
    const rotation = new Euler(...(section.rotation.map(MathUtils.degToRad) as Point3), 'XYZ');
    normals.push(new Vector3(0, 0, 1).applyEuler(rotation));
    return profiles[index].points.map(([x, y]) =>
      new Vector3(x, y, 0).applyEuler(rotation).add(new Vector3(...section.position)),
    );
  });
  const centers = surface.sections.map((section) => new Vector3(...section.position));
  const firstDirection = centers[1].clone().sub(centers[0]);
  const orientation = Math.sign(firstDirection.dot(normals[0]));
  if (orientation === 0)
    throw new SurfaceError(
      'Loft sections must advance through their section planes',
      'SURFACE_LOFT_INCOMPATIBLE',
    );
  centers.forEach((center, index) => {
    const previous = centers[index > 0 ? index - 1 : surface.closed ? sectionCount - 1 : 0];
    const next = centers[index < sectionCount - 1 ? index + 1 : surface.closed ? 0 : index];
    const travel = next.clone().sub(previous).normalize();
    if (
      travel.dot(normals[index]) * orientation <= 1e-4 ||
      (index < sectionCount - 1 && center.distanceTo(centers[index + 1]) <= epsilon)
    )
      throw new SurfaceError(
        'Loft section planes reverse, overlap or face across the travel direction',
        'SURFACE_LOFT_INCOMPATIBLE',
        { section: index },
      );
  });
  const paths =
    surface.interpolation === 'centripetal'
      ? first.points.map(
          (_, point) =>
            new CatmullRomCurve3(
              controls.map((section) => section[point]),
              surface.closed,
              'centripetal',
            ),
        )
      : undefined;
  const builder = new Builder(surface.smooth);
  const rings = Array.from({ length: count }, (_, ring) =>
    first.points.map((_, point) => {
      const time = ring / segmentCount;
      if (paths) return builder.vertex(paths[point].getPoint(time));
      const scaled = time * gaps;
      const section = Math.min(gaps - 1, Math.floor(scaled));
      return builder.vertex(
        controls[section][point]
          .clone()
          .lerp(controls[(section + 1) % sectionCount][point], scaled - section),
      );
    }),
  );
  joinProfileRings(builder, rings, first, surface.closed);
  if (surface.caps && !surface.closed) {
    builder.cap(first, rings[0], true);
    builder.cap(profiles[profiles.length - 1], rings[rings.length - 1], false);
  }
  if (orientation < 0) builder.mesh.faces.forEach((face) => face.reverse());
  return { mesh: builder.mesh, closed: surface.closed || surface.caps };
}

export function surfaceToMesh(input: SurfaceData): MeshData {
  const surface = surfaceDataSchema.parse(input);
  const generated =
    surface.operation === 'sweep'
      ? sweepMesh(surface)
      : surface.operation === 'revolve'
        ? revolveMesh(surface)
        : loftMesh(surface);
  assertSurfaceMeshValid(generated.mesh, { closed: generated.closed });
  return surface.thickness > 0 ? shellMesh(generated.mesh, surface.thickness) : generated.mesh;
}
