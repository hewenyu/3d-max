import { Vector2, Vector3 } from 'three';
import { ensureMeshIdentity, stableEdgeId } from './identity';
import { simplePolygon } from './polygon';
import { TOPOLOGY_LIMITS, TopologyError, type MeshTopology, type TopologyMesh } from './types';

export function validateMeshStructure(mesh: TopologyMesh) {
  const limits = TOPOLOGY_LIMITS;
  if (mesh.vertices.length < 3 || mesh.faces.length < 1)
    throw new TopologyError('An editable mesh requires at least three vertices and one face');
  if (mesh.vertices.length > limits.vertices || mesh.faces.length > limits.faces)
    throw new TopologyError('Mesh exceeds topology capacity', 'TOPOLOGY_LIMIT', 400, { limits });
  if (
    mesh.vertices.some(
      (vertex) =>
        vertex.length !== 3 ||
        vertex.some((value) => !Number.isFinite(value) || Math.abs(value) > limits.coordinate),
    )
  )
    throw new TopologyError('Vertex coordinates must be finite and within the scene coordinate limit');
  let triangles = 0;
  for (let index = 0; index < mesh.faces.length; index++) {
    const face = mesh.faces[index];
    if (
      face.length < 3 ||
      face.length > limits.faceVertices ||
      new Set(face).size !== face.length ||
      face.some((vertex) => !Number.isInteger(vertex) || vertex < 0 || vertex >= mesh.vertices.length)
    )
      throw new TopologyError('Face requires distinct valid vertex indices', 'INVALID_FACE', 400, {
        faceIndex: index,
      });
    triangles += face.length - 2;
  }
  if (triangles > limits.triangles)
    throw new TopologyError('Mesh exceeds the triangle capacity', 'TOPOLOGY_LIMIT', 400, {
      triangles,
      limit: limits.triangles,
    });
}

export function meshFaceNormal(mesh: TopologyMesh, face: number[]): Vector3 {
  const normal = new Vector3();
  for (let index = 0; index < face.length; index++) {
    const a = mesh.vertices[face[index]];
    const b = mesh.vertices[face[(index + 1) % face.length]];
    normal.x += (a[1] - b[1]) * (a[2] + b[2]);
    normal.y += (a[2] - b[2]) * (a[0] + b[0]);
    normal.z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normal;
}

export function assertNondegenerateFaces(mesh: TopologyMesh) {
  validateMeshStructure(mesh);
  for (let index = 0; index < mesh.faces.length; index++) {
    const face = mesh.faces[index];
    if (
      meshFaceNormal(mesh, face).length() < 1e-8 ||
      face.some(
        (vertex, corner) =>
          new Vector3(...mesh.vertices[vertex]).distanceTo(
            new Vector3(...mesh.vertices[face[(corner + 1) % face.length]]),
          ) < 1e-10,
      )
    )
      throw new TopologyError('Operation produced a degenerate face', 'DEGENERATE_FACE', 400, {
        faceIndex: index,
      });
    const normal = meshFaceNormal(mesh, face).normalize();
    const origin = new Vector3(...mesh.vertices[face[0]]);
    if (
      face.every((vertex) => Math.abs(new Vector3(...mesh.vertices[vertex]).sub(origin).dot(normal)) <= 1e-6)
    ) {
      const components = normal.toArray().map(Math.abs);
      const drop = components.indexOf(Math.max(...components));
      const axes = [0, 1, 2].filter((axis) => axis !== drop);
      if (
        !simplePolygon(
          face.map((vertex) => new Vector2(mesh.vertices[vertex][axes[0]], mesh.vertices[vertex][axes[1]])),
        )
      )
        throw new TopologyError(
          'Operation produced a self-intersecting planar face',
          'SELF_INTERSECTION',
          400,
          { faceIndex: index },
        );
    }
  }
}

export function buildTopology(input: TopologyMesh): MeshTopology {
  validateMeshStructure(input);
  const mesh = ensureMeshIdentity(input);
  const topology: MeshTopology = {
    mesh,
    edges: [],
    edgeById: new Map(),
    vertexById: new Map(mesh.identity.vertexIds.map((id, index) => [id, index])),
    faceById: new Map(mesh.identity.faceIds.map((id, index) => [id, index])),
    vertexEdges: mesh.vertices.map(() => []),
    vertexFaces: mesh.vertices.map(() => []),
    faceEdges: mesh.faces.map(() => []),
  };
  mesh.faces.forEach((face, faceIndex) => {
    face.forEach((left, corner) => {
      topology.vertexFaces[left].push(faceIndex);
      const right = face[(corner + 1) % face.length];
      const id = stableEdgeId(mesh.identity.vertexIds[left], mesh.identity.vertexIds[right]);
      let edgeIndex = topology.edgeById.get(id);
      if (edgeIndex === undefined) {
        edgeIndex = topology.edges.length;
        topology.edgeById.set(id, edgeIndex);
        topology.edges.push({ id, vertices: [left, right], faces: [], directions: [] });
        topology.vertexEdges[left].push(edgeIndex);
        topology.vertexEdges[right].push(edgeIndex);
      }
      const edge = topology.edges[edgeIndex];
      edge.faces.push(faceIndex);
      edge.directions.push(edge.vertices[0] === left ? 1 : -1);
      topology.faceEdges[faceIndex].push(edgeIndex);
    });
  });
  return topology;
}
