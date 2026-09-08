import { assertNondegenerateFaces, validateMeshStructure } from './adjacency';
import { allocateComponentId, ensureMeshIdentity, stableEdgeId } from './identity';
import {
  TopologyError,
  type ComponentChanges,
  type ComponentKind,
  type IdentifiedMesh,
  type MeshEditResult,
  type TopologyMesh,
  type TopologyVector,
} from './types';

function changes(
  before: string[],
  after: string[],
  replacements: Record<string, string[]>,
): ComponentChanges {
  const oldIds = new Set(before);
  const newIds = new Set(after);
  return {
    preserved: before.filter((id) => newIds.has(id)),
    created: after.filter((id) => !oldIds.has(id)),
    deleted: before.filter((id) => !newIds.has(id)),
    replacements: Object.fromEntries(
      before.map((id) => [id, replacements[id] ?? (newIds.has(id) ? [id] : [])]),
    ),
  };
}

export function meshEditResult(
  input: TopologyMesh,
  output: IdentifiedMesh,
  replacements: Partial<Record<ComponentKind, Record<string, string[]>>> = {},
): MeshEditResult {
  assertNondegenerateFaces(output);
  validateMeshStructure(input);
  const before = ensureMeshIdentity(input);
  const after = ensureMeshIdentity(output);
  if (before.identity.namespace !== after.identity.namespace)
    throw new TopologyError('A topology edit must preserve its mesh namespace', 'INVALID_IDENTITY');
  // Change maps need ordered edge IDs, not two complete adjacency graphs.
  const edges = (mesh: IdentifiedMesh) => {
    const ids = new Set<string>();
    for (const face of mesh.faces)
      for (let corner = 0; corner < face.length; corner++)
        ids.add(
          stableEdgeId(
            mesh.identity.vertexIds[face[corner]],
            mesh.identity.vertexIds[face[(corner + 1) % face.length]],
          ),
        );
    return [...ids];
  };
  const componentChanges = {
    vertex: changes(before.identity.vertexIds, after.identity.vertexIds, replacements.vertex ?? {}),
    face: changes(before.identity.faceIds, after.identity.faceIds, replacements.face ?? {}),
    edge: changes(edges(before), edges(after), replacements.edge ?? {}),
  };
  for (const kind of ['vertex', 'edge', 'face'] as const) {
    const valid = new Set([...componentChanges[kind].preserved, ...componentChanges[kind].created]);
    if (Object.values(componentChanges[kind].replacements).some((ids) => ids.some((id) => !valid.has(id))))
      throw new TopologyError(
        'Component replacement refers to a missing output component',
        'INVALID_IDENTITY',
      );
  }
  return { mesh: after, changes: { namespace: after.identity.namespace, ...componentChanges } };
}

export class MeshEditor {
  readonly before: IdentifiedMesh;
  readonly mesh: IdentifiedMesh;
  readonly replacements: Partial<Record<ComponentKind, Record<string, string[]>>> = {};
  constructor(input: TopologyMesh, namespace?: string) {
    this.before = ensureMeshIdentity(input, namespace);
    this.mesh = structuredClone(this.before);
  }
  addVertex(position: TopologyVector): number {
    this.mesh.identity.vertexIds.push(allocateComponentId(this.mesh.identity, 'vertex'));
    return this.mesh.vertices.push([...position]) - 1;
  }
  addFace(vertices: number[]): number {
    this.mesh.identity.faceIds.push(allocateComponentId(this.mesh.identity, 'face'));
    return this.mesh.faces.push([...vertices]) - 1;
  }
  replaceFace(index: number, vertices: number[]) {
    if (!this.mesh.faces[index]) throw new TopologyError('Face does not exist', 'COMPONENT_NOT_FOUND', 404);
    this.mesh.faces[index] = [...vertices];
  }
  removeFaces(indices: Iterable<number>) {
    const removed = new Set(indices);
    if ([...removed].some((index) => !this.mesh.faces[index]))
      throw new TopologyError('Face does not exist', 'COMPONENT_NOT_FOUND', 404);
    this.mesh.faces = this.mesh.faces.filter((_, index) => !removed.has(index));
    this.mesh.identity.faceIds = this.mesh.identity.faceIds.filter((_, index) => !removed.has(index));
  }
  removeVertices(indices: Iterable<number>) {
    const removed = new Set(indices);
    if ([...removed].some((index) => !this.mesh.vertices[index]))
      throw new TopologyError('Vertex does not exist', 'COMPONENT_NOT_FOUND', 404);
    if (this.mesh.faces.some((face) => face.some((index) => removed.has(index))))
      throw new TopologyError('Remove or remap incident faces before removing vertices');
    const indexMap = new Map<number, number>();
    let nextIndex = 0;
    this.mesh.vertices.forEach((_, index) => {
      if (!removed.has(index)) indexMap.set(index, nextIndex++);
    });
    this.mesh.vertices = this.mesh.vertices.filter((_, index) => !removed.has(index));
    this.mesh.identity.vertexIds = this.mesh.identity.vertexIds.filter((_, index) => !removed.has(index));
    this.mesh.faces = this.mesh.faces.map((face) => face.map((index) => indexMap.get(index)!));
  }
  map(kind: ComponentKind, oldId: string, newIds: string[]) {
    (this.replacements[kind] ??= {})[oldId] = [...new Set(newIds)];
  }
  finish(): MeshEditResult {
    return meshEditResult(this.before, this.mesh, this.replacements);
  }
}
