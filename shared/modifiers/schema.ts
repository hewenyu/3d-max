import { z } from 'zod';

const coordinate = z.number().finite().min(-100000).max(100000);
const axis = z.enum(['x', 'y', 'z']);
const vector = z.tuple([coordinate, coordinate, coordinate]);
const common = { id: z.string().min(1).max(200), enabled: z.boolean().default(true) };
export const advancedModifierSchemas = [
  z
    .object({
      ...common,
      type: z.literal('solidify'),
      thickness: z.number().finite().positive().max(10000).default(0.1),
      offset: z.number().finite().min(-1).max(1).default(0),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('bend'),
      axis: axis.default('y'),
      direction: axis.default('x'),
      angle: z.number().finite().min(-180).max(180).default(45),
      from: coordinate.default(0),
      to: coordinate.default(1),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('twist'),
      axis: axis.default('y'),
      angle: z.number().finite().min(-720).max(720).default(90),
      from: coordinate.default(0),
      to: coordinate.default(1),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('catmull-clark'),
      iterations: z.number().int().min(1).max(3).default(1),
      boundary: z.enum(['smooth', 'corners']).default('corners'),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('curve-array'),
      points: z.array(vector).min(2).max(256),
      closed: z.boolean().default(false),
      count: z.number().int().min(2).max(32).default(4),
      axis: axis.default('x'),
      orient: z.boolean().default(true),
    })
    .strict(),
] as const;

export const advancedModifierSchema = z.discriminatedUnion('type', advancedModifierSchemas);
export type AdvancedModifier = z.infer<typeof advancedModifierSchema>;
