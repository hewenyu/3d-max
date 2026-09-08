import { z } from 'zod';
import { advancedModifierSchemas } from './modifiers/schema';

const identifier = z.string().min(1).max(200);
const coordinate = z.number().finite().min(-100000).max(100000);
const common = { id: identifier, enabled: z.boolean().default(true) };
export const meshModifierSchema = z.discriminatedUnion('type', [
  ...advancedModifierSchemas,
  z
    .object({
      ...common,
      type: z.literal('boolean'),
      operandId: identifier,
      operation: z.enum(['union', 'subtract', 'intersect']).default('subtract'),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('bevel'),
      width: z.number().finite().gt(0.000001).max(100000).default(0.05),
      segments: z.number().int().min(1).max(16).default(3),
      shape: z.number().finite().min(0).max(1).default(1),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('mirror'),
      axis: z.enum(['x', 'y', 'z']).default('x'),
      offset: coordinate.default(0),
      keepOriginal: z.boolean().default(true),
      weldThreshold: z.number().finite().min(0).max(1).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('array'),
      count: z.number().int().min(2).max(32).default(2),
      offset: z.tuple([coordinate, coordinate, coordinate]),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('subdivision'),
      iterations: z.number().int().min(1).max(3).default(1),
      preserveEdges: z.boolean().default(false),
      flatOnly: z.boolean().default(false),
    })
    .strict(),
]);
export type MeshModifier = z.infer<typeof meshModifierSchema>;
const target = z.object({ id: identifier }).strict();
export const modifierCommandDefinitions: { type: string; description: string; schema: z.AnyZodObject }[] = [
  {
    type: 'modifier.add',
    description:
      'Add an editable non-destructive modeling modifier. Supports mirror (optional seam welding), linear/curve arrays, Loop or Catmull-Clark subdivision, solidify, bend, twist, referenced Boolean and convex-shell bevel. Boolean retains operandId and uses evaluated operand geometry in base object/parent transforms, including hidden or locked operands; each operand is limited to 30000 triangles. Disabled Boolean references still require valid acyclic dependencies. Bevel acts on every non-coplanar edge of a convex closed outward-oriented shell; width is local meters, segments 1..16, shape 0 flat..1 circular, at most 256 profile planes. Source geometry is retained and order matters. Distances use local meters and angles degrees. Invalid inputs fail atomically.',
    schema: target
      .extend({ modifier: meshModifierSchema, index: z.number().int().min(0).optional() })
      .strict(),
  },
  {
    type: 'modifier.set',
    description:
      'Replace settings for an existing modifier by its stable ID; enabled=false bypasses it without losing settings. The source remains editable and the entire stack is evaluated in order.',
    schema: target.extend({ modifier: meshModifierSchema }).strict(),
  },
  {
    type: 'modifier.remove',
    description:
      'Remove a modifier and recompute geometry from the retained source. Removing the last modifier restores source geometry.',
    schema: target.extend({ modifierId: identifier }).strict(),
  },
  {
    type: 'modifier.reorder',
    description:
      'Move an existing modifier to a zero-based final stack index, then recompute in the new order.',
    schema: target.extend({ modifierId: identifier, index: z.number().int().min(0).max(15) }).strict(),
  },
  {
    type: 'modifier.bake',
    description:
      'Apply all enabled modifiers and replace the stack with its evaluated editable mesh. This is one undoable edit; the old source and settings remain recoverable through history.',
    schema: target,
  },
];
