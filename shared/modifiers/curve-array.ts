import { CatmullRomCurve3, LineCurve3, Quaternion, Vector3 } from 'three';
import { DomainError } from '../domain-error';
import type { MeshData } from '../modeling';
import type { Vec3 } from '../types';
import type { AdvancedModifier } from './schema';
import { assertMeshCapacity } from './mesh-utils';

export function curveArray(
  mesh: MeshData,
  modifier: Extract<AdvancedModifier, { type: 'curve-array' }>,
): MeshData {
  const points = modifier.points.map((point) => new Vector3(...point));
  if (modifier.closed && points.length < 3)
    throw new DomainError('A closed array path requires at least three points', 'MODELING_PATH');
  for (let index = 1; index < points.length + Number(modifier.closed); index++) {
    if (points[index % points.length].distanceToSquared(points[index - 1]) < 1e-12)
      throw new DomainError('Array path contains duplicate adjacent endpoints', 'MODELING_PATH');
  }
  assertMeshCapacity(
    mesh.vertices.length * modifier.count,
    mesh.faces.reduce((n, face) => n + face.length - 2, 0) * modifier.count,
  );
  const path =
    points.length === 2
      ? new LineCurve3(points[0], points[1])
      : new CatmullRomCurve3(points, modifier.closed, 'centripetal');
  path.arcLengthDivisions = Math.max(200, points.length * 32);
  if (path.getLength() < 1e-6) throw new DomainError('Array path has no length', 'MODELING_PATH');
  const axis = new Vector3().setComponent(['x', 'y', 'z'].indexOf(modifier.axis), 1);
  const vertices: Vec3[] = [];
  const faces: number[][] = [];
  for (let copy = 0; copy < modifier.count; copy++) {
    const time = copy / (modifier.closed ? modifier.count : modifier.count - 1);
    const position = path.getPointAt(time);
    const tangent = path.getTangentAt(time);
    if (tangent.lengthSq() < 0.5) throw new DomainError('Array path tangent is undefined', 'MODELING_PATH');
    const rotation = modifier.orient ? new Quaternion().setFromUnitVectors(axis, tangent) : new Quaternion();
    const start = vertices.length;
    for (const vertex of mesh.vertices)
      vertices.push(new Vector3(...vertex).applyQuaternion(rotation).add(position).toArray());
    for (const face of mesh.faces) faces.push(face.map((index) => start + index));
  }
  return { kind: 'mesh', smooth: mesh.smooth, vertices, faces };
}
