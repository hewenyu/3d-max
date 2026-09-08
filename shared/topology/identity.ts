import { z } from 'zod';
import { TopologyError, type IdentifiedMesh, type MeshIdentity, type TopologyMesh } from './types';

const componentId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[1-9][0-9]{0,15}$`));
export const meshIdentitySchema = z
  .object({
    version: z.literal(1),
    namespace: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9_.-]+$/),
    nextId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    vertexIds: z.array(componentId('v')).max(100000),
    faceIds: z.array(componentId('f')).max(100000),
  })
  .strict()
  .superRefine((identity, context) => {
    const numbers = [...identity.vertexIds, ...identity.faceIds].map((id) => Number(id.slice(1)));
    if (numbers.some((value) => !Number.isSafeInteger(value) || value >= identity.nextId))
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Component IDs must precede nextId' });
    if (new Set(numbers).size !== numbers.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Component allocation numbers must be unique',
      });
  });

export function validateMeshIdentity(mesh: TopologyMesh, context: z.RefinementCtx) {
  if (!mesh.identity) return;
  if (mesh.identity.vertexIds.length !== mesh.vertices.length)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['identity', 'vertexIds'],
      message: 'Stable vertex IDs must correspond one-to-one with vertices',
    });
  if (mesh.identity.faceIds.length !== mesh.faces.length)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['identity', 'faceIds'],
      message: 'Stable face IDs must correspond one-to-one with faces',
    });
}

function legacyNamespace(mesh: TopologyMesh): string {
  const data = JSON.stringify([mesh.vertices, mesh.faces]);
  let left = 2166136261;
  let right = 2246822507;
  for (let index = 0; index < data.length; index++) {
    const value = data.charCodeAt(index);
    left = Math.imul(left ^ value, 16777619);
    right = Math.imul(right ^ value, 3266489909);
  }
  return `mesh-${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

export function ensureMeshIdentity(mesh: TopologyMesh, namespace?: string): IdentifiedMesh {
  const result = structuredClone(mesh);
  if (result.identity) {
    result.identity = meshIdentitySchema.parse(result.identity);
    if (
      result.identity.vertexIds.length !== result.vertices.length ||
      result.identity.faceIds.length !== result.faces.length
    )
      throw new TopologyError('Stable component IDs do not match mesh geometry', 'INVALID_IDENTITY');
    if (namespace && namespace !== result.identity.namespace)
      throw new TopologyError('Mesh identity namespace does not match', 'STALE_SELECTION', 409);
  } else {
    let nextId = 1;
    result.identity = meshIdentitySchema.parse({
      version: 1,
      namespace: namespace ?? legacyNamespace(result),
      nextId: result.vertices.length + result.faces.length + 1,
      vertexIds: result.vertices.map(() => `v${nextId++}`),
      faceIds: result.faces.map(() => `f${nextId++}`),
    });
  }
  return result as IdentifiedMesh;
}

export function allocateComponentId(identity: MeshIdentity, kind: 'vertex' | 'face'): string {
  if (!Number.isSafeInteger(identity.nextId) || identity.nextId >= Number.MAX_SAFE_INTEGER)
    throw new TopologyError('Mesh component ID space is exhausted', 'IDENTITY_EXHAUSTED', 409);
  return `${kind === 'vertex' ? 'v' : 'f'}${identity.nextId++}`;
}

export function stableEdgeId(left: string, right: string): string {
  return Number(left.slice(1)) < Number(right.slice(1)) ? `e:${left}:${right}` : `e:${right}:${left}`;
}
