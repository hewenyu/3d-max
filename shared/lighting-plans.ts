import { z } from 'zod';
import { dequal } from 'dequal';
import { DomainError } from './domain-error';
import type { Project, Shot } from './types';
import type { SceneDefinition } from './production';

export const lightingSchema = z
  .object({
    intensity: z.number().finite().min(0).max(10),
    ambient: z.number().finite().min(0).max(5),
    azimuth: z.number().finite(),
    elevation: z.number().finite().min(-90).max(90),
  })
  .strict();
export type Lighting = z.infer<typeof lightingSchema>;
export const lightingPlanSchema = z
  .object({
    id: z.string().min(1).max(160),
    name: z.string().trim().min(1).max(200),
    locked: z.boolean(),
    lighting: lightingSchema,
  })
  .strict();
export type LightingPlan = z.infer<typeof lightingPlanSchema>;

export function lightingCopyName(name: string) {
  const suffix = ' 副本';
  let prefix = '';
  for (const character of name) {
    if (prefix.length + character.length > 200 - suffix.length) break;
    prefix += character;
  }
  return prefix + suffix;
}

type LightingShot = Pick<Shot, 'id' | 'sceneId' | 'lightingPlanId' | 'locked'>;
interface LightingContext {
  settings: Pick<Project['settings'], 'lighting' | 'lightingPlanId'>;
  lightingPlans?: LightingPlan[];
  shots: LightingShot[];
  sequences: { locked: boolean; clips: { shotId: string }[] }[];
  production?: {
    activeSceneId: string;
    scenes: Pick<SceneDefinition, 'id' | 'locked' | 'lighting' | 'lightingPlanId'>[];
  };
}

export function captureLightingState(project: Project): LightingContext {
  return structuredClone({
    settings: { lighting: project.settings.lighting, lightingPlanId: project.settings.lightingPlanId },
    lightingPlans: project.lightingPlans,
    shots: project.shots.map(({ id, sceneId, lightingPlanId, locked }) => ({
      id,
      sceneId,
      lightingPlanId,
      locked,
    })),
    sequences: project.sequences
      .filter((sequence) => sequence.locked)
      .map((sequence) => ({
        locked: true,
        clips: sequence.clips.map(({ shotId }) => ({ shotId })),
      })),
    production: project.production
      ? {
          activeSceneId: project.production.activeSceneId,
          scenes: project.production.scenes.map(({ id, locked, lighting, lightingPlanId }) => ({
            id,
            locked,
            lighting,
            lightingPlanId,
          })),
        }
      : undefined,
  });
}

export function sceneLighting(project: LightingContext, sceneId?: string) {
  const scene = project.production?.scenes.find(
    (item) => item.id === (sceneId ?? project.production?.activeSceneId),
  );
  if (sceneId && !scene) throw new DomainError(`Scene not found: ${sceneId}`, 'NOT_FOUND', 404);
  const active = !scene || scene.id === project.production?.activeSceneId;
  return {
    sceneId: scene?.id ?? null,
    planId: active ? project.settings.lightingPlanId : scene.lightingPlanId,
    lighting: active ? project.settings.lighting : scene.lighting,
  };
}

export function resolveLighting(
  project: LightingContext,
  shot: Pick<Shot, 'sceneId' | 'lightingPlanId'> | null = null,
): Lighting {
  const scene = sceneLighting(project, shot?.sceneId);
  const planId = shot?.lightingPlanId ?? scene.planId;
  if (!planId) return scene.lighting;
  const plan = project.lightingPlans?.find((item) => item.id === planId);
  if (!plan) throw new DomainError(`Lighting plan not found: ${planId}`, 'NOT_FOUND', 404);
  return plan.lighting;
}

export function lightingPlanUsage(project: Project, planId: string) {
  const scenes = project.production?.scenes ?? [];
  const sceneIds = scenes
    .filter((scene) => sceneLighting(project, scene.id).planId === planId)
    .map((s) => s.id);
  const workspace = !project.production && project.settings.lightingPlanId === planId;
  const shotIds = project.shots
    .filter((shot) => (shot.lightingPlanId ?? sceneLighting(project, shot.sceneId).planId) === planId)
    .map((shot) => shot.id);
  const directShotIds = project.shots.filter((shot) => shot.lightingPlanId === planId).map((shot) => shot.id);
  return { sceneIds, workspace, shotIds, directShotIds };
}

export function validateLightingPlans(project: Project) {
  const plans = project.lightingPlans ?? [];
  const ids = new Set(plans.map((plan) => plan.id));
  if (ids.size !== plans.length) throw new DomainError('Duplicate lighting plan ID');
  const references = [
    project.settings.lightingPlanId,
    ...(project.production?.scenes.map((scene) => scene.lightingPlanId) ?? []),
    ...project.shots.map((shot) => shot.lightingPlanId),
  ];
  for (const reference of references)
    if (reference && !ids.has(reference)) throw new DomainError(`Missing lighting plan: ${reference}`);
}

/** Protect indirect changes from any command, including generic settings and shot patches. */
export function validateLightingLocks(before: LightingContext, after: LightingContext) {
  for (const scene of before.production?.scenes ?? []) {
    if (!scene.locked || !after.production?.scenes.some((item) => item.id === scene.id)) continue;
    const previous = sceneLighting(before, scene.id);
    const next = sceneLighting(after, scene.id);
    const values = (project: LightingContext, state: typeof previous) =>
      project.lightingPlans?.find((plan) => plan.id === state.planId)?.lighting ?? state.lighting;
    if (previous.planId !== next.planId || !dequal(values(before, previous), values(after, next)))
      throw new DomainError(`Lighting affects locked scene: ${scene.id}`, 'LOCKED', 409);
  }
  const lockedShotIds = new Set([
    ...before.shots.filter((shot) => shot.locked).map((shot) => shot.id),
    ...before.sequences.filter((sequence) => sequence.locked).flatMap((s) => s.clips.map((c) => c.shotId)),
  ]);
  for (const shot of before.shots) {
    const next = after.shots.find((item) => item.id === shot.id);
    if (!lockedShotIds.has(shot.id) || !next) continue;
    if (
      shot.lightingPlanId !== next.lightingPlanId ||
      !dequal(resolveLighting(before, shot), resolveLighting(after, next))
    )
      throw new DomainError(`Lighting affects locked shot or sequence: ${shot.id}`, 'LOCKED', 409);
  }
}
