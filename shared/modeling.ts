import { z } from 'zod';
import { topologyCommandDefinitions } from './topology-schema';
import { meshModifierSchema, modifierCommandDefinitions } from './modifier-schema';
import type { SceneObject } from './types';
import { meshIdentitySchema, validateMeshIdentity } from './topology/identity';
import { surfaceDataSchema, surfaceCommandDefinitions } from './surfaces/schema';

export function supportsMeshConversion(object: Pick<SceneObject, 'type' | 'modeling'>): boolean {
  return Boolean(object.modeling) || ['box', 'sphere', 'cylinder', 'plane', 'wall'].includes(object.type);
}

const coordinate = z.number().finite().min(-100000).max(100000);
export const modelingVectorSchema = z.tuple([coordinate, coordinate, coordinate]);
const vertexIndex = z.number().int().min(0).max(100000);

export function polygonNormal(
  vertices: [number, number, number][],
  face: number[],
): [number, number, number] {
  const normal: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < face.length; index++) {
    const a = vertices[face[index]];
    const b = vertices[face[(index + 1) % face.length]];
    normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
    normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
    normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normal;
}

export const meshDataSchema = z
  .object({
    kind: z.literal('mesh'),
    vertices: z.array(modelingVectorSchema).min(3).max(100000),
    faces: z.array(z.array(vertexIndex).min(3).max(256)).min(1).max(100000),
    smooth: z.boolean().default(false),
    identity: meshIdentitySchema.optional(),
  })
  .strict()
  .superRefine((mesh, context) => {
    validateMeshIdentity(mesh, context);
    let triangleCount = 0;
    mesh.faces.forEach((face, index) => {
      triangleCount += face.length - 2;
      if (new Set(face).size !== face.length || face.some((vertex) => vertex >= mesh.vertices.length)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['faces', index],
          message: 'Faces require distinct valid vertex indices',
        });
      } else if (Math.hypot(...polygonNormal(mesh.vertices, face)) < 0.00000001) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['faces', index],
          message: 'Face vertices must enclose a nonzero area',
        });
      }
    });
    if (triangleCount > 150000)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['faces'],
        message: 'A mesh may contain at most 150000 triangles',
      });
  });

export const curveDataSchema = z
  .object({
    kind: z.literal('curve'),
    points: z.array(modelingVectorSchema).min(2).max(256),
    closed: z.boolean().default(false),
    segments: z.number().int().min(2).max(2048).default(64),
    profile: z.enum(['road', 'tube']).default('road'),
    width: z.number().positive().max(10000).default(4),
    radius: z.number().positive().max(1000).default(0.3),
    thickness: z.number().positive().max(1000).default(0.15),
    bank: z.number().min(-80).max(80).default(0),
    radialSegments: z.number().int().min(3).max(64).default(12),
  })
  .strict()
  .superRefine((curve, context) => {
    if (curve.closed && curve.points.length < 3)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['points'],
        message: 'Closed curves need at least three control points',
      });
    if (curve.closed && curve.points[0].every((value, axis) => value === curve.points.at(-1)![axis]))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['points'],
        message: 'Closed curves connect the endpoints automatically; do not repeat the first point',
      });
    const ringSize = curve.profile === 'road' ? 4 : curve.radialSegments;
    if ((curve.segments + 1) * ringSize > 70000)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments'],
        message: 'Reduce curve or radial segments to keep the editable mesh below 70000 vertices',
      });
    for (let index = 1; index < curve.points.length; index++) {
      if (curve.points[index].every((value, axis) => value === curve.points[index - 1][axis]))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['points', index],
          message: 'Adjacent curve control points must be distinct',
        });
    }
  });

export const terrainDataSchema = z
  .object({
    kind: z.literal('terrain'),
    sizeX: z.number().positive().max(100000),
    sizeZ: z.number().positive().max(100000),
    segmentsX: z.number().int().min(1).max(200),
    segmentsZ: z.number().int().min(1).max(200),
    heights: z.array(coordinate).min(4).max(40401),
    thickness: z.number().positive().max(10000).default(1),
  })
  .strict()
  .superRefine((terrain, context) => {
    if (terrain.heights.length !== (terrain.segmentsX + 1) * (terrain.segmentsZ + 1))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['heights'],
        message: 'Provide exactly (segmentsX + 1) * (segmentsZ + 1) row-major heights',
      });
  });

export const baseModelingSchema = z.union([
  meshDataSchema,
  curveDataSchema,
  terrainDataSchema,
  surfaceDataSchema,
]);
export const modifierStackSchema = z
  .object({
    kind: z.literal('stack'),
    base: baseModelingSchema,
    modifiers: z.array(meshModifierSchema).min(1).max(16),
  })
  .strict()
  .superRefine((stack, context) => {
    if (new Set(stack.modifiers.map((modifier) => modifier.id)).size !== stack.modifiers.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modifiers'],
        message: 'Modifier IDs must be unique within an object',
      });
  });
export const modelingSchema = z.union([
  meshDataSchema,
  curveDataSchema,
  terrainDataSchema,
  surfaceDataSchema,
  modifierStackSchema,
]);
export type MeshData = z.infer<typeof meshDataSchema>;
export type CurveData = z.infer<typeof curveDataSchema>;
export type TerrainData = z.infer<typeof terrainDataSchema>;
export type BaseModelingData = z.infer<typeof baseModelingSchema>;
export type ModifierStack = z.infer<typeof modifierStackSchema>;
export type ModelingData = z.infer<typeof modelingSchema>;

const identifier = z.string().min(1).max(200);
const target = z.object({ id: identifier }).strict();
const meshInput = z
  .object({
    kind: z.literal('mesh').optional(),
    identity: meshIdentitySchema.optional(),
    vertices: z.array(modelingVectorSchema).min(3).max(100000),
    faces: z.array(z.array(vertexIndex).min(3).max(256)).min(1).max(100000),
    smooth: z.boolean().optional(),
  })
  .strict();
export const modelingCommandDefinitions: { type: string; description: string; schema: z.AnyZodObject }[] = [
  ...topologyCommandDefinitions,
  ...modifierCommandDefinitions,
  ...surfaceCommandDefinitions,
  {
    type: 'mesh.convert',
    description:
      'Bake a supported primitive, editable curve or terrain to editable indexed polygon faces. Geometry uses object-local meters. Box, sphere, cylinder, plane and wall are supported; imported GLTF and rigs are not converted.',
    schema: target,
  },
  {
    type: 'mesh.set',
    description:
      'Replace an object with an explicit editable indexed mesh. vertices are local-meter XYZ tuples; faces are counter-clockwise vertex-index polygons viewed from outside.',
    schema: target.extend({ mesh: meshInput }).strict(),
  },
  {
    type: 'mesh.vertex.set',
    description:
      'Move an indexed mesh vertex in local meters. Shared faces remain connected. The target must first be converted to an editable mesh.',
    schema: target.extend({ index: vertexIndex, position: modelingVectorSchema }).strict(),
  },
  {
    type: 'mesh.vertex.add',
    description:
      'Append one local-meter mesh vertex. Use the returned vertex index with mesh.face.add to create a polygon.',
    schema: target.extend({ position: modelingVectorSchema }).strict(),
  },
  {
    type: 'mesh.vertex.delete',
    description:
      'Delete an unreferenced mesh vertex and remap higher vertex indices. Remove its incident faces first.',
    schema: target.extend({ index: vertexIndex }).strict(),
  },
  {
    type: 'mesh.face.extrude',
    description:
      'Extrude a mesh polygon along its outward normal by distance meters, retaining shared boundary side faces. Positive distance extends outwards; negative distance insets.',
    schema: target
      .extend({
        faceIndex: z.number().int().min(0),
        distance: z
          .number()
          .finite()
          .min(-10000)
          .max(10000)
          .refine((value) => Math.abs(value) > 0.000001, 'Extrusion distance must be nonzero'),
      })
      .strict(),
  },
  {
    type: 'mesh.face.delete',
    description:
      'Delete one polygon while preserving the remaining indexed mesh. Open meshes remain editable but Boolean operations require a closed solid.',
    schema: target.extend({ faceIndex: z.number().int().min(0) }).strict(),
  },
  {
    type: 'mesh.face.add',
    description:
      'Create an oriented polygon from existing distinct vertex indices. Vertex winding determines the outward normal.',
    schema: target.extend({ indices: z.array(vertexIndex).min(3).max(256) }).strict(),
  },
  {
    type: 'mesh.boolean',
    description:
      'Compute an editable union, difference or intersection with the proven three-bvh-csg engine. Operands use their base transforms including parent transforms, must be closed solids and contain at most 30000 triangles each. The operand is kept by default; keepOperand=false hides it after a successful operation.',
    schema: target
      .extend({
        operandId: identifier,
        operation: z.enum(['union', 'subtract', 'intersect']),
        keepOperand: z.boolean().default(true),
      })
      .strict(),
  },
  {
    type: 'curve.set',
    description:
      'Create or replace an editable Catmull-Rom road or capped tube. points are local-meter XYZ control points. Roads have editable width/thickness/bank; tubes have radius/radialSegments. Shape parameters remain editable until mesh.convert.',
    schema: target
      .extend({
        curve: z
          .object({
            points: z.array(modelingVectorSchema).min(2).max(256),
            closed: z.boolean().optional(),
            segments: z.number().int().min(2).max(2048).optional(),
            profile: z.enum(['road', 'tube']).optional(),
            width: z.number().positive().max(10000).optional(),
            radius: z.number().positive().max(1000).optional(),
            thickness: z.number().positive().max(1000).optional(),
            bank: z.number().min(-80).max(80).optional(),
            radialSegments: z.number().int().min(3).max(64).optional(),
          })
          .strict(),
      })
      .strict(),
  },
  {
    type: 'terrain.set',
    description:
      'Create or update an editable row-major terrain height grid, centered on local X/Z. heights are explicit meter elevations. Changing grid dimensions without heights bilinearly resamples existing terrain; a new terrain defaults to zero elevation.',
    schema: target
      .extend({
        terrain: z
          .object({
            sizeX: z.number().positive().max(100000),
            sizeZ: z.number().positive().max(100000),
            segmentsX: z.number().int().min(1).max(200),
            segmentsZ: z.number().int().min(1).max(200),
            heights: z.array(coordinate).min(4).max(40401).optional(),
            thickness: z.number().positive().max(10000).optional(),
          })
          .strict(),
      })
      .strict(),
  },
  {
    type: 'terrain.sculpt',
    description:
      'Apply a deterministic local-XZ radial brush to terrain heights. raise adds amount meters, flatten targets amount meters, smooth blends neighboring heights with amount in [0,1]. All changes are stored as editable heights.',
    schema: target
      .extend({
        center: z.tuple([coordinate, coordinate]),
        radius: z.number().positive().max(100000),
        amount: coordinate,
        mode: z.enum(['raise', 'flatten', 'smooth']),
      })
      .strict(),
  },
  {
    type: 'terrain.point.set',
    description: 'Set one terrain grid vertex elevation explicitly, using zero-based row and column.',
    schema: target
      .extend({
        row: z.number().int().min(0).max(200),
        column: z.number().int().min(0).max(200),
        height: coordinate,
      })
      .strict(),
  },
];

export class ModelingError extends Error {
  constructor(
    message: string,
    public code = 'MODELING_ERROR',
    public status = 400,
  ) {
    super(message);
  }
}
