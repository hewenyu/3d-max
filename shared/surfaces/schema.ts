import { z } from 'zod';

const coordinate = z.number().finite().min(-100000).max(100000);
const vector2 = z.tuple([coordinate, coordinate]);
const vector3 = z.tuple([coordinate, coordinate, coordinate]);
export const surfaceKnot2Schema = z
  .object({
    position: vector2,
    inTangent: vector2.optional(),
    outTangent: vector2.optional(),
  })
  .strict();
export const surfaceKnot3Schema = z
  .object({
    position: vector3,
    inTangent: vector3.optional(),
    outTangent: vector3.optional(),
  })
  .strict();
export const surfaceCurve2Schema = z
  .object({
    points: z.array(surfaceKnot2Schema).min(2).max(128),
    closed: z.boolean().default(false),
  })
  .strict();
export const surfaceCurve3Schema = z
  .object({
    points: z.array(surfaceKnot3Schema).min(2).max(128),
    closed: z.boolean().default(false),
  })
  .strict();
export const surfaceProfileSchema = z
  .object({
    outer: surfaceCurve2Schema,
    holes: z.array(surfaceCurve2Schema).max(16).default([]),
  })
  .strict();
const common = {
  kind: z.literal('surface'),
  segments: z.number().int().min(1).max(256).default(16),
  profileSegments: z.number().int().min(1).max(64).default(4),
  caps: z.boolean().default(true),
  thickness: z.number().finite().min(0).max(1000).default(0),
  smooth: z.boolean().default(true),
};
const sweep = z
  .object({
    ...common,
    operation: z.literal('sweep'),
    path: surfaceCurve3Schema,
    profile: surfaceProfileSchema,
  })
  .strict();
const revolve = z
  .object({
    ...common,
    operation: z.literal('revolve'),
    profile: surfaceCurve2Schema,
    angle: z.number().finite().positive().max(360).default(360),
    startAngle: z.number().finite().min(-360).max(360).default(0),
  })
  .strict();
const loft = z
  .object({
    ...common,
    operation: z.literal('loft'),
    sections: z
      .array(
        z
          .object({
            profile: surfaceProfileSchema,
            position: vector3,
            rotation: vector3.default([0, 0, 0]),
          })
          .strict(),
      )
      .min(2)
      .max(64),
    closed: z.boolean().default(false),
    interpolation: z.enum(['linear', 'centripetal']).default('centripetal'),
  })
  .strict();
export const surfaceDataSchema = z.discriminatedUnion('operation', [sweep, revolve, loft]);
export type SurfaceKnot2 = z.infer<typeof surfaceKnot2Schema>;
export type SurfaceKnot3 = z.infer<typeof surfaceKnot3Schema>;
export type SurfaceCurve2 = z.infer<typeof surfaceCurve2Schema>;
export type SurfaceCurve3 = z.infer<typeof surfaceCurve3Schema>;
export type SurfaceProfile = z.infer<typeof surfaceProfileSchema>;
export type SurfaceData = z.infer<typeof surfaceDataSchema>;
export type SurfaceSweep = Extract<SurfaceData, { operation: 'sweep' }>;
export type SurfaceRevolve = Extract<SurfaceData, { operation: 'revolve' }>;
export type SurfaceLoft = Extract<SurfaceData, { operation: 'loft' }>;

export const surfaceCommandDefinitions: { type: string; description: string; schema: z.AnyZodObject }[] = [
  {
    type: 'surface.set',
    description:
      'Replace an object with editable Bezier-source sweep, Y-axis revolution or multi-section loft. Tangents are relative vectors in local meters; missing span handles mean a straight segment. Sweep/loft profiles are closed outer contours plus holes. segments samples each path/loft span, or the revolution angle; profileSegments samples each profile span. thickness preserves the outer surface and creates an inward normal/miter shell, not an analytic CAD offset. Invalid contours, cusps, incompatible sections, self-intersections and complexity overflow fail atomically. mesh.convert explicitly bakes the result.',
    schema: z.object({ id: z.string().min(1).max(200), surface: surfaceDataSchema }).strict(),
  },
];

export class SurfaceError extends Error {
  readonly status = 400;
  constructor(
    message: string,
    public code = 'SURFACE_INVALID',
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SurfaceError';
  }
}

export const SURFACE_LIMITS = {
  vertices: 70000,
  triangles: 150000,
  profilePoints: 2048,
  intersectionPairs: 3000000,
  epsilon: 1e-7,
} as const;
