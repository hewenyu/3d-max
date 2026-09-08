import { Box3, Vector3 } from 'three';
import type { Project, SceneObject } from './types';
import { evaluateModelObject } from './object-modeling';
import { supportsMeshConversion } from './modeling';
import { modelingToMesh, primitiveToMesh } from './modeling-geometry';
import { buildTopology, meshFaceNormal } from './topology/adjacency';
import { ensureMeshIdentity } from './topology/identity';
import { TopologyError, type ComponentKind } from './topology/types';

export function sourceTopologyMesh(object: SceneObject) {
  const source = object.modeling?.kind === 'stack' ? object.modeling.base : object.modeling;
  if (source?.kind !== 'mesh')
    throw new TopologyError(
      'Convert the source to an editable mesh before selecting components',
      'SOURCE_NOT_MESH',
    );
  return ensureMeshIdentity(source);
}

export function inspectModelGeometry(
  object: SceneObject,
  request: { stage: 'source' | 'evaluated'; kind: ComponentKind; offset: number; limit: number },
  project?: Project,
) {
  if (request.stage === 'evaluated' && !supportsMeshConversion(object))
    throw new TopologyError(
      'Object geometry requires explicit static model conversion',
      'UNSUPPORTED_GEOMETRY',
    );
  const mesh =
    request.stage === 'source'
      ? sourceTopologyMesh(object)
      : ensureMeshIdentity(
          project
            ? evaluateModelObject(project, object)
            : object.modeling
              ? modelingToMesh(object.modeling)
              : primitiveToMesh(object),
        );
  const topology = buildTopology(mesh);
  const vertexId = (index: number) => mesh.identity.vertexIds[index];
  const faceId = (index: number) => mesh.identity.faceIds[index];
  const edgeId = (index: number) => topology.edges[index].id;
  const total =
    request.kind === 'vertex'
      ? mesh.vertices.length
      : request.kind === 'face'
        ? mesh.faces.length
        : topology.edges.length;
  const end = Math.min(total, request.offset + request.limit);
  const elements = Array.from({ length: Math.max(0, end - request.offset) }, (_, offset) => {
    const index = request.offset + offset;
    if (request.kind === 'vertex')
      return {
        id: vertexId(index),
        index,
        position: mesh.vertices[index],
        edges: topology.vertexEdges[index].map(edgeId),
        faces: topology.vertexFaces[index].map(faceId),
      };
    if (request.kind === 'edge') {
      const edge = topology.edges[index];
      return {
        id: edge.id,
        index,
        vertices: edge.vertices.map(vertexId),
        faces: edge.faces.map(faceId),
        positions: edge.vertices.map((vertex) => mesh.vertices[vertex]),
        boundary: edge.faces.length === 1,
      };
    }
    const face = mesh.faces[index];
    return {
      id: faceId(index),
      index,
      vertices: face.map(vertexId),
      edges: topology.faceEdges[index].map(edgeId),
      positions: face.map((vertex) => mesh.vertices[vertex]),
      normal: meshFaceNormal(mesh, face).normalize().toArray(),
      center: face
        .reduce((sum, vertex) => sum.add(new Vector3(...mesh.vertices[vertex])), new Vector3())
        .multiplyScalar(1 / face.length)
        .toArray(),
    };
  });
  const bounds = new Box3();
  mesh.vertices.forEach((vertex) => bounds.expandByPoint(new Vector3(...vertex)));
  return {
    mesh,
    page: {
      stage: request.stage,
      namespace: mesh.identity.namespace,
      kind: request.kind,
      editable: request.stage === 'source',
      offset: request.offset,
      total,
      nextOffset: end < total ? end : null,
      elements,
      bounds: {
        min: bounds.min.toArray(),
        max: bounds.max.toArray(),
        dimensions: bounds.getSize(new Vector3()).toArray(),
      },
    },
  };
}
