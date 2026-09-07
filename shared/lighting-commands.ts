import { z } from 'zod';
import { DomainError } from './domain-error';
import {
  lightingPlanSchema,
  lightingCopyName,
  lightingPlanUsage,
  lightingSchema,
  resolveLighting,
  type LightingPlan,
} from './lighting-plans';
import type { Command, Project } from './types';

const id = z.string().min(1).max(160);
const name = z.string().trim().min(1).max(200);
export const lightingCommandDefinitions = [
  {
    type: 'lighting.plan.create',
    description:
      'Create a named reusable white-model lighting plan with key intensity (0..10), ambient (0..5), azimuth and elevation in degrees. Missing values copy current scene lighting. Plans are project assets, not a material-node system. Returns affected scene/shot IDs.',
    schema: z.object({ id: id.optional(), name, lighting: lightingSchema.optional() }).strict(),
  },
  {
    type: 'lighting.plan.update',
    description:
      'Rename, lock/unlock or edit a lighting plan. Shared edits affect every scene default and shot using it. Locked plans require a separate unlock; indirect changes to locked scenes, shots or sequences are rejected atomically. Returns affected IDs.',
    schema: z.object({ id, patch: lightingPlanSchema.omit({ id: true }).partial().strict() }).strict(),
  },
  {
    type: 'lighting.plan.duplicate',
    description:
      'Copy a lighting plan into independently editable values with a new ID. Existing scene and shot bindings are unchanged.',
    schema: z.object({ id, newId: id.optional(), name: name.optional() }).strict(),
  },
  {
    type: 'lighting.plan.delete',
    description:
      'Delete an unlocked lighting plan only after all scene defaults and direct shot bindings have been removed. Referenced plans return IN_USE with IDs.',
    schema: z.object({ id }).strict(),
  },
  {
    type: 'lighting.scene.bind',
    description:
      "Select a scene default lighting plan; null restores that scene's base lighting. Omit sceneId for the active scene or legacy single scene. Shot overrides are preserved; returns affected shot IDs.",
    schema: z.object({ sceneId: id.optional(), planId: id.nullable() }).strict(),
  },
  {
    type: 'lighting.shot.bind',
    description:
      'Bind a shot lighting override independently of its camera and performance. Null restores its bound scene default. Preview, transitions and video exports use the same resolved lighting.',
    schema: z.object({ shotId: id, planId: id.nullable() }).strict(),
  },
];

function plan(project: Project, planId: unknown): LightingPlan {
  const value = project.lightingPlans?.find((item) => item.id === planId);
  if (!value) throw new DomainError(`Lighting plan not found: ${String(planId)}`, 'NOT_FOUND', 404);
  return value;
}
function add(project: Project, value: LightingPlan) {
  if (project.lightingPlans?.some((item) => item.id === value.id))
    throw new DomainError(`Lighting plan ID already exists: ${value.id}`, 'CONFLICT', 409);
  project.lightingPlans = [...(project.lightingPlans ?? []), value];
  return { plan: value, usage: lightingPlanUsage(project, value.id) };
}
export function applyLightingCommand(project: Project, command: Command) {
  const p = command.payload;
  switch (command.type) {
    case 'lighting.plan.create':
      return add(project, {
        id: String(p.id ?? `lighting-${crypto.randomUUID()}`),
        name: String(p.name),
        lighting: structuredClone((p.lighting as LightingPlan['lighting']) ?? resolveLighting(project)),
        locked: false,
      });
    case 'lighting.plan.duplicate': {
      const original = plan(project, p.id);
      return add(project, {
        ...structuredClone(original),
        id: String(p.newId ?? `lighting-${crypto.randomUUID()}`),
        name: String(p.name ?? lightingCopyName(original.name)),
        locked: false,
      });
    }
    case 'lighting.plan.update': {
      const value = plan(project, p.id);
      const patch = p.patch as Partial<LightingPlan>;
      if (value.locked && !(Object.keys(patch).length === 1 && patch.locked === false))
        throw new DomainError(`Lighting plan is locked: ${value.id}`, 'LOCKED', 409);
      Object.assign(value, structuredClone(patch));
      return { plan: value, usage: lightingPlanUsage(project, value.id) };
    }
    case 'lighting.plan.delete': {
      const value = plan(project, p.id);
      if (value.locked) throw new DomainError(`Lighting plan is locked: ${value.id}`, 'LOCKED', 409);
      const usage = lightingPlanUsage(project, value.id);
      if (usage.workspace || usage.sceneIds.length || usage.directShotIds.length)
        throw new DomainError(`Lighting plan is in use: ${JSON.stringify(usage)}`, 'IN_USE', 409);
      project.lightingPlans = project.lightingPlans!.filter((item) => item.id !== value.id);
      return { id: value.id, deleted: true };
    }
    case 'lighting.scene.bind': {
      if (p.planId !== null) plan(project, p.planId);
      const sceneId = p.sceneId ?? project.production?.activeSceneId;
      const scene = project.production?.scenes.find((item) => item.id === sceneId);
      if (sceneId && !scene) throw new DomainError(`Scene not found: ${String(sceneId)}`, 'NOT_FOUND', 404);
      if (scene?.locked) throw new DomainError(`Scene is locked: ${scene.id}`, 'LOCKED', 409);
      const targets =
        !scene || scene.id === project.production?.activeSceneId
          ? [project.settings, ...(scene ? [scene] : [])]
          : [scene];
      for (const target of targets) {
        if (p.planId === null) delete target.lightingPlanId;
        else target.lightingPlanId = String(p.planId);
      }
      return {
        sceneId: scene?.id ?? null,
        planId: p.planId,
        shotIds: project.shots
          .filter((shot) => !shot.lightingPlanId && (!scene || shot.sceneId === scene.id))
          .map((shot) => shot.id),
      };
    }
    case 'lighting.shot.bind': {
      if (p.planId !== null) plan(project, p.planId);
      const shot = project.shots.find((item) => item.id === p.shotId);
      if (!shot) throw new DomainError(`Shot not found: ${String(p.shotId)}`, 'NOT_FOUND', 404);
      if (shot.locked) throw new DomainError(`Shot is locked: ${shot.id}`, 'LOCKED', 409);
      if (p.planId === null) delete shot.lightingPlanId;
      else shot.lightingPlanId = String(p.planId);
      return { shotId: shot.id, planId: p.planId, lighting: resolveLighting(project, shot) };
    }
    default:
      throw new DomainError(`Unknown lighting command: ${command.type}`);
  }
}
