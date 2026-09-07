import { DomainError } from './domain-error';
import { z } from 'zod';
import type { Command } from './types';
import {
  affectedShots,
  bindShotProduction,
  createScene,
  duplicatePerformance,
  ensureProduction,
  productionPerformance,
  productionScene,
  selectProduction,
  syncProduction,
  type ProductionProject,
  type ProductionShot,
  type StoryScene,
} from './production';

const identifier = z.string().min(1).max(160);
const name = z.string().min(1).max(200);
const sceneSelection = { sceneId: identifier, performanceId: identifier.optional() };
const namedPatch = z.object({ name: name.optional(), locked: z.boolean().optional() }).strict();
const storyFields = {
  name,
  sceneId: identifier,
  performanceId: identifier,
  location: z.string().max(300),
  timeOfDay: z.string().max(100),
  description: z.string().max(10000),
};

export const productionCommandDefinitions = [
  {
    type: 'production.initialize',
    description:
      'Promote a legacy single-scene project to an explicit scene and performance library without changing its visible content.',
    schema: z.object({}).strict(),
  },
  {
    type: 'scene.create',
    description:
      'Create an empty scene or reuse an existing scene with independent geometry and performances.',
    schema: z
      .object({
        id: identifier.optional(),
        name,
        sourceSceneId: identifier.optional(),
        performanceId: identifier.optional(),
        select: z.boolean().default(true),
      })
      .strict(),
  },
  {
    type: 'scene.select',
    description: 'Save the current scene and activate another scene and performance for editing.',
    schema: z.object(sceneSelection).strict(),
  },
  {
    type: 'scene.update',
    description: 'Rename or lock a shared scene. Results list affected shots.',
    schema: z.object({ id: identifier, patch: namedPatch }).strict(),
  },
  {
    type: 'scene.delete',
    description: 'Delete an unreferenced scene; at least one scene remains.',
    schema: z.object({ id: identifier }).strict(),
  },
  {
    type: 'performance.duplicate',
    description:
      'Create an independent performance version sharing scene geometry; existing camera bindings are preserved.',
    schema: z
      .object({
        sceneId: identifier,
        id: identifier,
        name,
        newId: identifier.optional(),
        select: z.boolean().default(true),
      })
      .strict(),
  },
  {
    type: 'performance.select',
    description: 'Activate an independent performance for editing without rebinding existing shots.',
    schema: z.object({ sceneId: identifier, id: identifier }).strict(),
  },
  {
    type: 'performance.update',
    description: 'Rename or lock a performance; list shots sharing that performance.',
    schema: z.object({ sceneId: identifier, id: identifier, patch: namedPatch }).strict(),
  },
  {
    type: 'performance.delete',
    description: 'Delete an unreferenced performance version; every scene retains at least one.',
    schema: z.object({ sceneId: identifier, id: identifier }).strict(),
  },
  {
    type: 'shot.binding',
    description: 'Bind a shot to an explicit scene and performance without changing other shots.',
    schema: z
      .object({
        id: identifier,
        sceneId: identifier,
        performanceId: identifier,
        storySceneId: identifier.optional(),
      })
      .strict(),
  },
  {
    type: 'storyScene.create',
    description:
      'Create a story scene with location, time of day and narrative description tied to an editable scene and performance.',
    schema: z.object({ id: identifier.optional(), ...storyFields }).strict(),
  },
  {
    type: 'storyScene.update',
    description: 'Edit narrative story-scene metadata; existing shot bindings must remain consistent.',
    schema: z.object({ id: identifier, patch: z.object(storyFields).partial().strict() }).strict(),
  },
  {
    type: 'storyScene.delete',
    description: 'Delete a story-scene record; referenced shots must be unbound first.',
    schema: z.object({ id: identifier }).strict(),
  },
];

function unlocked(value: { id: string; locked: boolean }, patch?: Record<string, unknown>) {
  if (value.locked && !(patch && Object.keys(patch).length === 1 && patch.locked === false))
    throw new DomainError(`Entity is locked: ${value.id}`);
}

export function applyProductionCommand(project: ProductionProject, command: Command): unknown {
  const state = ensureProduction(project);
  syncProduction(project);
  const p = command.payload;
  switch (command.type) {
    case 'production.initialize':
      return state;
    case 'scene.create': {
      const scene = createScene(project, String(p.name), p);
      if (p.select !== false) selectProduction(project, scene.id);
      return scene;
    }
    case 'scene.select':
      selectProduction(project, String(p.sceneId), p.performanceId as string | undefined);
      return { sceneId: state.activeSceneId, performanceId: state.activePerformanceId };
    case 'scene.update': {
      const scene = productionScene(project, String(p.id));
      if (!scene) throw new DomainError('Scene does not exist');
      const patch = p.patch as { name?: string; locked?: boolean };
      unlocked(scene, patch);
      Object.assign(scene, patch);
      if (scene.id === state.activeSceneId) project.sceneName = scene.name;
      return { scene, affectedShotIds: affectedShots(project, scene.id).map((shot) => shot.id) };
    }
    case 'scene.delete': {
      const scene = productionScene(project, String(p.id));
      if (!scene) throw new DomainError('Scene does not exist');
      unlocked(scene);
      if (state.scenes.length === 1) throw new DomainError('Keep at least one scene');
      if (
        affectedShots(project, scene.id).length ||
        state.storyScenes.some((story) => story.sceneId === scene.id)
      )
        throw new DomainError('Scene is referenced by shots or story scenes');
      if (state.activeSceneId === scene.id)
        selectProduction(project, state.scenes.find((item) => item.id !== scene.id)!.id);
      state.scenes = state.scenes.filter((item) => item.id !== scene.id);
      return { id: scene.id, deleted: true };
    }
    case 'performance.duplicate': {
      const take = duplicatePerformance(
        project,
        String(p.sceneId),
        String(p.id),
        String(p.name),
        p.newId as string | undefined,
      );
      if (p.select !== false) selectProduction(project, String(p.sceneId), take.id);
      return take;
    }
    case 'performance.select':
      selectProduction(project, String(p.sceneId), String(p.id));
      return { sceneId: state.activeSceneId, performanceId: state.activePerformanceId };
    case 'performance.update': {
      const take = productionPerformance(project, String(p.sceneId), String(p.id));
      if (!take) throw new DomainError('Performance does not exist');
      const patch = p.patch as { name?: string; locked?: boolean };
      unlocked(take, patch);
      Object.assign(take, patch);
      return {
        performance: take,
        affectedShotIds: affectedShots(project, String(p.sceneId), take.id).map((shot) => shot.id),
      };
    }
    case 'performance.delete': {
      const scene = productionScene(project, String(p.sceneId));
      const take = productionPerformance(project, String(p.sceneId), String(p.id));
      if (!scene || !take) throw new DomainError('Scene or performance does not exist');
      unlocked(scene);
      unlocked(take);
      if (scene.performances.length === 1) throw new DomainError('Keep at least one performance');
      if (
        affectedShots(project, scene.id, take.id).length ||
        state.storyScenes.some((story) => story.performanceId === take.id)
      )
        throw new DomainError('Performance is referenced by shots or story scenes');
      if (take.id === state.activePerformanceId)
        selectProduction(project, scene.id, scene.performances.find((item) => item.id !== take.id)!.id);
      scene.performances = scene.performances.filter((item) => item.id !== take.id);
      return { id: take.id, deleted: true };
    }
    case 'shot.binding': {
      const shot = bindShotProduction(project, String(p.id), String(p.sceneId), String(p.performanceId));
      if (p.storySceneId) {
        const story = state.storyScenes.find((item) => item.id === p.storySceneId);
        if (!story || story.sceneId !== shot.sceneId || story.performanceId !== shot.performanceId)
          throw new DomainError('Story scene does not match shot scene and performance');
        shot.storySceneId = story.id;
      }
      return shot;
    }
    case 'storyScene.create': {
      if (!productionPerformance(project, String(p.sceneId), String(p.performanceId)))
        throw new DomainError('Scene or performance does not exist');
      const story = { ...p, id: p.id ?? `story-${crypto.randomUUID()}` } as StoryScene;
      if (state.storyScenes.some((item) => item.id === story.id))
        throw new DomainError('Story scene ID already exists');
      state.storyScenes.push(story);
      return story;
    }
    case 'storyScene.update': {
      const story = state.storyScenes.find((item) => item.id === p.id);
      if (!story) throw new DomainError('Story scene does not exist');
      Object.assign(story, p.patch);
      if (!productionPerformance(project, story.sceneId, story.performanceId))
        throw new DomainError('Scene or performance does not exist');
      if (
        (project.shots as ProductionShot[]).some(
          (shot) =>
            shot.storySceneId === story.id &&
            (shot.sceneId !== story.sceneId || shot.performanceId !== story.performanceId),
        )
      )
        throw new DomainError('Update bound shots before changing story-scene references');
      return story;
    }
    case 'storyScene.delete': {
      const story = state.storyScenes.find((item) => item.id === p.id);
      if (!story) throw new DomainError('Story scene does not exist');
      if ((project.shots as ProductionShot[]).some((shot) => shot.storySceneId === story.id))
        throw new DomainError('Story scene is referenced by a shot');
      state.storyScenes = state.storyScenes.filter((item) => item.id !== story.id);
      return { id: story.id, deleted: true };
    }
    default:
      throw new DomainError(`Unknown production command: ${command.type}`);
  }
}
