import * as THREE from 'three';
import { ADDITION, Brush, Evaluator, HalfEdgeMap, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { DomainError } from '../domain-error';
import { geometryToMesh, meshToGeometry } from '../mesh-geometry';
import { meshDataSchema, type MeshData } from '../modeling';
import { duplicateVertexGroups } from '../topology/diagnostics';

export type MeshBooleanOperation = 'union' | 'subtract' | 'intersect';

export function weldBooleanOutput(mesh: MeshData): MeshData {
  const tolerance = 0.000001;
  const groups = duplicateVertexGroups(mesh, tolerance);
  if (!groups.length) return mesh;
  const aliases = mesh.vertices.map((_, index) => index);
  for (const group of groups) {
    const first = group[0];
    const kept = mesh.vertices[first];
    for (const index of group) {
      const point = mesh.vertices[index];
      if (Math.hypot(point[0] - kept[0], point[1] - kept[1], point[2] - kept[2]) > tolerance)
        throw Object.assign(
          new DomainError(
            'Boolean output has a chain of near vertices exceeding the conversion tolerance',
            'MODELING_PRECISION',
          ),
          { details: { tolerance, vertex: index } },
        );
      aliases[index] = first;
    }
  }
  const indices = new Map<number, number>();
  const vertices = mesh.vertices.filter((_, index) => {
    if (aliases[index] !== index) return false;
    indices.set(index, indices.size);
    return true;
  });
  const normal = (points: MeshData['vertices'], polygon: number[]) => {
    const [a, b, c] = polygon.map((index) => new THREE.Vector3(...points[index]));
    return b.sub(a).cross(c.sub(a));
  };
  const faces = mesh.faces.map((face, faceIndex) => {
    const mapped = face.map((index) => indices.get(aliases[index])!);
    if (
      new Set(mapped).size !== mapped.length ||
      normal(vertices, mapped).dot(normal(mesh.vertices, face)) <= 0
    )
      throw Object.assign(
        new DomainError(
          'Boolean output welding would collapse or reverse a face at the conversion tolerance',
          'MODELING_PRECISION',
        ),
        { details: { tolerance, face: faceIndex } },
      );
    return mapped;
  });
  return { ...mesh, vertices, faces };
}

export function assertBooleanSolid(mesh: MeshData) {
  const edges = new Map<string, { count: number; direction: number }>();
  for (const face of mesh.faces) {
    for (let index = 0; index < face.length; index++) {
      const a = face[index];
      const b = face[(index + 1) % face.length];
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const edge = edges.get(key) ?? { count: 0, direction: 0 };
      edge.count++;
      edge.direction += a < b ? 1 : -1;
      edges.set(key, edge);
    }
  }
  const allEdges = [...edges.values()];
  if (allEdges.some((edge) => edge.count > 2 || (edge.count === 2 && edge.direction !== 0)))
    throw new DomainError(
      'Boolean operands must be closed, consistently oriented solids',
      'MODELING_TOPOLOGY',
    );
  if (allEdges.every((edge) => edge.count === 2)) return;
  const geometry = meshToGeometry(mesh);
  try {
    // CSG splits may leave matching geometric subedges with different vertex indices.
    const bounds = geometry.boundingBox!;
    const center = bounds.getCenter(new THREE.Vector3());
    const dimensions = bounds.getSize(new THREE.Vector3());
    const scale = 1 / Math.max(dimensions.x, dimensions.y, dimensions.z);
    if (!Number.isFinite(scale))
      throw new DomainError('Boolean operand has no spatial extent', 'MODELING_COLLAPSE');
    geometry.translate(-center.x, -center.y, -center.z);
    geometry.scale(scale, scale, scale);
    const connectivity = Object.assign(new HalfEdgeMap(), { matchDisjointEdges: true, unmatchedEdges: -1 });
    connectivity.updateFrom(geometry);
    if (connectivity.unmatchedEdges !== 0)
      throw new DomainError(
        'Boolean operands must be closed, consistently oriented solids',
        'MODELING_TOPOLOGY',
      );
  } finally {
    geometry.dispose();
  }
}

export function meshBoolean(
  target: MeshData,
  operand: MeshData,
  operandToTarget: THREE.Matrix4,
  operation: MeshBooleanOperation,
): MeshData {
  if (!['union', 'subtract', 'intersect'].includes(operation))
    throw new DomainError('Unknown Boolean operation', 'INVALID_BOOLEAN');
  const leftMesh = meshDataSchema.parse(target);
  const rightMesh = meshDataSchema.parse(operand);
  if (
    [leftMesh, rightMesh].some(
      (mesh) => mesh.faces.reduce((count, face) => count + face.length - 2, 0) > 30000,
    )
  )
    throw new DomainError('Boolean operands are limited to 30000 triangles each', 'MODELING_LIMIT');
  assertBooleanSolid(leftMesh);
  assertBooleanSolid(rightMesh);
  const determinant = operandToTarget.determinant();
  if (
    operandToTarget.elements.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(determinant) ||
    Math.abs(determinant) < 1e-10
  )
    throw new DomainError('Boolean operand transform is singular or non-finite', 'MODELING_TRANSFORM');
  const leftGeometry = meshToGeometry(leftMesh);
  const rightGeometry = meshToGeometry(rightMesh).applyMatrix4(operandToTarget);
  if (determinant < 0) {
    const indices = rightGeometry.getIndex()!;
    for (let index = 0; index < indices.count; index += 3) {
      const a = indices.getX(index);
      indices.setX(index, indices.getX(index + 2));
      indices.setX(index + 2, a);
    }
    rightGeometry.computeVertexNormals();
  }
  const material = new THREE.MeshBasicMaterial();
  const left = new Brush(leftGeometry, material);
  const right = new Brush(rightGeometry, material);
  left.updateMatrixWorld(true);
  right.updateMatrixWorld(true);
  const evaluator = new Evaluator();
  Object.assign(evaluator, { useCDTClipping: true });
  evaluator.attributes = ['position', 'normal'];
  evaluator.useGroups = false;
  let result: Brush | undefined;
  try {
    result = evaluator.evaluate(
      left,
      right,
      operation === 'union' ? ADDITION : operation === 'subtract' ? SUBTRACTION : INTERSECTION,
    );
    // Quantized mergeVertices buckets alone miss sub-micron pairs across bucket boundaries.
    const mesh = weldBooleanOutput(geometryToMesh(result.geometry));
    assertBooleanSolid(mesh);
    return mesh;
  } finally {
    left.disposeCacheData();
    right.disposeCacheData();
    result?.disposeCacheData();
    leftGeometry.dispose();
    rightGeometry.dispose();
    result?.geometry.dispose();
    material.dispose();
  }
}
