import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Project, SceneObject, Vec3 } from './types';
import type { ComponentTransformInput } from './topology-schema';
import { buildTopology, meshFaceNormal } from './topology/adjacency';
import { resolveSelection, selectionVertices } from './topology/selection';
import { transformComponents } from './topology/transform';
import { TopologyError, type IdentifiedMesh } from './topology/types';

export function modelingWorldMatrix(
  project: Pick<Project, 'objects'>,
  object: SceneObject,
  seen = new Set<string>(),
): Matrix4 {
  if (seen.has(object.id)) throw new TopologyError('Object hierarchy contains a cycle');
  seen.add(object.id);
  if (object.attachment)
    throw new TopologyError(
      'Detach bone attachments before editing geometry in world space',
      'ATTACHED_OBJECT',
    );
  const matrix = new Matrix4().compose(
    new Vector3(...object.position),
    new Quaternion().setFromEuler(
      new Euler(...(object.rotation.map((value) => (value * Math.PI) / 180) as Vec3), 'XYZ'),
    ),
    new Vector3(...object.scale),
  );
  if (!object.parentId) return matrix;
  const parent = project.objects.find((candidate) => candidate.id === object.parentId);
  if (!parent) throw new TopologyError('Parent object is unavailable', 'NOT_FOUND', 404);
  return modelingWorldMatrix(project, parent, seen).multiply(matrix);
}

export function transformModelComponents(
  project: Project,
  object: SceneObject,
  mesh: IdentifiedMesh,
  request: ComponentTransformInput,
) {
  if (request.matrix) {
    if (
      (request.space && request.space !== 'local') ||
      request.snap ||
      request.pivotMode ||
      request.pivot ||
      request.translation ||
      request.rotation ||
      request.scale
    )
      throw new TopologyError(
        'An affine matrix is an explicit local transform and cannot be combined with other transform settings',
      );
    return {
      ...transformComponents(mesh, {
        selection: request.selection,
        matrix: request.matrix,
        proportional: request.proportional,
      }),
      space: 'local' as const,
    };
  }
  const topology = buildTopology(mesh);
  const indices = selectionVertices(topology, request.selection);
  if (!indices.length) throw new TopologyError('Select at least one component', 'EMPTY_SELECTION');
  let frame = new Matrix4();
  if (request.space === 'world') frame = modelingWorldMatrix(project, object);
  if (request.space === 'normal') {
    const faces =
      request.selection.kind === 'face'
        ? resolveSelection(topology, request.selection)
        : [...new Set(indices.flatMap((index) => topology.vertexFaces[index]))];
    const normal = faces.reduce(
      (sum, face) => sum.add(meshFaceNormal(mesh, mesh.faces[face])),
      new Vector3(),
    );
    if (normal.length() < 1e-8)
      throw new TopologyError('Selection has no unambiguous average normal', 'UNDEFINED_NORMAL');
    frame.makeRotationFromQuaternion(
      new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal.normalize()).invert(),
    );
  }
  if (Math.abs(frame.determinant()) < 1e-12) throw new TopologyError('Object transform is singular');
  const framed = {
    ...mesh,
    vertices: mesh.vertices.map((point) => new Vector3(...point).applyMatrix4(frame).toArray() as Vec3),
  };
  const selectedPoints = indices.map((index) => new Vector3(...framed.vertices[index]));
  let pivot: Vec3 | undefined;
  switch (request.pivotMode ?? (request.pivot ? 'custom' : 'median')) {
    case 'origin':
      pivot = new Vector3().applyMatrix4(frame).toArray() as Vec3;
      break;
    case 'bounds':
      pivot = new Box3().setFromPoints(selectedPoints).getCenter(new Vector3()).toArray() as Vec3;
      break;
    case 'active': {
      const active = selectionVertices(topology, {
        ...request.selection,
        ids: request.selection.ids.slice(-1),
      });
      pivot = active
        .reduce((sum, index) => sum.add(new Vector3(...framed.vertices[index])), new Vector3())
        .multiplyScalar(1 / active.length)
        .toArray() as Vec3;
      break;
    }
    case 'custom':
      if (!request.pivot) throw new TopologyError('Custom pivot requires coordinates');
      pivot = request.pivot;
      break;
  }
  const quantize = (value: Vec3 | undefined, step: number | undefined, identity = 0): Vec3 | undefined =>
    value && step
      ? (value.map((number) => identity + Math.round((number - identity) / step) * step) as Vec3)
      : value;
  const result = transformComponents(framed, {
    selection: request.selection,
    translation: quantize(request.translation, request.snap?.translation),
    rotation: quantize(request.rotation, request.snap?.rotation),
    scale: quantize(request.scale, request.snap?.scale, 1),
    proportional: request.proportional,
    pivot,
  });
  const inverse = frame.clone().invert();
  result.mesh.vertices = result.mesh.vertices.map(
    (point) => new Vector3(...point).applyMatrix4(inverse).toArray() as Vec3,
  );
  return { ...result, space: request.space ?? 'local' };
}
