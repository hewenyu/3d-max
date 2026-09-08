import { Vector3 } from 'three';
import { normalOffset } from '../normal-offset';
import { DomainError } from '../domain-error';
import type { MeshData } from '../modeling';
import type { Vec3 } from '../types';
import type { AdvancedModifier } from './schema';
import { assertMeshCapacity, orientedManifold, polygonUnitNormal } from './mesh-utils';
import { assertSurfaceMeshValid } from '../surfaces/mesh';

export function solidifyMesh(
  mesh: MeshData,
  modifier: Extract<AdvancedModifier, { type: 'solidify' }>,
): MeshData {
  const edges = orientedManifold(mesh);
  const boundary = [...edges.values()].filter((uses) => uses.length === 1).map(([use]) => use);
  assertMeshCapacity(
    mesh.vertices.length * 2,
    mesh.faces.reduce((n, face) => n + face.length - 2, 0) * 2 + boundary.length * 2,
  );
  const normals = mesh.faces.map((face) => polygonUnitNormal(mesh, face));
  const incident = mesh.vertices.map(() => [] as Vector3[]);
  mesh.faces.forEach((face, index) => face.forEach((vertex) => incident[vertex].push(normals[index])));
  const miters = incident.map((planes) => {
    const direction = normalOffset(planes, 1e-9);
    if (
      !Number.isFinite(direction.lengthSq()) ||
      direction.length() > 100 ||
      planes.some((normal) => normal.dot(direction) < 0.1)
    )
      throw new DomainError('Thickness is undefined at a folded or opposing surface', 'MODELING_COLLAPSE');
    return direction;
  });
  const outer = (modifier.thickness * (1 + modifier.offset)) / 2;
  const inner = (modifier.thickness * (modifier.offset - 1)) / 2;
  const layer = (distance: number): Vec3[] =>
    mesh.vertices.map((vertex, index) =>
      new Vector3(...vertex).addScaledVector(miters[index], distance).toArray(),
    );
  const vertices = [...layer(outer), ...layer(inner)];
  const count = mesh.vertices.length;
  const faces = [
    ...mesh.faces.map((face) => [...face]),
    ...mesh.faces.map((face) => face.map((index) => index + count).reverse()),
    ...boundary.map(({ from, to }) => [to, from, from + count, to + count]),
  ];
  const result: MeshData = { kind: 'mesh', vertices, faces, smooth: mesh.smooth };
  for (let index = 0; index < mesh.faces.length; index++) {
    if (
      polygonUnitNormal(result, result.faces[index]).dot(normals[index]) <= 0 ||
      polygonUnitNormal(result, result.faces[index + mesh.faces.length]).dot(normals[index]) >= 0
    )
      throw new DomainError('Thickness collapses or reverses a surface face', 'MODELING_COLLAPSE');
  }
  orientedManifold(result);
  assertSurfaceMeshValid(result, { closed: true, selfIntersections: true });
  return result;
}
