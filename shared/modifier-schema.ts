import { z } from 'zod';

const identifier = z.string().min(1).max(200);
const coordinate = z.number().finite().min(-100000).max(100000);
const common = { id: identifier, enabled: z.boolean().default(true) };
export const meshModifierSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...common,
      type: z.literal('mirror'),
      axis: z.enum(['x', 'y', 'z']).default('x'),
      offset: coordinate.default(0),
      keepOriginal: z.boolean().default(true),
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
      'Add an editable non-destructive mirror, array or Loop subdivision to an object. Source geometry is retained, order matters, and existing mesh/curve/terrain edits update the source. Mirror offsets and array offsets use local meters. Mirror copies are not welded or fused; use Boolean modeling after baking when a single solid is required.',
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
