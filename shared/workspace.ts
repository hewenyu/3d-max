import { z } from 'zod';
import { componentWorkspaceCommandSchema, componentWorkspaceStateSchema } from './topology-workspace';

const id = z.string().min(1).max(200);
const finite = z.number().finite();
const vector = z.tuple([finite, finite, finite]);
export const workspaceDialogSchema = z.enum([
  'export',
  'mcp',
  'new',
  'projects',
  'cuts',
  'continuity',
  'compare',
  'script',
  'review',
  'model-assets',
]);
export const workspaceCommandSchema = z.discriminatedUnion('type', [
  componentWorkspaceCommandSchema,
  z
    .object({
      type: z.literal('selection'),
      ids: z.array(id).max(10000),
      mode: z.enum(['replace', 'add', 'remove']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('view'), mode: z.enum(['edit', 'camera', 'top']) }).strict(),
  z
    .object({
      type: z.literal('observation'),
      view: z.enum(['edit', 'top']).optional(),
      position: vector.optional(),
      target: vector.optional(),
      fov: finite.min(5).max(150).optional(),
      zoom: finite.min(1e-6).max(1e6).optional(),
      pan: vector.optional(),
      orbit: z
        .object({ azimuth: finite, polar: finite.min(0.1).max(89.1) })
        .strict()
        .optional(),
      dolly: finite.min(1e-6).max(1e6).optional(),
    })
    .strict(),
  z.object({ type: z.literal('focus'), ids: z.array(id).max(10000).optional() }).strict(),
  z
    .object({
      type: z.literal('transport'),
      time: finite.min(0).optional(),
      stepFrames: z.number().int().optional(),
      action: z.enum(['play', 'pause', 'toggle', 'start', 'end']).optional(),
      loop: z.boolean().optional(),
      muted: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('clip'), clipId: id }).strict(),
  z
    .object({
      type: z.literal('settings'),
      tool: z.enum(['translate', 'rotate', 'scale']).optional(),
      snap: z.boolean().optional(),
      helpers: z.boolean().optional(),
      safeFrame: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('panels'),
      leftVisible: z.boolean().optional(),
      rightVisible: z.boolean().optional(),
      mobilePanel: z.enum(['left', 'right']).nullable().optional(),
      inspectorTab: z.enum(['shot', 'object', 'director', 'settings']).optional(),
      inspectorMode: z.enum(['base', 'keyframe']).optional(),
      sceneTab: z.enum(['scene', 'assets', 'production', 'templates']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('dialog'), name: workspaceDialogSchema.nullable() }).strict(),
  z
    .object({
      type: z.literal('comparison'),
      leftSequenceId: id.optional(),
      rightSequenceId: id.optional(),
      time: finite.min(0).optional(),
      stepFrames: z.number().int().optional(),
      action: z.enum(['play', 'pause', 'start']).optional(),
      swap: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('cut_review'),
      time: finite.min(0).optional(),
      checked: z.array(z.enum(['screen-position', 'eyeline', 'action', 'props'])).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('video'),
      jobId: id.optional(),
      action: z.enum(['open', 'play', 'pause', 'close', 'retry']).optional(),
      time: finite.min(0).optional(),
      muted: z.boolean().optional(),
      volume: finite.min(0).max(1).optional(),
      playbackRate: finite.min(0.25).max(4).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('fullscreen'),
      enabled: z.boolean(),
      target: z.enum(['viewport', 'video']).optional(),
    })
    .strict(),
]);
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
export type WorkspaceDialog = z.infer<typeof workspaceDialogSchema> | null;

export const workspaceObservationSchema = z.object({
  edit: z.object({ position: vector, target: vector, fov: finite }),
  top: z.object({ position: vector, target: vector, zoom: finite }),
});
export const workspaceComparisonSchema = z.object({
  leftSequenceId: id,
  rightSequenceId: id,
  time: finite,
  playing: z.boolean(),
  ready: z.object({ left: z.boolean(), right: z.boolean() }),
});
export const workspaceMediaSchema = z.object({
  jobId: id,
  time: finite,
  duration: finite,
  paused: z.boolean(),
  muted: z.boolean(),
  volume: finite,
  playbackRate: finite,
  readyState: z.number().int(),
  loading: z.boolean(),
  ended: z.boolean(),
  error: z.string().nullable(),
});
export const workspaceStateSchema = z.object({
  revision: z.number().int().min(0),
  projectId: id,
  projectRevision: z.number().int().min(0),
  context: z.object({ sceneId: id.nullable(), performanceId: id.nullable() }),
  selection: z.array(id),
  components: componentWorkspaceStateSchema.optional(),
  view: z.enum(['edit', 'camera', 'top']),
  observation: workspaceObservationSchema,
  transport: z.object({
    time: finite,
    sourceTime: finite,
    cameraTime: finite,
    duration: finite,
    playing: z.boolean(),
    loop: z.boolean(),
    muted: z.boolean(),
  }),
  settings: z.object({
    tool: z.enum(['translate', 'rotate', 'scale']),
    snap: z.boolean(),
    helpers: z.boolean(),
    safeFrame: z.boolean(),
  }),
  panels: z.object({
    leftVisible: z.boolean(),
    rightVisible: z.boolean(),
    mobilePanel: z.enum(['left', 'right']).nullable(),
    inspectorTab: z.enum(['shot', 'object', 'director', 'settings']),
    inspectorMode: z.enum(['base', 'keyframe']).nullable(),
    sceneTab: z.enum(['scene', 'assets', 'production', 'templates']),
  }),
  dialog: workspaceDialogSchema.nullable(),
  comparison: workspaceComparisonSchema.nullable(),
  cutReview: z.object({ time: finite, checked: z.array(z.string()) }).nullable(),
  media: workspaceMediaSchema.nullable(),
  fullscreen: z.boolean(),
  fullscreenTarget: z.enum(['viewport', 'video', 'other']).nullable().optional(),
  viewport: z.object({
    width: finite,
    height: finite,
    loading: z.boolean(),
    sceneId: id.nullable(),
    performanceId: id.nullable(),
    workspace: z.boolean(),
  }),
});
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
export type WorkspaceObservation = z.infer<typeof workspaceObservationSchema>;
export type WorkspaceComparison = z.infer<typeof workspaceComparisonSchema>;
export type WorkspaceMedia = z.infer<typeof workspaceMediaSchema>;

export function workspaceStateFingerprint(input: Omit<WorkspaceState, 'revision'> | WorkspaceState) {
  const payload = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'revision'));
  return JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === 'number') return Math.round(value * 1e9) / 1e9;
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
    return value;
  });
}

export const workspaceRequestSchema = z
  .object({
    id,
    operation: z.enum(['get', 'apply', 'capture', 'inspect']),
    projectId: id,
    expectedRevision: z.number().int().min(0),
    expectedWorkspaceRevision: z.number().int().min(0).optional(),
    command: workspaceCommandSchema.optional(),
    options: z
      .object({ overlays: z.boolean().optional(), objectIds: z.array(id).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type WorkspaceRequest = z.infer<typeof workspaceRequestSchema>;
export interface WorkspaceError {
  code: string;
  message: string;
  details?: unknown;
}
export class WorkspaceFailure extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
