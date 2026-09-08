import type { MeshData } from '../../shared/modeling';
import type { Project, SceneObject } from '../../shared/types';
import { evaluateModelObject } from '../../shared/object-modeling';

export interface GeometryRequest {
  objects: SceneObject[];
  objectId: string;
}
export type GeometryResponse =
  { mesh: MeshData } | { error: { code: string; message: string; details?: unknown } };
export function evaluateGeometryRequest(input: GeometryRequest): GeometryResponse {
  try {
    const project: Pick<Project, 'objects'> = { objects: input.objects };
    const object = input.objects.find((candidate) => candidate.id === input.objectId);
    if (!object) throw new Error('Geometry worker object is missing');
    return { mesh: evaluateModelObject(project, object) };
  } catch (error) {
    const value = error as Error & { code?: string; details?: unknown };
    return {
      error: { code: value.code ?? 'GEOMETRY_ERROR', message: value.message, details: value.details },
    };
  }
}
self.addEventListener('message', (event: MessageEvent<GeometryRequest>) =>
  self.postMessage(evaluateGeometryRequest(event.data)),
);
self.postMessage({ ready: true });
