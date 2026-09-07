import { DomainError } from './domain-error';
import { z } from 'zod';
import { dequal } from 'dequal';
import type { Project, ProjectSettings } from './types';
import type { objectSchema, beatSchema, audioSchema } from './schema';
import { synchronizationSchema } from './synchronization';
import {
  productionPerformance,
  productionScene,
  resolveShotProject,
  type ProductionProject,
  type ProductionShot,
  type ProductionState,
} from './production';

export function createProductionSchema(schemas: {
  object: typeof objectSchema;
  beat: typeof beatSchema;
  audio: typeof audioSchema;
  lighting: z.ZodType<ProjectSettings['lighting']>;
  environment: z.ZodType<ProjectSettings['environment']>;
}): z.ZodType<ProductionState, z.ZodTypeDef, unknown> {
  const id = z.string().min(1).max(160);
  const name = z.string().min(1).max(200);
  const track = schemas.object
    .pick({
      position: true,
      rotation: true,
      scale: true,
      visible: true,
      keyframes: true,
      actor: true,
      morph: true,
      attachment: true,
      motion: true,
      physics: true,
      motionEvents: true,
      rotationInterpolation: true,
      effect: true,
    })
    .extend({ objectId: id })
    .strict();
  return z
    .object({
      activeSceneId: id,
      activePerformanceId: id,
      scenes: z
        .array(
          z
            .object({
              id,
              name,
              locked: z.boolean(),
              objects: z.array(schemas.object),
              lighting: schemas.lighting,
              lightingPlanId: id.optional(),
              environment: schemas.environment,
              axisActorIds: z.array(id).max(2),
              performances: z
                .array(
                  z
                    .object({
                      id,
                      name,
                      locked: z.boolean(),
                      tracks: z.array(track),
                      beats: z.array(schemas.beat),
                      audio: z.array(schemas.audio),
                      synchronization: synchronizationSchema.optional(),
                    })
                    .strict(),
                )
                .min(1),
            })
            .strict(),
        )
        .min(1),
      storyScenes: z.array(
        z
          .object({
            id,
            name,
            sceneId: id,
            performanceId: id,
            location: z.string().max(300),
            timeOfDay: z.string().max(100),
            description: z.string().max(10000),
          })
          .strict(),
      ),
    })
    .strict();
}

export function validateProduction(
  project: ProductionProject,
  validateView: (project: unknown) => Project,
): void {
  const state = project.production;
  if (!state) return;
  const ids = [
    ...state.scenes.map((scene) => scene.id),
    ...state.scenes.flatMap((scene) => scene.performances.map((take) => take.id)),
    ...state.storyScenes.map((story) => story.id),
  ];
  if (new Set(ids).size !== ids.length) throw new DomainError('Duplicate production entity ID');
  if (!productionPerformance(project)) throw new DomainError('Active scene or performance does not exist');
  for (const scene of state.scenes) {
    if (new Set(scene.objects.map((object) => object.id)).size !== scene.objects.length)
      throw new DomainError(`Duplicate object in scene: ${scene.id}`);
    const objects = new Set(scene.objects.map((object) => object.id));
    for (const take of scene.performances) {
      const tracks = take.tracks.map((track) => track.objectId);
      if (new Set(tracks).size !== tracks.length || tracks.some((id) => !objects.has(id)))
        throw new DomainError(`Invalid performance tracks: ${take.id}`);
      const shotIds = new Set(
        (project.shots as ProductionShot[])
          .filter((shot) => shot.sceneId === scene.id && shot.performanceId === take.id)
          .map((shot) => shot.id),
      );
      const projection = resolveShotProject(
        project,
        {
          sceneId: scene.id,
          performanceId: take.id,
        } as ProductionShot,
        { useStoredPerformance: true },
      );
      const { production: _production, ...view } = projection as ProductionProject;
      validateView({
        ...view,
        shots: project.shots
          .filter((shot) => shotIds.has(shot.id))
          .map((shot) => {
            const {
              sceneId: _sceneId,
              performanceId: _takeId,
              storySceneId: _storyId,
              ...plain
            } = shot as ProductionShot;
            return plain;
          }),
        sequences: project.sequences.map((sequence) => ({
          ...sequence,
          // Cross-scene transitions are validated against the complete sequence above.
          clips: sequence.clips
            .filter((clip) => shotIds.has(clip.shotId))
            .map(({ transitionIn: _transitionIn, ...clip }) => clip),
        })),
        notes: project.notes.filter((note) => !note.shotId || shotIds.has(note.shotId)),
      });
      if (scene.id === state.activeSceneId && take.id === state.activePerformanceId) {
        const fields = ['sceneName', 'objects', 'beats', 'audio', 'synchronization'] as const;
        const settings = ['lighting', 'lightingPlanId', 'environment', 'axisActorIds'] as const;
        if (
          fields.some((field) => !dequal(project[field], projection[field])) ||
          settings.some((field) => !dequal(project.settings[field], projection.settings[field]))
        )
          throw new DomainError(
            'Active workspace does not match its stored scene and performance',
            'VALIDATION_ERROR',
          );
      }
    }
  }
  for (const shot of project.shots as ProductionShot[]) {
    if (
      !shot.sceneId ||
      !shot.performanceId ||
      !productionPerformance(project, shot.sceneId, shot.performanceId)
    )
      throw new DomainError(`Missing production binding on shot: ${shot.id}`);
    if (shot.storySceneId) {
      const story = state.storyScenes.find((item) => item.id === shot.storySceneId);
      if (!story || story.sceneId !== shot.sceneId || story.performanceId !== shot.performanceId)
        throw new DomainError(`Invalid story scene for shot: ${shot.id}`);
    }
  }
  for (const story of state.storyScenes) {
    if (
      !productionScene(project, story.sceneId) ||
      !productionPerformance(project, story.sceneId, story.performanceId)
    )
      throw new DomainError(`Invalid story scene: ${story.id}`);
  }
}
