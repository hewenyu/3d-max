export type TopologyVector = [number, number, number];
export interface MeshIdentity {
  version: 1;
  namespace: string;
  nextId: number;
  vertexIds: string[];
  faceIds: string[];
}
export interface TopologyMesh {
  kind: 'mesh';
  vertices: TopologyVector[];
  faces: number[][];
  smooth: boolean;
  identity?: MeshIdentity;
}
export type IdentifiedMesh = TopologyMesh & { identity: MeshIdentity };
export type ComponentKind = 'vertex' | 'edge' | 'face';
export interface ComponentSelection {
  namespace: string;
  kind: ComponentKind;
  ids: string[];
}
export interface TopologyEdge {
  id: string;
  vertices: [number, number];
  faces: number[];
  directions: number[];
}
export interface MeshTopology {
  mesh: IdentifiedMesh;
  edges: TopologyEdge[];
  edgeById: Map<string, number>;
  vertexById: Map<string, number>;
  faceById: Map<string, number>;
  vertexEdges: number[][];
  vertexFaces: number[][];
  faceEdges: number[][];
}
export interface ComponentChanges {
  preserved: string[];
  created: string[];
  deleted: string[];
  replacements: Record<string, string[]>;
}
export interface TopologyChanges {
  namespace: string;
  vertex: ComponentChanges;
  edge: ComponentChanges;
  face: ComponentChanges;
}
export interface MeshEditResult {
  mesh: IdentifiedMesh;
  changes: TopologyChanges;
}
export class TopologyError extends Error {
  constructor(
    message: string,
    public code = 'INVALID_TOPOLOGY',
    public status = 400,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TopologyError';
  }
}
export const TOPOLOGY_LIMITS = {
  vertices: 100000,
  faces: 100000,
  faceVertices: 256,
  triangles: 150000,
  coordinate: 100000,
  diagnosticComparisons: 5000000,
};
