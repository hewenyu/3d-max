import { z } from 'zod';
import { actorConstraintSchema } from './actor-animation';
import { DomainError } from './domain-error';
import { productionPerformance, productionScene, resolveShotProject } from './production';
import { sampleTimeline, sequenceDuration } from './timeline';
import type { Project, Shot } from './types';
import type { WorkspaceObservation } from './workspace';

const id = z.string().min(1).max(200);
const finite = z.number().finite();
const time = finite.min(0).max(36000);
const vector = z.tuple([finite, finite, finite]);
export const viewportContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sequence'), sequenceId: id.optional(), time: time.default(0) }).strict(),
  z.object({ kind: z.literal('shot'), shotId: id, time: time.default(0) }).strict(),
  z
    .object({
      kind: z.literal('source'),
      sourceTime: time.default(0),
      sceneId: id.optional(),
      performanceId: id.optional(),
      shotId: id.optional(),
    })
    .strict(),
]);
export const viewportObservationSchema = z
  .object({
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
  .strict();
const snapshotShape = {
  projectId: id.optional(),
  expectedRevision: z.number().int().min(0).optional(),
  context: viewportContextSchema.default({ kind: 'sequence', time: 0 }),
  objectIds: z.array(id).max(10000).optional(),
};
export const constraintInspectSchema = z.object(snapshotShape).strict();
export const viewportRequestSchema = z
  .object({
    ...snapshotShape,
    view: z.enum(['edit', 'camera', 'top']).default('edit'),
    width: z.number().int().min(64).max(1920).default(1280),
    height: z.number().int().min(64).max(1920).default(720),
    observation: viewportObservationSchema.optional(),
    helpers: z.boolean().default(false),
    safeFrame: z.boolean().default(false),
    overlays: z.boolean().default(false),
  })
  .strict();
export type ViewportRequest = z.infer<typeof viewportRequestSchema>;
export type ConstraintInspectRequest = z.infer<typeof constraintInspectSchema>;
export type ViewportContext = z.infer<typeof viewportContextSchema>;

export interface ViewportSampleContext {
  kind: ViewportContext['kind'];
  requestedTime: number;
  sequenceId: string | null;
  sequenceTime: number | null;
  shotId: string | null;
  sourceTime: number;
  cameraTime: number;
  sceneId: string | null;
  performanceId: string | null;
}
export interface ViewportFrameOptions {
  time: number;
  sequenceId?: string;
  shotId?: string;
  sourceTime?: number;
  view: ViewportRequest['view'];
  observation?: ViewportRequest['observation'];
  helpers: boolean;
  safeFrame: boolean;
  overlays: boolean;
  objectIds?: string[];
  capture: boolean;
}
export const viewportInspectionSchema = z
  .object({
    objects: z
      .array(
        z
          .object({
            id,
            name: z.string().max(200),
            visible: z.boolean(),
            worldPosition: vector,
            worldQuaternion: z.tuple([finite, finite, finite, finite]),
            worldScale: vector,
            bounds: z.object({ min: vector, max: vector }).strict().nullable(),
          })
          .strict(),
      )
      .max(10000),
    constraints: z
      .array(
        z
          .object({
            objectId: id,
            results: z
              .array(
                z
                  .object({
                    id,
                    effector: actorConstraintSchema.shape.effector,
                    target: vector.nullable(),
                    position: vector,
                    error: finite.min(0).nullable(),
                    reachable: z.boolean(),
                    reached: z.boolean(),
                    weight: finite.min(0).max(1),
                    status: z.enum(['inactive', 'missing-target', 'unreachable', 'solved', 'partial']),
                  })
                  .strict(),
              )
              .max(256),
          })
          .strict(),
      )
      .max(10000),
    frame: z.object({ x: finite, y: finite, width: finite.min(0), height: finite.min(0) }).strict(),
    context: z
      .object({
        sceneId: id.nullable(),
        performanceId: id.nullable(),
        sceneName: z.string().max(200).nullable(),
        workspace: z.boolean(),
        loading: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ViewportInspection = z.infer<typeof viewportInspectionSchema>;
export interface ViewportFrameResult {
  dataUrl?: string;
  observation: WorkspaceObservation;
  inspection: ViewportInspection;
}

function findShot(project: Project, shotId: string) {
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot) throw new DomainError('Shot not found', 'NOT_FOUND', 404);
  return shot;
}

/** Resolve all clocks and select an isolated projection before the renderer loads any resources. */
export function prepareViewport(project: Project, context: ViewportContext) {
  let shot: Shot | null = null;
  let sourceTime = 0;
  let cameraTime = 0;
  let sequenceId: string | null = null;
  let sequenceTime: number | null = null;
  let requestedTime: number;
  let frame: Pick<ViewportFrameOptions, 'time' | 'sequenceId' | 'shotId' | 'sourceTime'>;
  if (context.kind === 'sequence') {
    sequenceId = context.sequenceId ?? project.activeSequenceId;
    if (!project.sequences.some((item) => item.id === sequenceId))
      throw new DomainError('Sequence not found', 'NOT_FOUND', 404);
    if (context.time > sequenceDuration(project, sequenceId))
      throw new DomainError('Time is outside the selected sequence', 'INVALID_TIME');
    const sample = sampleTimeline(project, context.time, sequenceId);
    shot = sample.shot;
    sourceTime = sample.sourceTime;
    cameraTime = sample.cameraTime;
    requestedTime = sequenceTime = context.time;
    frame = { time: context.time, sequenceId };
  } else if (context.kind === 'shot') {
    shot = findShot(project, context.shotId);
    if (context.time > shot.sourceOut - shot.sourceIn)
      throw new DomainError('Time is outside the selected shot', 'INVALID_TIME');
    requestedTime = context.time;
    sourceTime = cameraTime = shot.sourceIn + context.time;
    frame = { time: context.time, shotId: shot.id, sourceTime };
  } else {
    if (context.shotId) shot = findShot(project, context.shotId);
    requestedTime = sourceTime = cameraTime = context.sourceTime;
    frame = { time: 0, sourceTime, ...(shot ? { shotId: shot.id } : {}) };
  }
  const sceneId = shot?.sceneId ?? project.production?.activeSceneId ?? null;
  const performanceId = shot?.sceneId
    ? (productionPerformance(project, shot.sceneId, shot.performanceId)?.id ?? null)
    : (project.production?.activePerformanceId ?? null);
  const requestedScene = context.kind === 'source' ? context.sceneId : undefined;
  const requestedTake = context.kind === 'source' ? context.performanceId : undefined;
  if (
    shot &&
    ((requestedScene && requestedScene !== sceneId) || (requestedTake && requestedTake !== performanceId))
  )
    throw new DomainError('Scene or performance conflicts with the selected shot', 'INVALID_CONTEXT');
  const selectedScene = requestedScene ?? sceneId;
  const selectedTake =
    requestedTake ??
    (requestedScene && requestedScene !== sceneId ? undefined : (performanceId ?? undefined));
  let snapshot = structuredClone(project);
  let selectedPerformance: string | null = null;
  if (selectedScene) {
    const scene = productionScene(project, selectedScene);
    const performance = productionPerformance(project, selectedScene, selectedTake);
    if (!scene || !performance) throw new DomainError('Scene or performance not found', 'NOT_FOUND', 404);
    selectedPerformance = performance.id;
    snapshot = resolveShotProject(snapshot, { sceneId: scene.id, performanceId: performance.id });
    snapshot.production!.activeSceneId = scene.id;
    snapshot.production!.activePerformanceId = performance.id;
  } else if (requestedTake) {
    throw new DomainError('Performance requires a production scene', 'INVALID_CONTEXT');
  }
  return {
    project: snapshot,
    frame,
    context: {
      kind: context.kind,
      requestedTime,
      sequenceId,
      sequenceTime,
      shotId: shot?.id ?? null,
      sourceTime,
      cameraTime,
      sceneId: selectedScene,
      performanceId: selectedPerformance,
    } satisfies ViewportSampleContext,
  };
}
