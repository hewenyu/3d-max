import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import type { MeshData } from '../shared/modeling';
import {
  assertNoSelfIntersections,
  assertSurfaceMeshValid,
  reverseProfileCurve,
  shellMesh,
  surfaceCommandDefinitions,
  surfaceDataSchema,
  surfaceToMesh,
  SurfaceError,
  SurfacePath,
  type SurfaceCurve2,
  type SurfaceData,
} from '../shared/surfaces';

const close = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
const contour = (points: [number, number][]): SurfaceCurve2 => ({
  closed: true,
  points: points.map((position) => ({ position })),
});
const square = (radius = 1) =>
  contour([
    [-radius, -radius],
    [radius, -radius],
    [radius, radius],
    [-radius, radius],
  ]);
const profile = (radius = 1) => ({ outer: square(radius), holes: [] });
const straight = { closed: false, points: [{ position: [0, 0, 0] }, { position: [0, 0, 4] }] };
const parse = (value: unknown): SurfaceData => surfaceDataSchema.parse(value);
const sweep = (overrides: Record<string, unknown> = {}) =>
  parse({
    kind: 'surface',
    operation: 'sweep',
    path: straight,
    profile: profile(),
    segments: 4,
    profileSegments: 2,
    ...overrides,
  });
const volume = (mesh: MeshData) =>
  mesh.faces.reduce((sum, face) => {
    const a = new Vector3(...mesh.vertices[face[0]]);
    for (let i = 1; i < face.length - 1; i++)
      sum +=
        a.dot(new Vector3(...mesh.vertices[face[i]]).cross(new Vector3(...mesh.vertices[face[i + 1]]))) / 6;
    return sum;
  }, 0);
function boundaryCount(mesh: MeshData) {
  const counts = new Map<string, number>();
  mesh.faces.forEach((face) =>
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }),
  );
  assert.ok([...counts.values()].every((count) => count <= 2));
  return [...counts.values()].filter((count) => count === 1).length;
}
function expectSurfaceError(callback: () => unknown, code: string) {
  assert.throws(callback, (error) => error instanceof SurfaceError && error.code === code);
}

test('Bezier surface schema retains source handles, defaults and strict command payload', () => {
  const definition = surfaceCommandDefinitions.find((item) => item.type === 'surface.set')!;
  const value = definition.schema.parse({ id: 'shape', surface: sweep() });
  assert.equal(value.surface.kind, 'surface');
  assert.equal(value.surface.caps, true);
  assert.equal(value.surface.thickness, 0);
  assert.equal(value.surface.smooth, true);
  assert.throws(() => definition.schema.parse({ id: 'shape', surface: { ...sweep(), unknown: true } }));
  assert.throws(() => sweep({ segments: 257 }));
  assert.throws(() => sweep({ thickness: -1 }));
});

test('straight custom-profile sweep is outward and watertight including sampled collinear cap vertices', () => {
  const source = sweep();
  const original = structuredClone(source);
  const mesh = surfaceToMesh(source);
  assert.deepEqual(source, original);
  close(volume(mesh), 16);
  assert.equal(boundaryCount(mesh), 0);
  assert.equal(mesh.vertices.length, 40);
  assertSurfaceMeshValid(mesh, { closed: true });
});

test('holes keep inward wall winding and cap holes remain open through a solid extrusion', () => {
  const mesh = surfaceToMesh(sweep({ profile: { outer: square(2), holes: [square(1)] } }));
  close(volume(mesh), 48);
  assert.equal(boundaryCount(mesh), 0);
  const reversed = surfaceToMesh(
    sweep({ profile: { outer: reverseProfileCurve(square(2)), holes: [reverseProfileCurve(square(1))] } }),
  );
  close(volume(reversed), 48);
  assert.deepEqual(mesh, reversed);
});

test('path reversal preserves outward orientation and volume', () => {
  const mesh = surfaceToMesh(sweep({ path: { ...straight, points: straight.points.slice().reverse() } }));
  close(volume(mesh), 16);
  assert.equal(boundaryCount(mesh), 0);
});

test('Bezier handles change the evaluated sweep and retain a smooth inflection without a Frenet flip', () => {
  const source = sweep({
    profile: profile(0.1),
    segments: 24,
    path: {
      closed: false,
      points: [
        { position: [0, 0, 0], outTangent: [1.5, 0, 1] },
        { position: [0, 0, 4], inTangent: [-1.5, 0, -1] },
      ],
    },
  });
  const mesh = surfaceToMesh(source);
  assert.ok(mesh.vertices.some((point) => point[0] > 0.4));
  assert.ok(mesh.vertices.some((point) => point[0] < -0.4));
  assert.equal(boundaryCount(mesh), 0);
  const path = new SurfacePath((source as Extract<SurfaceData, { operation: 'sweep' }>).path);
  close(path.getPoint(0.5).x, 0);
  close(path.getPoint(0.5).z, 2);
  assert.ok(volume(mesh) > 0);
});

test('closed Bezier sweep welds the seam and has no end caps', () => {
  const k = 0.5522847498 * 3;
  const mesh = surfaceToMesh(
    sweep({
      profile: profile(0.15),
      segments: 12,
      path: {
        closed: true,
        points: [
          { position: [3, 0, 0], inTangent: [0, 0, -k], outTangent: [0, 0, k] },
          { position: [0, 0, 3], inTangent: [k, 0, 0], outTangent: [-k, 0, 0] },
          { position: [-3, 0, 0], inTangent: [0, 0, k], outTangent: [0, 0, -k] },
          { position: [0, 0, -3], inTangent: [-k, 0, 0], outTangent: [k, 0, 0] },
        ],
      },
    }),
  );
  assert.equal(boundaryCount(mesh), 0);
  assert.equal(mesh.vertices.length, 48 * 8);
  assert.ok(volume(mesh) > 1.5);
});

test('rotated planar sweep caps remain valid with odd sampling counts and inward shells', () => {
  for (const profileSegments of [4, 5, 7])
    for (const thickness of [0, 0.025]) {
      const mesh = surfaceToMesh(
        sweep({
          profile: profile(0.35),
          segments: 18,
          profileSegments,
          thickness,
          path: {
            closed: false,
            points: [
              { position: [0, 0, 0], outTangent: [0, 1.7, 1] },
              { position: [0, 0, 4], inTangent: [0, 2, -1] },
            ],
          },
        }),
      );
      assert.equal(boundaryCount(mesh), 0);
      assert.ok(volume(mesh) > 0);
    }
});

test('reversing path cusps, collapsed knots and self-crossing contours fail explicitly', () => {
  expectSurfaceError(
    () =>
      surfaceToMesh(
        sweep({
          path: {
            closed: false,
            points: [{ position: [0, 0, 0] }, { position: [0, 0, 4] }, { position: [0, 0, 1] }],
          },
        }),
      ),
    'SURFACE_CUSP',
  );
  expectSurfaceError(
    () =>
      surfaceToMesh(
        sweep({ path: { closed: false, points: [{ position: [0, 0, 0] }, { position: [0, 0, 0] }] } }),
      ),
    'SURFACE_CURVE',
  );
  expectSurfaceError(
    () =>
      surfaceToMesh(
        sweep({
          profile: {
            outer: contour([
              [-1, -1],
              [1, 1],
              [-1, 1],
              [1, -1],
            ]),
            holes: [],
          },
        }),
      ),
    'SURFACE_PROFILE_INTERSECTION',
  );
});

test('holes touching the boundary, overlapping holes and outside holes fail', () => {
  expectSurfaceError(
    () => surfaceToMesh(sweep({ profile: { outer: square(1), holes: [square(1)] } })),
    'SURFACE_PROFILE_INTERSECTION',
  );
  expectSurfaceError(
    () => surfaceToMesh(sweep({ profile: { outer: square(3), holes: [square(1), square(0.5)] } })),
    'SURFACE_PROFILE',
  );
  expectSurfaceError(
    () => surfaceToMesh(sweep({ profile: { outer: square(1), holes: [square(2)] } })),
    'SURFACE_PROFILE',
  );
});

test('full revolution makes a watertight cylinder, partial revolution caps the angular cuts', () => {
  const base = {
    kind: 'surface',
    operation: 'revolve',
    profile: { closed: false, points: [{ position: [1, 0] }, { position: [1, 2] }] },
    profileSegments: 3,
    segments: 32,
  };
  const full = surfaceToMesh(parse(base));
  close(volume(full), 32 * Math.sin((2 * Math.PI) / 32), 1e-5);
  assert.equal(boundaryCount(full), 0);
  const partial = surfaceToMesh(parse({ ...base, angle: 180, segments: 16 }));
  close(volume(partial), volume(full) / 2, 1e-5);
  assert.equal(boundaryCount(partial), 0);
  const reversed = surfaceToMesh(
    parse({ ...base, profile: { ...base.profile, points: base.profile.points.slice().reverse() } }),
  );
  close(volume(reversed), volume(full));
});

test('partial tapered revolution retains collinear meridian samples without zero-area caps', () => {
  const mesh = surfaceToMesh(
    parse({
      kind: 'surface',
      operation: 'revolve',
      angle: 270,
      startAngle: 15,
      segments: 32,
      profileSegments: 4,
      profile: {
        closed: false,
        points: [
          [0, 0],
          [1.2, 0],
          [1, 1.8],
          [0.65, 2.6],
          [0, 2.6],
        ].map((position) => ({ position })),
      },
    }),
  );
  assert.equal(boundaryCount(mesh), 0);
  assert.ok(volume(mesh) > 0);
});

test('off-axis closed revolution profile creates a toroidal solid and axis endpoints weld poles', () => {
  const ring = surfaceToMesh(
    parse({
      kind: 'surface',
      operation: 'revolve',
      profile: contour([
        [2, -0.5],
        [3, -0.5],
        [3, 0.5],
        [2, 0.5],
      ]),
      segments: 32,
      profileSegments: 2,
    }),
  );
  assert.equal(boundaryCount(ring), 0);
  close(volume(ring), 32 * Math.sin((2 * Math.PI) / 32) * 2.5, 1e-5);
  const cone = surfaceToMesh(
    parse({
      kind: 'surface',
      operation: 'revolve',
      profile: { closed: false, points: [{ position: [0, 2] }, { position: [1, 0] }] },
      segments: 24,
      profileSegments: 2,
    }),
  );
  assert.equal(boundaryCount(cone), 0);
  assert.ok(volume(cone) > 2);
});

test('open revolution and uncapped sweep preserve their boundaries; thickness closes their rims', () => {
  const source = sweep({ caps: false });
  const open = surfaceToMesh(source);
  assert.equal(boundaryCount(open), 16);
  const shell = surfaceToMesh({ ...source, thickness: 0.1 });
  assert.equal(boundaryCount(shell), 0);
  close(volume(shell), (4 - 1.8 * 1.8) * 4, 1e-5);
  assert.deepEqual(shell.vertices.slice(0, open.vertices.length), open.vertices);
  const cylinder = surfaceToMesh(
    parse({
      kind: 'surface',
      operation: 'revolve',
      caps: false,
      thickness: 0.1,
      profile: { closed: false, points: [{ position: [1, 0] }, { position: [1, 2] }] },
      segments: 24,
      profileSegments: 1,
    }),
  );
  assert.equal(boundaryCount(cylinder), 0);
  assert.ok(volume(cylinder) > 1);
});

test('shell thickness rejects collapsed/inverted geometry and self-intersections', () => {
  expectSurfaceError(() => surfaceToMesh(sweep({ thickness: 1 })), 'SURFACE_THICKNESS');
  const crossing: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [-1, -1, 0],
      [1, -1, 0],
      [0, 1, 0],
      [0, 0, -1],
      [0, 0, 1],
      [1, 0, 0],
    ],
    faces: [
      [0, 1, 2],
      [3, 4, 5],
    ],
  };
  expectSurfaceError(() => assertNoSelfIntersections(crossing), 'SURFACE_SELF_INTERSECTION');
  const adjacentOverlap: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [2, 0, 0],
      [0, 2, 0],
      [1, 0.5, 0],
      [2, 2, 0],
    ],
    faces: [
      [0, 1, 2],
      [0, 3, 4],
    ],
  };
  expectSurfaceError(() => assertNoSelfIntersections(adjacentOverlap), 'SURFACE_SELF_INTERSECTION');
});

test('multi-section loft preserves matching holes, outward volume and source edits', () => {
  const source = parse({
    kind: 'surface',
    operation: 'loft',
    segments: 3,
    profileSegments: 2,
    interpolation: 'linear',
    sections: [
      { profile: { outer: square(2), holes: [square(1)] }, position: [0, 0, 0] },
      { profile: { outer: square(2), holes: [square(1)] }, position: [0, 0, 2] },
      { profile: { outer: square(2), holes: [square(1)] }, position: [0, 0, 4] },
    ],
  });
  const mesh = surfaceToMesh(source);
  assert.equal(boundaryCount(mesh), 0);
  close(volume(mesh), 48);
  const curved = parse({
    ...source,
    interpolation: 'centripetal',
    sections:
      source.operation === 'loft'
        ? source.sections.map((section, index) => ({
            ...section,
            position: [index === 1 ? 0.3 : 0, 0, index * 2],
          }))
        : [],
  });
  assert.ok(surfaceToMesh(curved).vertices.some((point) => point[0] > 2.2));
});

test('loft section topology mismatch and reversed planes give targeted diagnostics', () => {
  const sections = [
    { profile: profile(), position: [0, 0, 0] },
    { profile: profile(), position: [0, 0, 2] },
  ];
  expectSurfaceError(
    () =>
      surfaceToMesh(
        parse({
          kind: 'surface',
          operation: 'loft',
          sections: [
            sections[0],
            {
              ...sections[1],
              profile: {
                outer: contour([
                  [0, 1],
                  [-1, -1],
                  [1, -1],
                ]),
                holes: [],
              },
            },
          ],
        }),
      ),
    'SURFACE_LOFT_INCOMPATIBLE',
  );
  expectSurfaceError(
    () =>
      surfaceToMesh(
        parse({
          kind: 'surface',
          operation: 'loft',
          sections: [sections[0], { ...sections[1], rotation: [180, 0, 0] }],
        }),
      ),
    'SURFACE_LOFT_INCOMPATIBLE',
  );
});

test('generic surface intersection validation supports polygon faces and miter shell on a cube', () => {
  const cube: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
    faces: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 4, 7, 3],
      [1, 2, 6, 5],
      [3, 7, 6, 2],
      [0, 1, 5, 4],
    ],
  };
  assertNoSelfIntersections(cube);
  const shell = shellMesh(cube, 0.2);
  close(volume(shell), 8 - 1.6 ** 3);
  assert.equal(boundaryCount(shell), 0);
});

test('surface budgets reject oversized tessellation before constructing large meshes', () => {
  expectSurfaceError(
    () => surfaceToMesh(sweep({ segments: 256, profileSegments: 64, thickness: 1 })),
    'SURFACE_LIMIT',
  );
  expectSurfaceError(
    () =>
      surfaceToMesh(
        parse({
          kind: 'surface',
          operation: 'revolve',
          segments: 2,
          profile: { closed: false, points: [{ position: [1, 0] }, { position: [1, 2] }] },
        }),
      ),
    'SURFACE_LIMIT',
  );
});

test('curved closed sections preserve Bezier handles through sweep and differently shaped loft sections', () => {
  const k = 0.5522847498;
  const circle: SurfaceCurve2 = {
    closed: true,
    points: [
      { position: [1, 0], inTangent: [0, -k], outTangent: [0, k] },
      { position: [0, 1], inTangent: [k, 0], outTangent: [-k, 0] },
      { position: [-1, 0], inTangent: [0, k], outTangent: [0, -k] },
      { position: [0, -1], inTangent: [-k, 0], outTangent: [k, 0] },
    ],
  };
  const tube = surfaceToMesh(sweep({ profile: { outer: circle, holes: [] }, profileSegments: 8 }));
  assert.equal(boundaryCount(tube), 0);
  close(volume(tube), Math.PI * 4, 0.1);
  const source = parse({
    kind: 'surface',
    operation: 'loft',
    profileSegments: 4,
    segments: 4,
    sections: [
      { position: [0, 0, 0], profile: { outer: circle, holes: [] } },
      {
        position: [0, 0, 3],
        profile: {
          outer: contour([
            [1, 0],
            [0, 1],
            [-1, 0],
            [0, -1],
          ]),
          holes: [],
        },
      },
    ],
  });
  assert.equal(boundaryCount(surfaceToMesh(source)), 0);
  assert.deepEqual(source.operation === 'loft' && source.sections[0].profile.outer, circle);
});

test('closed oriented multi-section loft welds its seam', () => {
  const source = parse({
    kind: 'surface',
    operation: 'loft',
    closed: true,
    segments: 6,
    profileSegments: 1,
    sections: [0, 90, 180, 270].map((angle) => ({
      profile: profile(0.1),
      position: [3 * Math.cos((angle * Math.PI) / 180), 0, 3 * Math.sin((angle * Math.PI) / 180)],
      rotation: [0, -angle, 0],
    })),
  });
  const mesh = surfaceToMesh(source);
  assert.equal(boundaryCount(mesh), 0);
  assert.equal(mesh.vertices.length, 24 * 4);
  assert.ok(volume(mesh) > 0.5);
});

test('thickness preserves both outer and hole boundaries on a capped extrusion', () => {
  const shell = surfaceToMesh(sweep({ profile: { outer: square(2), holes: [square(1)] }, thickness: 0.1 }));
  assert.equal(boundaryCount(shell), 0);
  close(volume(shell), 48 - (3.8 ** 2 - 2.2 ** 2) * 3.8, 1e-5);
});

test('interior Bezier cusps are diagnosed even between low-resolution samples', () => {
  expectSurfaceError(
    () =>
      surfaceToMesh(
        sweep({
          segments: 1,
          path: {
            closed: false,
            points: [
              { position: [0, 0, 0], outTangent: [0, 0, 4] },
              { position: [0, 0, 1], inTangent: [0, 0, -4] },
            ],
          },
        }),
      ),
    'SURFACE_CUSP',
  );
});

test('geometric self-crossing paths fail without mutating their source', () => {
  const source = sweep({
    profile: profile(0.1),
    segments: 6,
    path: {
      closed: false,
      points: [
        { position: [-2, 0, -2] },
        { position: [2, 0, 2] },
        { position: [-2, 0, 2] },
        { position: [2, 0, -2] },
      ],
    },
  });
  const original = structuredClone(source);
  expectSurfaceError(() => surfaceToMesh(source), 'SURFACE_SELF_INTERSECTION');
  assert.deepEqual(source, original);
});

test('generic validation rejects self-crossing polygon faces and invalid coordinates', () => {
  const polygon: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [-2, 0, 0],
      [2, 2, 0],
      [-2, 2, 0],
      [2, 0, 0],
      [3, -1, 0],
    ],
    faces: [[0, 1, 2, 3, 4]],
  };
  expectSurfaceError(() => assertNoSelfIntersections(polygon), 'SURFACE_PROFILE_INTERSECTION');
  const invalid: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, Infinity, 0],
    ],
    faces: [[0, 1, 2]],
  };
  expectSurfaceError(() => assertNoSelfIntersections(invalid), 'SURFACE_RANGE');
  const fan: MeshData = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
    ],
    faces: [
      [0, 1, 2],
      [0, 3, 4],
    ],
  };
  expectSurfaceError(() => assertSurfaceMeshValid(fan), 'SURFACE_TOPOLOGY');
});

test('higher-resolution sweep has the requested geometry count and bounded measured evaluation', (context) => {
  const source = sweep({ segments: 64, profileSegments: 16 });
  const start = performance.now();
  const mesh = surfaceToMesh(source);
  const elapsed = performance.now() - start;
  assert.equal(mesh.vertices.length, 65 * 64);
  assert.equal(boundaryCount(mesh), 0);
  close(volume(mesh), 16, 1e-5);
  context.diagnostic(
    JSON.stringify({
      vertices: mesh.vertices.length,
      triangles: mesh.faces.length,
      evaluationMs: elapsed,
      note: 'Descriptive local measurement; no timing assertion or isolated benchmark claim.',
    }),
  );
});
