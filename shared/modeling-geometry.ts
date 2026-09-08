import * as THREE from 'three';
import { geometryToMesh, meshToGeometry } from './mesh-geometry';
export { faceNormal, geometryToMesh, meshToGeometry } from './mesh-geometry';
import { evaluateModifiers } from './modifier-evaluation';
import { surfaceToMesh } from './surfaces/geometry';
import type { SceneObject, Vec3 } from './types';
import {
  ModelingError,
  type CurveData,
  type MeshData,
  type ModelingData,
  type TerrainData,
} from './modeling';

function boxMesh(dimensions: Vec3): MeshData {
  const [width, height, depth] = dimensions;
  const x = width / 2;
  const z = depth / 2;
  return {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [-x, 0, -z],
      [x, 0, -z],
      [x, height, -z],
      [-x, height, -z],
      [-x, 0, z],
      [x, 0, z],
      [x, height, z],
      [-x, height, z],
    ],
    faces: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 4, 7, 3],
      [1, 2, 6, 5],
      [3, 7, 6, 2],
      [0, 1, 5, 4],
    ],
  };
}

export function primitiveToMesh(object: Pick<SceneObject, 'type' | 'dimensions'>): MeshData {
  if (['box', 'plane', 'wall'].includes(object.type)) return boxMesh(object.dimensions);
  const [width, height, depth] = object.dimensions;
  let geometry: THREE.BufferGeometry;
  if (object.type === 'sphere') geometry = new THREE.SphereGeometry(0.5, 24, 16);
  else if (object.type === 'cylinder') geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
  else
    throw new ModelingError(`Cannot convert ${object.type}; choose a primitive or editable modeling object`);
  geometry.scale(width, height, depth);
  geometry.translate(0, height / 2, 0);
  try {
    return geometryToMesh(geometry);
  } finally {
    geometry.dispose();
  }
}

export function curveToMesh(curve: CurveData): MeshData {
  const path = new THREE.CatmullRomCurve3(
    curve.points.map((point) => new THREE.Vector3(...point)),
    curve.closed,
    'centripetal',
  );
  const frames = path.computeFrenetFrames(curve.segments, curve.closed);
  const rings = curve.closed ? curve.segments : curve.segments + 1;
  const ringSize = curve.profile === 'road' ? 4 : curve.radialSegments;
  const vertices: Vec3[] = [];
  const faces: number[][] = [];
  for (let ring = 0; ring < rings; ring++) {
    const time = ring / curve.segments;
    const point = path.getPointAt(time);
    const tangent = path.getTangentAt(time);
    let right: THREE.Vector3;
    let up: THREE.Vector3;
    if (curve.profile === 'road') {
      right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), tangent).normalize();
      if (right.lengthSq() < 0.1)
        throw new ModelingError('Road segments cannot be vertical; use a tube for vertical curves');
      right.applyAxisAngle(tangent, THREE.MathUtils.degToRad(curve.bank));
      up = new THREE.Vector3().crossVectors(tangent, right).normalize();
    } else {
      right = frames.normals[ring];
      up = frames.binormals[ring];
    }
    for (let side = 0; side < ringSize; side++) {
      let localX: number;
      let localY: number;
      if (curve.profile === 'road') {
        const offsets = [
          [-curve.width / 2, 0],
          [curve.width / 2, 0],
          [curve.width / 2, -curve.thickness],
          [-curve.width / 2, -curve.thickness],
        ];
        [localX, localY] = offsets[side];
      } else {
        const angle = (side / ringSize) * Math.PI * 2;
        localX = Math.cos(angle) * curve.radius;
        localY = Math.sin(angle) * curve.radius;
      }
      const position = point.clone().addScaledVector(right, localX).addScaledVector(up, localY);
      vertices.push(position.toArray() as Vec3);
    }
  }
  const winding = curve.profile === 'road' ? -1 : 1;
  for (let ring = 0; ring < (curve.closed ? rings : rings - 1); ring++) {
    const next = (ring + 1) % rings;
    for (let side = 0; side < ringSize; side++) {
      const following = (side + 1) % ringSize;
      const face = [
        ring * ringSize + side,
        ring * ringSize + following,
        next * ringSize + following,
        next * ringSize + side,
      ];
      faces.push(winding === 1 ? face : face.reverse());
    }
  }
  if (!curve.closed) {
    const start = Array.from({ length: ringSize }, (_, side) => side);
    const end = start.map((side) => (rings - 1) * ringSize + side);
    faces.push(winding === 1 ? start.slice().reverse() : start, winding === 1 ? end : end.slice().reverse());
  }
  return { kind: 'mesh', vertices, faces, smooth: curve.profile === 'tube' };
}

export function terrainHeight(terrain: TerrainData, x: number, z: number) {
  const column = THREE.MathUtils.clamp((x / terrain.sizeX + 0.5) * terrain.segmentsX, 0, terrain.segmentsX);
  const row = THREE.MathUtils.clamp((z / terrain.sizeZ + 0.5) * terrain.segmentsZ, 0, terrain.segmentsZ);
  const left = Math.min(terrain.segmentsX - 1, Math.floor(column));
  const top = Math.min(terrain.segmentsZ - 1, Math.floor(row));
  const horizontal = column - left;
  const vertical = row - top;
  const at = (r: number, c: number) => terrain.heights[r * (terrain.segmentsX + 1) + c];
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(at(top, left), at(top, left + 1), horizontal),
    THREE.MathUtils.lerp(at(top + 1, left), at(top + 1, left + 1), horizontal),
    vertical,
  );
}

export function terrainToMesh(terrain: TerrainData): MeshData {
  const vertices: Vec3[] = [];
  const faces: number[][] = [];
  const columns = terrain.segmentsX + 1;
  const base = Math.min(...terrain.heights) - terrain.thickness;
  for (let row = 0; row <= terrain.segmentsZ; row++) {
    for (let column = 0; column <= terrain.segmentsX; column++)
      vertices.push([
        (column / terrain.segmentsX - 0.5) * terrain.sizeX,
        terrain.heights[row * columns + column],
        (row / terrain.segmentsZ - 0.5) * terrain.sizeZ,
      ]);
  }
  for (let row = 0; row < terrain.segmentsZ; row++) {
    for (let column = 0; column < terrain.segmentsX; column++) {
      const a = row * columns + column;
      faces.push([a, a + columns, a + 1], [a + 1, a + columns, a + columns + 1]);
    }
  }
  const border: number[] = [];
  for (let column = 0; column < terrain.segmentsX; column++) border.push(column);
  for (let row = 0; row < terrain.segmentsZ; row++) border.push(row * columns + terrain.segmentsX);
  for (let column = terrain.segmentsX; column > 0; column--)
    border.push(terrain.segmentsZ * columns + column);
  for (let row = terrain.segmentsZ; row > 0; row--) border.push(row * columns);
  const bottom = border.map((index) => {
    const position = vertices[index];
    vertices.push([position[0], base, position[2]]);
    return vertices.length - 1;
  });
  for (let index = 0; index < border.length; index++) {
    const next = (index + 1) % border.length;
    faces.push([border[index], border[next], bottom[next], bottom[index]]);
  }
  const center = vertices.length;
  vertices.push([0, base, 0]);
  for (let index = 0; index < bottom.length; index++)
    faces.push([center, bottom[index], bottom[(index + 1) % bottom.length]]);
  return { kind: 'mesh', vertices, faces, smooth: true };
}

export function modelingToMesh(modeling: ModelingData): MeshData {
  if (modeling.kind === 'stack') return evaluateModifiers(modelingToMesh(modeling.base), modeling.modifiers);
  if (modeling.kind === 'mesh') return structuredClone(modeling);
  if (modeling.kind === 'surface') return surfaceToMesh(modeling);
  return modeling.kind === 'curve' ? curveToMesh(modeling) : terrainToMesh(modeling);
}

export function buildModelGeometry(modeling: ModelingData) {
  const evaluated = modelingToMesh(modeling);
  const geometry = meshToGeometry(evaluated);
  geometry.userData.smooth = evaluated.smooth;
  return geometry;
}

export function meshVolume(mesh: MeshData) {
  const geometry = meshToGeometry(mesh);
  const position = geometry.getAttribute('position');
  const indices = geometry.getIndex()!;
  let volume = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let triangle = 0; triangle < indices.count; triangle += 3) {
    a.fromBufferAttribute(position, indices.getX(triangle));
    b.fromBufferAttribute(position, indices.getX(triangle + 1));
    c.fromBufferAttribute(position, indices.getX(triangle + 2));
    volume += a.dot(b.cross(c)) / 6;
  }
  geometry.dispose();
  return volume;
}
