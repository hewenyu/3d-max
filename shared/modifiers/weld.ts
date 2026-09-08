import { DomainError } from '../domain-error';
import type { MeshData } from '../modeling';
import type { Vec3 } from '../types';
import { orientedManifold } from './mesh-utils';

export function weldMirroredMesh(mesh: MeshData, threshold: number): MeshData {
  if (threshold === 0) return mesh;
  const vertices: Vec3[] = [];
  const buckets = new Map<string, number[]>();
  let comparisons = 0;
  const remap = mesh.vertices.map((position) => {
    const cell = position.map((value) => Math.floor(value / threshold));
    let found = -1;
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          for (const index of buckets.get(`${cell[0] + x}:${cell[1] + y}:${cell[2] + z}`) ?? []) {
            if (++comparisons > 3000000)
              throw new DomainError('Welding exceeds the candidate comparison limit', 'MODELING_LIMIT');
            if (Math.hypot(...position.map((value, axis) => value - vertices[index][axis])) <= threshold)
              found = found < 0 ? index : Math.min(found, index);
          }
        }
    if (found >= 0) return found;
    const index = vertices.length;
    vertices.push([...position]);
    const key = cell.join(':');
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
    return index;
  });
  const groups = new Map<string, number[][]>();
  for (const sourceFace of mesh.faces) {
    const face = sourceFace.map((index) => remap[index]);
    if (new Set(face).size !== face.length)
      throw new DomainError('Weld threshold collapses an edge; reduce the threshold', 'MODELING_COLLAPSE');
    const key = [...face].sort((a, b) => a - b).join(':');
    const group = groups.get(key) ?? [];
    group.push(face);
    groups.set(key, group);
  }
  const faces: number[][] = [];
  for (const group of groups.values()) {
    if (group.length === 1) faces.push(group[0]);
    else {
      const [left, right] = group;
      const start = right.indexOf(left[0]);
      const opposed =
        group.length === 2 &&
        left.every((vertex, index) => vertex === right[(start - index + right.length) % right.length]);
      if (!opposed)
        throw new DomainError('Mirrored surfaces overlap with inconsistent faces', 'MODELING_TOPOLOGY');
    }
  }
  if (!faces.length) throw new DomainError('Mirror welding removed the entire surface', 'MODELING_COLLAPSE');
  const result: MeshData = { kind: 'mesh', vertices, faces, smooth: mesh.smooth };
  orientedManifold(result);
  return result;
}
