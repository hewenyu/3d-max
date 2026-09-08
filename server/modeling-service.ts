import {
  modelingReadGuardSchema,
  meshInspectSchema,
  meshSelectionQuerySchema,
} from '../shared/topology-schema';
import { inspectModelGeometry, sourceTopologyMesh } from '../shared/modeling-inspection';
import { diagnoseMesh } from '../shared/topology/diagnostics';
import { selectComponents } from '../shared/topology/selection';
import type { z } from 'zod';
import type { Store } from './store';
import { ApiError } from './errors';

export function guardedMeshSource(store: Store, request: z.infer<typeof modelingReadGuardSchema>) {
  const project = store.project();
  if (project.id !== request.projectId)
    throw new ApiError('PROJECT_MISMATCH', 'The active project changed', 409);
  if (project.revision !== request.expectedRevision)
    throw new ApiError('REVISION_MISMATCH', 'The project changed; inspect its current revision', 409);
  const context = {
    sceneId: project.production?.activeSceneId ?? null,
    performanceId: project.production?.activePerformanceId ?? null,
  };
  if (
    context.sceneId !== request.expectedContext.sceneId ||
    context.performanceId !== request.expectedContext.performanceId
  )
    throw new ApiError('CONTEXT_MISMATCH', 'The active scene or performance changed', 409);
  const object = project.objects.find((object) => object.id === request.objectId);
  if (!object) throw new ApiError('NOT_FOUND', 'The object is not in the active scene', 404);
  return { projectId: project.id, revision: project.revision, context, object };
}

export function inspectMesh(store: Store, input: unknown) {
  const request = meshInspectSchema.parse(input);
  const { object, ...snapshot } = guardedMeshSource(store, request);
  const { mesh, page } = inspectModelGeometry(object, request, store.project());
  return {
    ...snapshot,
    objectId: object.id,
    ...page,
    diagnostics: diagnoseMesh(mesh, { tolerance: request.tolerance }),
  };
}

export function queryMeshSelection(store: Store, input: unknown) {
  const request = meshSelectionQuerySchema.parse(input);
  const { object, ...snapshot } = guardedMeshSource(store, request);
  const selection = selectComponents(sourceTopologyMesh(object), request.selection);
  return { ...snapshot, objectId: object.id, selection };
}
