import createOpenSubdiv from '@nasedkinpv/opensubdiv-wasm';
import { DomainError } from '../domain-error';
import type { MeshData } from '../modeling';
import type { Vec3 } from '../types';
import type { AdvancedModifier } from './schema';
import { assertMeshCapacity, orientedManifold } from './mesh-utils';

const wasmUrl = new URL(
  '../../node_modules/@nasedkinpv/opensubdiv-wasm/dist/opensubdiv.wasm',
  import.meta.url,
);
const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
const binary = isNode ? await (await import('node:fs/promises')).readFile(wasmUrl) : undefined;
const subdivision = await createOpenSubdiv({
  ...(binary ? { wasmBinary: binary } : { locateFile: () => wasmUrl.href }),
  print: () => {},
  printErr: () => {},
});

export function subdividePolygons(
  mesh: MeshData,
  modifier: Extract<AdvancedModifier, { type: 'catmull-clark' }>,
): MeshData {
  orientedManifold(mesh);
  const quads = mesh.faces.reduce((n, face) => n + face.length, 0) * 4 ** (modifier.iterations - 1);
  assertMeshCapacity(quads + mesh.vertices.length + 2, quads * 2);
  const instance = new subdivision.SubdivisionMesh();
  try {
    const ok = instance.initFromPolygons(
      new Float32Array(mesh.vertices.flat()),
      new Int32Array(mesh.faces.flat()),
      new Int32Array(mesh.faces.map((face) => face.length)),
      modifier.iterations,
      modifier.boundary === 'corners' ? subdivision.BOUNDARY_EDGE_AND_CORNER : subdivision.BOUNDARY_EDGE_ONLY,
    );
    if (!ok) throw new DomainError('Subdivision kernel rejected the control mesh', 'MODELING_TOPOLOGY');
    assertMeshCapacity(instance.getVertexCount(), instance.getTriangleCount());
    const positions = instance.getPositions();
    const indices = instance.getIndices();
    const vertices: Vec3[] = [];
    for (let index = 0; index < positions.length; index += 3)
      vertices.push([positions[index], positions[index + 1], positions[index + 2]]);
    const faces: number[][] = [];
    for (let index = 0; index < indices.length; index += 6) {
      const [a, b, c, d, e, f] = indices.subarray(index, index + 6);
      if (a !== d || c !== e || new Set([a, b, c, f]).size !== 4)
        throw new DomainError('Subdivision kernel returned an unsupported face layout', 'MODELING_TOPOLOGY');
      faces.push([a, b, c, f]);
    }
    return { kind: 'mesh', smooth: true, vertices, faces };
  } finally {
    instance.delete();
  }
}
