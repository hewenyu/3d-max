import { z } from 'zod';
import {
  componentKindSchema,
  componentSelectionSchema,
  componentSelectionRequestSchema,
  topologySchemas,
} from './topology-schema';

const transform = topologySchemas['topology.transform'].shape;
const modes = z.enum(['object', ...componentKindSchema.options]);
const tool = z.enum(['pick', 'box', 'lasso']);
const display = z.enum(['solid', 'wireframe', 'solid-wire']);
const sharedSettings = {
  tool: tool.optional(),
  xray: z.boolean().optional(),
  display: display.optional(),
  normals: z.boolean().optional(),
  boundaries: z.boolean().optional(),
  space: transform.space,
  pivotMode: transform.pivotMode,
  pivot: transform.pivot,
  proportional: transform.proportional.unwrap().nullable().optional(),
};
export const componentWorkspaceCommandSchema = z
  .object({
    type: z.literal('components'),
    objectId: z.string().min(1).max(200).optional(),
    mode: modes.optional(),
    ...sharedSettings,
    selection: componentSelectionRequestSchema.optional(),
    combine: z.enum(['replace', 'add', 'remove']).optional(),
  })
  .strict();
export const componentWorkspaceStateSchema = z
  .object({
    objectId: z.string().nullable(),
    mode: modes,
    selection: componentSelectionSchema.nullable(),
    tool,
    xray: z.boolean(),
    display,
    normals: z.boolean(),
    boundaries: z.boolean(),
    space: transform.space.unwrap(),
    pivotMode: transform.pivotMode.unwrap(),
    pivot: transform.pivot,
    proportional: transform.proportional,
    invalidatedIds: z.array(z.string()),
  })
  .strict();
export type ComponentWorkspaceCommand = z.infer<typeof componentWorkspaceCommandSchema>;
export type ComponentWorkspaceState = z.infer<typeof componentWorkspaceStateSchema>;
export const defaultComponentWorkspace: ComponentWorkspaceState = {
  objectId: null,
  mode: 'object',
  selection: null,
  tool: 'pick',
  xray: false,
  display: 'solid-wire',
  normals: false,
  boundaries: false,
  space: 'local',
  pivotMode: 'median',
  invalidatedIds: [],
};
