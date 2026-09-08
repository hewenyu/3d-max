import * as THREE from 'three';
import { meshToGeometry } from '../../shared/mesh-geometry';
import { buildTopology, meshFaceNormal } from '../../shared/topology/adjacency';
import type { MeshTopology, TopologyMesh, TopologyVector } from '../../shared/topology/types';

export interface ComponentSourceData {
  topology: MeshTopology;
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
  polygonIndices: Uint32Array;
  faceRanges: Uint32Array;
  wire: Float32Array;
  boundaries: Float32Array;
  normals: Float32Array;
  bounds: { min: TopologyVector; max: TopologyVector; center: TopologyVector; radius: number };
}

export function prepareComponentSource(mesh: TopologyMesh): ComponentSourceData {
  const topology = buildTopology(mesh);
  const geometry = meshToGeometry(topology.mesh);
  try {
    const positions = geometry.getAttribute('position').array as Float32Array;
    const indices = geometry.getIndex()!.array as Uint16Array | Uint32Array;
    const polygonIndices = new Uint32Array(geometry.userData.polygonIndices as number[]);
    const faceRanges = new Uint32Array(mesh.faces.length + 1);
    let triangle = 0;
    for (let face = 0; face < mesh.faces.length; face++) {
      faceRanges[face] = triangle;
      while (polygonIndices[triangle] === face) triangle++;
    }
    faceRanges[mesh.faces.length] = triangle;
    const edgePositions = (edges: MeshTopology['edges']) => {
      const output = new Float32Array(edges.length * 6);
      edges.forEach((edge, index) => {
        output.set(mesh.vertices[edge.vertices[0]], index * 6);
        output.set(mesh.vertices[edge.vertices[1]], index * 6 + 3);
      });
      return output;
    };
    const normals = new Float32Array(mesh.faces.length * 6);
    const size = geometry.boundingBox!.getSize(new THREE.Vector3()).length() * 0.05;
    mesh.faces.forEach((face, index) => {
      const center = new THREE.Vector3();
      for (const vertex of face) center.add(new THREE.Vector3(...mesh.vertices[vertex]));
      center.multiplyScalar(1 / face.length).toArray(normals, index * 6);
      center.addScaledVector(meshFaceNormal(mesh, face).normalize(), size).toArray(normals, index * 6 + 3);
    });
    return {
      topology,
      positions,
      indices,
      polygonIndices,
      faceRanges,
      wire: edgePositions(topology.edges),
      boundaries: edgePositions(topology.edges.filter((edge) => edge.faces.length !== 2)),
      normals,
      bounds: {
        min: geometry.boundingBox!.min.toArray(),
        max: geometry.boundingBox!.max.toArray(),
        center: geometry.boundingSphere!.center.toArray(),
        radius: geometry.boundingSphere!.radius,
      },
    };
  } finally {
    geometry.dispose();
  }
}

export function componentSourceTransfers(data: ComponentSourceData): ArrayBuffer[] {
  return [
    data.positions,
    data.indices,
    data.polygonIndices,
    data.faceRanges,
    data.wire,
    data.boundaries,
    data.normals,
  ].map((array) => array.buffer as ArrayBuffer);
}
