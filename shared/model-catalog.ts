import { z } from 'zod';
import { DomainError } from './domain-error';
import type { Command, Project } from './types';

export const modelCatalogRequestSchema = z
  .object({
    projectId: z.string().min(1).max(200).optional(),
    objectId: z.string().min(1).max(160),
  })
  .strict();
export interface ModelCatalog {
  objectId: string;
  assetUrl: string;
  nodes: { index: number; name: string; parent: number | null; mesh: boolean; skin: number | null }[];
  skins: { index: number; name: string; skeleton: number | null; joints: number[] }[];
  animations: { index: number; name: string; duration: number; channels: { node: number; path: string }[] }[];
  compatibility: {
    embeddedAnimation: 'available' | 'none';
    skeleton: 'skinned' | 'static';
    builtinActorRetargeting: false;
  };
}
export const modelCommandDefinitions = [
  {
    type: 'model.animation.set',
    description:
      'Select an embedded glTF animation by stable zero-based index from model_catalog. null selects the static bind pose. Playback uses source time and loops the selected clip; imported skeletons are not retargeted to built-in actor actions.',
    schema: z
      .object({
        id: z.string().min(1).max(160),
        animationIndex: z.number().int().min(0).max(10000).nullable(),
      })
      .strict(),
  },
];
export function applyModelCommand(project: Project, command: Command) {
  const object = project.objects.find((item) => item.id === command.payload.id);
  if (!object || object.type !== 'model') throw new DomainError('Select an imported model', 'NOT_FOUND', 404);
  if (object.locked) throw new DomainError('Model is locked', 'LOCKED', 409);
  object.animationIndex = command.payload.animationIndex as number | null;
  delete object.animationName;
  return object;
}
