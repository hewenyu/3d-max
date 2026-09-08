import { MathUtils, Vector3 } from 'three';
import { DomainError } from '../domain-error';
import type { MeshData } from '../modeling';
import type { Vec3 } from '../types';
import type { AdvancedModifier } from './schema';

export function deformMesh(
  mesh: MeshData,
  modifier: Extract<AdvancedModifier, { type: 'bend' | 'twist' }>,
): MeshData {
  const axis = ['x', 'y', 'z'].indexOf(modifier.axis);
  const span = modifier.to - modifier.from;
  if (span <= 1e-6) throw new DomainError('Deformation end must be greater than start', 'MODELING_RANGE');
  if (modifier.type === 'bend' && modifier.direction === modifier.axis)
    throw new DomainError('Bend direction must differ from its length axis', 'MODELING_RANGE');
  if (Math.abs(modifier.angle) < 1e-8) return structuredClone(mesh);
  const radians = MathUtils.degToRad(modifier.angle);
  const axisVector = new Vector3().setComponent(axis, 1);
  const vertices = mesh.vertices.map((source): Vec3 => {
    const position = new Vector3(...source);
    const distance = source[axis];
    const along = MathUtils.clamp(distance, modifier.from, modifier.to);
    const angle = (radians * (along - modifier.from)) / span;
    if (modifier.type === 'twist') return position.applyAxisAngle(axisVector, angle).toArray();
    const direction = ['x', 'y', 'z'].indexOf(modifier.direction);
    const radius = span / radians;
    if (1 - source[direction] / radius <= 1e-6)
      throw new DomainError('Bend radius would fold the source across its center', 'MODELING_COLLAPSE');
    const radial = radius - source[direction];
    position.setComponent(
      axis,
      modifier.from + radial * Math.sin(angle) + (distance - along) * Math.cos(angle),
    );
    position.setComponent(
      direction,
      radius - radial * Math.cos(angle) + (distance - along) * Math.sin(angle),
    );
    return position.toArray();
  });
  return { ...structuredClone(mesh), vertices };
}
