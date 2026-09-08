import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ModelingError, polygonNormal, meshDataSchema, type MeshData } from './modeling';
import type { Vec3 } from './types';

export function faceNormal(vertices: Vec3[], face: number[]): THREE.Vector3 {
  const normal = new THREE.Vector3(...polygonNormal(vertices, face));
  if (normal.lengthSq() < 1e-16) throw new ModelingError('Face vertices are collinear or have zero area');
  return normal.normalize();
}

export function meshToGeometry(mesh: MeshData): THREE.BufferGeometry {
  const indices: number[] = [];
  const polygonIndices: number[] = [];
  mesh.faces.forEach((face, faceIndex) => {
    const normal = faceNormal(mesh.vertices, face);
    const absolute = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
    const omitted = absolute.indexOf(Math.max(...absolute));
    const axes = [0, 1, 2].filter((axis) => axis !== omitted);
    const polygon = face.map(
      (index) => new THREE.Vector2(mesh.vertices[index][axes[0]], mesh.vertices[index][axes[1]]),
    );
    const triangles = THREE.ShapeUtils.triangulateShape(polygon, []);
    if (triangles.length !== face.length - 2)
      throw new ModelingError('Face cannot be triangulated; use a simple non-self-intersecting polygon');
    for (const triangle of triangles) {
      const [a, b, c] = triangle.map((index) => face[index]);
      const cross = new THREE.Vector3()
        .subVectors(new THREE.Vector3(...mesh.vertices[b]), new THREE.Vector3(...mesh.vertices[a]))
        .cross(
          new THREE.Vector3().subVectors(
            new THREE.Vector3(...mesh.vertices[c]),
            new THREE.Vector3(...mesh.vertices[a]),
          ),
        );
      if (cross.dot(normal) >= 0) indices.push(a, b, c);
      else indices.push(a, c, b);
      polygonIndices.push(faceIndex);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.vertices.flat(), 3));
  geometry.setIndex(indices);
  geometry.userData.polygonIndices = polygonIndices;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function geometryToMesh(source: THREE.BufferGeometry): MeshData {
  const stripped = source.clone();
  for (const name of Object.keys(stripped.attributes))
    if (name !== 'position') stripped.deleteAttribute(name);
  const geometry = mergeVertices(stripped, 0.000001);
  stripped.dispose();
  try {
    const positions = geometry.getAttribute('position');
    const vertices: Vec3[] = Array.from({ length: positions.count }, (_, index) => [
      positions.getX(index),
      positions.getY(index),
      positions.getZ(index),
    ]);
    const index = geometry.getIndex();
    const allIndices = index ? Array.from(index.array) : vertices.map((_, vertex) => vertex);
    const indices = allIndices.slice(
      source.drawRange.start,
      Number.isFinite(source.drawRange.count) ? source.drawRange.start + source.drawRange.count : undefined,
    );
    const faces: number[][] = [];
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const face = indices.slice(triangle, triangle + 3);
      if (new Set(face).size < 3) continue;
      const cross = new THREE.Vector3(...vertices[face[1]])
        .sub(new THREE.Vector3(...vertices[face[0]]))
        .cross(new THREE.Vector3(...vertices[face[2]]).sub(new THREE.Vector3(...vertices[face[0]])));
      if (cross.lengthSq() > 1e-16) faces.push(face);
    }
    if (!faces.length) throw new ModelingError('The operation produced an empty mesh');
    return meshDataSchema.parse({ kind: 'mesh', vertices, faces, smooth: false });
  } finally {
    geometry.dispose();
  }
}
