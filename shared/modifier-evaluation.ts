import { LoopSubdivision } from 'three-subdivide';
import type { MeshModifier } from './modifier-schema';
import { ModelingError, meshDataSchema, type MeshData } from './modeling';
import { geometryToMesh, meshToGeometry } from './modeling-geometry';
import type { Vec3 } from './types';

function capacity(mesh: MeshData, multiplier: number) {
  const triangles = mesh.faces.reduce((sum, face) => sum + face.length - 2, 0);
  if (mesh.vertices.length * multiplier > 100000 || triangles * multiplier > 100000)
    throw new ModelingError(
      'Modifier result exceeds 100000 vertices or triangles; reduce copies, iterations or source detail',
      'MODELING_LIMIT',
    );
}

export function evaluateModifiers(source: MeshData, modifiers: MeshModifier[]): MeshData {
  let mesh = structuredClone(source);
  for (const modifier of modifiers) {
    if (!modifier.enabled) continue;
    if (modifier.type === 'subdivision') {
      capacity(mesh, 4 ** modifier.iterations);
      const geometry = meshToGeometry(mesh);
      try {
        const result = LoopSubdivision.modify(geometry, modifier.iterations, {
          split: false,
          preserveEdges: modifier.preserveEdges,
          flatOnly: modifier.flatOnly,
          maxTriangles: 100000,
        });
        try {
          mesh = { ...geometryToMesh(result), smooth: !modifier.flatOnly };
        } finally {
          result.dispose();
        }
      } finally {
        geometry.dispose();
      }
      continue;
    }
    if (modifier.type === 'array') {
      if (modifier.offset.every((value) => value === 0))
        throw new ModelingError('Array offset must be nonzero');
      capacity(mesh, modifier.count);
      const sourceMesh = mesh;
      mesh = { kind: 'mesh', vertices: [], faces: [], smooth: sourceMesh.smooth };
      for (let copy = 0; copy < modifier.count; copy++) {
        const start = mesh.vertices.length;
        mesh.vertices.push(
          ...sourceMesh.vertices.map(
            (vertex) => vertex.map((value, axis) => value + modifier.offset[axis] * copy) as Vec3,
          ),
        );
        mesh.faces.push(...sourceMesh.faces.map((face) => face.map((index) => index + start)));
      }
    } else {
      capacity(mesh, modifier.keepOriginal ? 2 : 1);
      const axis = ['x', 'y', 'z'].indexOf(modifier.axis);
      const vertices = mesh.vertices.map(
        (vertex) =>
          vertex.map((value, index) => (index === axis ? 2 * modifier.offset - value : value)) as Vec3,
      );
      const start = modifier.keepOriginal ? mesh.vertices.length : 0;
      const faces = mesh.faces.map((face) => [...face].reverse().map((index) => index + start));
      mesh = {
        kind: 'mesh',
        smooth: mesh.smooth,
        vertices: modifier.keepOriginal ? [...mesh.vertices, ...vertices] : vertices,
        faces: modifier.keepOriginal ? [...mesh.faces, ...faces] : faces,
      };
    }
    mesh = meshDataSchema.parse(mesh);
  }
  return mesh;
}
