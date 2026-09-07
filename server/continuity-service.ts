import { z } from 'zod';
import { analyzeContinuity, reportOptionsSchema } from '../shared/continuity';
import { ApiError } from './errors';
import type { Store } from './store';

export const continuityRequestSchema = reportOptionsSchema
  .extend({
    projectId: z.string().min(1).max(160).optional(),
    expectedRevision: z.number().int().min(0).optional(),
  })
  .strict();

export function inspectContinuity(store: Store, input: unknown) {
  const { projectId, expectedRevision, ...options } = continuityRequestSchema.parse(input);
  const project = store.project();
  if (projectId && projectId !== project.id)
    throw new ApiError('PROJECT_CONFLICT', 'The active project changed before continuity analysis', 409);
  if (expectedRevision !== undefined && expectedRevision !== project.revision)
    throw new ApiError('REVISION_CONFLICT', 'The project changed before continuity analysis', 409);
  return analyzeContinuity(project, options);
}
