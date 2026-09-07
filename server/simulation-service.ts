import { createHash } from 'node:crypto';
import { z } from 'zod';
import { physicsBakeSchema } from '../shared/physics';
import { bakePhysics } from './simulation';
import { ApiError } from './errors';
import type { Store } from './store';

const identifier = z.string().min(1).max(160);
export const simulationRequestSchema = z
  .object({
    options: physicsBakeSchema,
    projectId: identifier.optional(),
    expectedRevision: z.number().int().min(0).optional(),
    expectedContext: z
      .object({ sceneId: identifier.nullable(), performanceId: identifier.nullable() })
      .strict()
      .optional(),
    requestId: z.string().min(1).max(200).optional(),
  })
  .strict();

export async function simulateProject(store: Store, input: unknown) {
  const request = simulationRequestSchema.parse(input);
  const project = store.project();
  if (request.projectId && request.projectId !== project.id)
    throw new ApiError('PROJECT_CONFLICT', 'The active project changed before physics baking', 409);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ operation: 'simulation.bake', options: request.options }))
    .digest('hex');
  if (request.requestId) {
    const cached = store.cachedCommands(project.id, request.requestId, fingerprint);
    if (cached) return cached;
  }
  if (request.expectedRevision !== undefined && request.expectedRevision !== project.revision)
    throw new ApiError('REVISION_CONFLICT', 'Project changed before physics baking', 409);
  const context = {
    sceneId: project.production?.activeSceneId ?? null,
    performanceId: project.production?.activePerformanceId ?? null,
  };
  if (
    request.expectedContext &&
    (request.expectedContext.sceneId !== context.sceneId ||
      request.expectedContext.performanceId !== context.performanceId)
  )
    throw new ApiError(
      'CONTEXT_CONFLICT',
      'The active scene or performance changed before physics baking',
      409,
    );
  const result = await bakePhysics(project, request.options);
  return store.commands(
    {
      commands: result.commands,
      projectId: project.id,
      expectedRevision: project.revision,
      expectedContext: context,
      requestId: request.requestId,
    },
    fingerprint,
  );
}
