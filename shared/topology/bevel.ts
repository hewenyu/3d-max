import { Vector3 } from 'three';
import { buildTopology, meshFaceNormal } from './adjacency';
import { bisectMesh } from './bisect';
import { diagnoseMesh } from './diagnostics';
import { meshEditResult } from './editor';
import { resolveSelection } from './selection';
import {
  TOPOLOGY_LIMITS,
  TopologyError,
  type ComponentSelection,
  type MeshTopology,
  type TopologyMesh,
  type TopologyVector,
} from './types';

export interface MeshBevel {
  selection?: ComponentSelection;
  width: number;
  segments?: number;
  shape?: number;
}
interface BevelPlane {
  normal: TopologyVector;
  offset: number;
  edgeId: string;
  segment: number;
}

function convexNormals(topology: MeshTopology) {
  const mesh = topology.mesh;
  if (mesh.vertices.length * mesh.faces.length > TOPOLOGY_LIMITS.diagnosticComparisons)
    throw new TopologyError(
      'Convex bevel validation exceeds the vertex-face comparison budget',
      'TOPOLOGY_LIMIT',
    );
  const diagnostics = diagnoseMesh(mesh);
  if (!diagnostics.closed)
    throw new TopologyError(
      'Bevel requires a closed manifold surface; cap open boundaries before beveling',
      'BEVEL_REQUIRES_CLOSED',
      400,
      {
        boundaryEdges: diagnostics.boundaryEdges,
        nonManifoldEdges: diagnostics.nonManifoldEdges,
        nonManifoldVertices: diagnostics.nonManifoldVertices,
      },
    );
  if (!diagnostics.consistentlyOriented)
    throw new TopologyError(
      'Bevel requires consistent outward face winding; repair orientation first',
      'INCONSISTENT_WINDING',
      400,
      { edgeIds: diagnostics.inconsistentEdges },
    );
  if (
    diagnostics.degenerateFaces.length ||
    diagnostics.nonPlanarFaces.length ||
    diagnostics.selfIntersectingFaces.length ||
    diagnostics.looseVertices.length
  )
    throw new TopologyError(
      'Bevel requires simple planar faces and no loose vertices',
      'INVALID_BEVEL_SURFACE',
      400,
      {
        degenerateFaces: diagnostics.degenerateFaces,
        nonPlanarFaces: diagnostics.nonPlanarFaces,
        selfIntersectingFaces: diagnostics.selfIntersectingFaces,
        looseVertices: diagnostics.looseVertices,
      },
    );
  const normals = mesh.faces.map((face) => meshFaceNormal(mesh, face).normalize());
  for (let face = 0; face < mesh.faces.length; face++) {
    const origin = new Vector3(...mesh.vertices[mesh.faces[face][0]]);
    const outside = mesh.vertices.findIndex(
      (vertex) => new Vector3(...vertex).sub(origin).dot(normals[face]) > 1e-6,
    );
    if (outside !== -1)
      throw new TopologyError(
        'This bevel kernel requires a globally convex, outward-oriented shell; concave recesses and inward shells cannot use convex plane clipping',
        'NON_CONVEX_BEVEL',
        400,
        { faceId: mesh.identity.faceIds[face], outsideVertexId: mesh.identity.vertexIds[outside] },
      );
  }
  return normals;
}

function edgePlanes(
  topology: MeshTopology,
  edgeIndex: number,
  normals: Vector3[],
  width: number,
  segments: number,
  shape: number,
): BevelPlane[] {
  const edge = topology.edges[edgeIndex];
  const first = normals[edge.faces[0]];
  const second = normals[edge.faces[1]];
  const angle = Math.acos(Math.max(-1, Math.min(1, first.dot(second))));
  if (angle < 1e-5)
    throw new TopologyError('Selected edge is coplanar and has no bevel angle', 'COPLANAR_BEVEL_EDGE', 400, {
      edgeId: edge.id,
    });
  if (angle >= Math.PI - 1e-5)
    throw new TopologyError('Selected edge has an unstable reversed face angle', 'INVALID_BEVEL_ANGLE', 400, {
      edgeId: edge.id,
    });
  const point = new Vector3(...topology.mesh.vertices[edge.vertices[0]]);
  const axis = new Vector3(...topology.mesh.vertices[edge.vertices[1]]).sub(point).normalize();
  const middle = first.clone().add(second).normalize();
  const radius = width / Math.tan(angle / 2);
  const center = point.clone().addScaledVector(middle, -radius / Math.cos(angle / 2));
  const tangentFirst = center.clone().addScaledVector(first, radius);
  const tangentSecond = center.clone().addScaledVector(second, radius);
  const profilePoint = (time: number) => {
    const arcNormal = first
      .clone()
      .multiplyScalar(Math.sin((1 - time) * angle) / Math.sin(angle))
      .addScaledVector(second, Math.sin(time * angle) / Math.sin(angle));
    const arc = center.clone().addScaledVector(arcNormal, radius);
    return tangentFirst.clone().lerp(tangentSecond, time).lerp(arc, shape);
  };
  const count = shape === 0 ? 1 : segments;
  return Array.from({ length: count }, (_, segment) => {
    const left = profilePoint(segment / count);
    const right = profilePoint((segment + 1) / count);
    const normal = right.clone().sub(left).cross(axis).normalize();
    if (normal.dot(middle) < 0) normal.negate();
    return { normal: normal.toArray() as TopologyVector, offset: normal.dot(left), edgeId: edge.id, segment };
  });
}

export function bevelMesh(input: TopologyMesh, request: MeshBevel) {
  const segments = request.segments ?? 1;
  const shape = request.shape ?? 1;
  if (!Number.isFinite(request.width) || request.width <= 1e-6 || request.width > 100000)
    throw new TopologyError('Bevel width must exceed 0.000001 meters and remain within 100000 meters');
  if (!Number.isInteger(segments) || segments < 1 || segments > 16)
    throw new TopologyError('Bevel segments must be an integer from 1 to 16');
  if (!Number.isFinite(shape) || shape < 0 || shape > 1)
    throw new TopologyError('Bevel shape must be between 0 (flat) and 1 (circular)');
  const topology = buildTopology(input);
  const normals = convexNormals(topology);
  if (request.selection && request.selection.kind !== 'edge')
    throw new TopologyError('Bevel selection requires edge mode');
  const edges = request.selection
    ? resolveSelection(topology, request.selection)
    : topology.edges.flatMap((edge, index) =>
        normals[edge.faces[0]].dot(normals[edge.faces[1]]) < 1 - 1e-10 ? [index] : [],
      );
  if (!edges.length) throw new TopologyError('Select at least one non-coplanar edge', 'EMPTY_SELECTION');
  if (edges.length * (shape === 0 ? 1 : segments) > 256)
    throw new TopologyError(
      'Bevel exceeds 256 profile planes; reduce selected edges or segment count',
      'TOPOLOGY_LIMIT',
    );
  const planes = edges.flatMap((edge) => edgePlanes(topology, edge, normals, request.width, segments, shape));
  let output = topology.mesh;
  const generated: { faceId: string; edgeId: string; segment: number }[] = [];
  for (const plane of planes) {
    const beforeFaces = new Set(output.identity.faceIds);
    let clipped;
    try {
      clipped = bisectMesh(output, {
        normal: plane.normal,
        offset: plane.offset,
        keep: 'negative',
        fill: true,
        tolerance: 1e-8,
      });
    } catch (error) {
      if (error instanceof TopologyError)
        throw new TopologyError(
          'Bevel profile cannot produce a valid closed cut at this width',
          'INVALID_BEVEL_WIDTH',
          400,
          { edgeId: plane.edgeId, segment: plane.segment, cause: error.code, reason: error.message },
        );
      throw error;
    }
    const added = clipped.mesh.identity.faceIds.filter((id) => !beforeFaces.has(id));
    if (added.length !== 1)
      throw new TopologyError(
        'Bevel profile is too small to resolve or overlaps a previous cut',
        'UNRESOLVED_BEVEL_PROFILE',
        400,
        { edgeId: plane.edgeId, segment: plane.segment, addedFaces: added.length },
      );
    output = clipped.mesh;
    generated.push({ faceId: added[0], edgeId: plane.edgeId, segment: plane.segment });
  }
  const finalFaces = new Set(output.identity.faceIds);
  const missingSource = topology.mesh.identity.faceIds.filter((id) => !finalFaces.has(id));
  const missingProfile = generated.filter((profile) => !finalFaces.has(profile.faceId));
  if (missingSource.length || missingProfile.length)
    throw new TopologyError(
      'Bevel width consumes an original face or an adjacent bevel segment; reduce width',
      'BEVEL_OVERLAP',
      400,
      { consumedFaceIds: missingSource, consumedProfile: missingProfile },
    );
  const diagnostics = diagnoseMesh(output);
  if (!diagnostics.closed || !diagnostics.consistentlyOriented || diagnostics.degenerateFaces.length)
    throw new TopologyError(
      'Bevel did not produce a closed consistently oriented surface',
      'INVALID_BEVEL_RESULT',
      400,
      { diagnostics },
    );
  return {
    ...meshEditResult(topology.mesh, output),
    beveledEdges: edges.map((edge) => topology.edges[edge].id),
    profiles: generated,
    requestedSegments: segments,
    effectiveSegments: shape === 0 ? 1 : segments,
    shape,
    cornerMode: 'miter' as const,
  };
}
