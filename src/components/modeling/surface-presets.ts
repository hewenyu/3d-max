import type {
  SurfaceCurve2,
  SurfaceCurve3,
  SurfaceData,
  SurfaceProfile,
} from '../../../shared/surfaces/schema';
import { surfaceDataSchema } from '../../../shared/surfaces/schema';

export function profilePreset(kind: 'rectangle' | 'circle' | 'arch', scale = 1): SurfaceCurve2 {
  if (kind === 'circle') {
    const k = 0.5522847498 * scale;
    return {
      closed: true,
      points: [
        { position: [scale, 0], inTangent: [0, -k], outTangent: [0, k] },
        { position: [0, scale], inTangent: [k, 0], outTangent: [-k, 0] },
        { position: [-scale, 0], inTangent: [0, k], outTangent: [0, -k] },
        { position: [0, -scale], inTangent: [-k, 0], outTangent: [k, 0] },
      ],
    };
  }
  const positions: [number, number][] =
    kind === 'arch'
      ? [
          [-1, -1],
          [1, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ]
      : [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ];
  return { closed: true, points: positions.map(([x, y]) => ({ position: [x * scale, y * scale] })) };
}

export function pathPreset(kind: 'line' | 'arc' | 'loop'): SurfaceCurve3 {
  if (kind === 'line') return { closed: false, points: [{ position: [0, 0, 0] }, { position: [0, 0, 4] }] };
  if (kind === 'arc')
    return {
      closed: false,
      points: [
        { position: [0, 0, 0], outTangent: [0, 2, 1] },
        { position: [0, 0, 4], inTangent: [0, 2, -1] },
      ],
    };
  const k = 0.5522847498 * 2;
  return {
    closed: true,
    points: [
      { position: [2, 0, 0], inTangent: [0, 0, -k], outTangent: [0, 0, k] },
      { position: [0, 0, 2], inTangent: [k, 0, 0], outTangent: [-k, 0, 0] },
      { position: [-2, 0, 0], inTangent: [0, 0, k], outTangent: [0, 0, -k] },
      { position: [0, 0, -2], inTangent: [-k, 0, 0], outTangent: [k, 0, 0] },
    ],
  };
}

export function defaultSurface(operation: SurfaceData['operation']): SurfaceData {
  const common = {
    kind: 'surface',
    operation,
    segments: 12,
    profileSegments: 4,
    caps: true,
    smooth: true,
    thickness: 0,
  };
  if (operation === 'sweep')
    return surfaceDataSchema.parse({
      ...common,
      path: pathPreset('arc'),
      profile: { outer: profilePreset('rectangle', 0.35), holes: [] },
    });
  if (operation === 'revolve')
    return surfaceDataSchema.parse({
      ...common,
      segments: 32,
      profile: {
        closed: false,
        points: [
          [0, 0],
          [1, 0],
          [1, 1.8],
          [0.65, 2.6],
          [0, 2.6],
        ].map((position) => ({ position })),
      },
    });
  const profile = (scale: number): SurfaceProfile => ({ outer: profilePreset('circle', scale), holes: [] });
  return surfaceDataSchema.parse({
    ...common,
    sections: [
      { profile: profile(1), position: [0, 0, 0] },
      { profile: profile(0.65), position: [0, 0, 2] },
      { profile: profile(1.2), position: [0, 0, 4] },
    ],
  });
}
