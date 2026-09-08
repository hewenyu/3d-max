import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { buildTopology } from './adjacency';
import { MeshEditor } from './editor';
import { selectionVertices } from './selection';
import {
  TOPOLOGY_LIMITS,
  TopologyError,
  type ComponentSelection,
  type MeshTopology,
  type TopologyMesh,
  type TopologyVector,
} from './types';

export interface ComponentTransform {
  matrix?: number[];
  selection: ComponentSelection;
  translation?: TopologyVector;
  rotation?: TopologyVector;
  scale?: TopologyVector;
  pivot?: TopologyVector;
  orientation?: TopologyVector;
  proportional?: { radius: number; falloff: 'linear' | 'smooth' | 'sharp' | 'constant'; connected?: boolean };
}

class DistanceQueue {
  private values: [number, number][] = [];
  push(value: [number, number]) {
    let index = this.values.push(value) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.values[parent][1] <= value[1]) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }
  pop(): [number, number] | undefined {
    if (!this.values.length) return;
    const result = this.values[0];
    const tail = this.values.pop()!;
    if (this.values.length) {
      let index = 0;
      while (2 * index + 1 < this.values.length) {
        let child = 2 * index + 1;
        if (child + 1 < this.values.length && this.values[child + 1][1] < this.values[child][1]) child++;
        if (tail[1] <= this.values[child][1]) break;
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = tail;
    }
    return result;
  }
}

function connectedDistances(topology: MeshTopology, seeds: number[], radius: number): number[] {
  const distances = topology.mesh.vertices.map(() => Infinity);
  const queue = new DistanceQueue();
  seeds.forEach((index) => {
    distances[index] = 0;
    queue.push([index, 0]);
  });
  let next: [number, number] | undefined;
  while ((next = queue.pop())) {
    const [index, distance] = next;
    if (distance !== distances[index]) continue;
    for (const edgeIndex of topology.vertexEdges[index]) {
      const edge = topology.edges[edgeIndex];
      const neighbor = edge.vertices[0] === index ? edge.vertices[1] : edge.vertices[0];
      const value =
        distance +
        new Vector3(...topology.mesh.vertices[index]).distanceTo(
          new Vector3(...topology.mesh.vertices[neighbor]),
        );
      if (value <= radius && value < distances[neighbor]) {
        distances[neighbor] = value;
        queue.push([neighbor, value]);
      }
    }
  }
  return distances;
}

export function componentTransformWeights(
  topology: MeshTopology,
  request: ComponentTransform,
): { vertices: number[]; weights: number[] } {
  const vertices = selectionVertices(topology, request.selection);
  if (!vertices.length) throw new TopologyError('Select at least one component', 'EMPTY_SELECTION');
  const selected = new Set(vertices);
  if (!request.proportional)
    return { vertices, weights: topology.mesh.vertices.map((_, index) => (selected.has(index) ? 1 : 0)) };
  const { radius, falloff, connected } = request.proportional;
  if (!Number.isFinite(radius) || radius <= 0 || radius > 100000)
    throw new TopologyError('Proportional radius must be greater than zero and at most 100000 meters');
  if (!['linear', 'smooth', 'sharp', 'constant'].includes(falloff))
    throw new TopologyError('Unknown proportional falloff');
  let distances: number[];
  if (connected) distances = connectedDistances(topology, vertices, radius);
  else {
    if (vertices.length * topology.mesh.vertices.length > TOPOLOGY_LIMITS.diagnosticComparisons)
      throw new TopologyError(
        'Proportional distance search exceeds capacity; use connected distance or a smaller selection',
        'TOPOLOGY_LIMIT',
      );
    const seeds = vertices.map((index) => new Vector3(...topology.mesh.vertices[index]));
    distances = topology.mesh.vertices.map((vertex) => {
      const point = new Vector3(...vertex);
      let nearest = Infinity;
      for (const seed of seeds) nearest = Math.min(nearest, point.distanceTo(seed));
      return nearest;
    });
  }
  return {
    vertices,
    weights: distances.map((distance) => {
      if (distance >= radius) return 0;
      const value = 1 - distance / radius;
      return falloff === 'constant'
        ? 1
        : falloff === 'sharp'
          ? value ** 2
          : falloff === 'smooth'
            ? value * value * (3 - 2 * value)
            : value;
    }),
  };
}

export function transformComponents(input: TopologyMesh, request: ComponentTransform) {
  let affine: Matrix4 | undefined;
  if (request.matrix) {
    if (request.matrix.length !== 16 || request.matrix.some((value) => !Number.isFinite(value)))
      throw new TopologyError('An affine transform requires 16 finite column-major values');
    affine = new Matrix4().fromArray(request.matrix);
    if (
      [3, 7, 11].some((index) => Math.abs(request.matrix![index]) > 1e-12) ||
      Math.abs(request.matrix[15] - 1) > 1e-12 ||
      Math.abs(affine.determinant()) < 1e-12
    )
      throw new TopologyError('Transform matrix must be nonsingular and affine');
    if (request.translation || request.rotation || request.scale || request.orientation || request.pivot)
      throw new TopologyError('A matrix transform cannot be combined with component transform parameters');
  }
  for (const [field, value] of Object.entries(request))
    if (
      ['translation', 'rotation', 'scale', 'pivot', 'orientation'].includes(field) &&
      value !== undefined &&
      (!Array.isArray(value) ||
        value.length !== 3 ||
        value.some((number) => typeof number !== 'number' || !Number.isFinite(number)))
    )
      throw new TopologyError(`Invalid transform ${field}`);
  if (request.scale?.some((value) => Math.abs(value) < 1e-8))
    throw new TopologyError('Scale components cannot collapse geometry');
  const topology = buildTopology(input);
  const { vertices, weights } = componentTransformWeights(topology, request);
  const editor = new MeshEditor(topology.mesh);
  const center = new Vector3();
  if (request.pivot) center.set(...request.pivot);
  else
    (vertices.forEach((index) => center.add(new Vector3(...input.vertices[index]))),
      center.multiplyScalar(1 / vertices.length));
  const radians = (rotation: TopologyVector = [0, 0, 0]) =>
    rotation.map((value) => (value * Math.PI) / 180) as TopologyVector;
  const orientation = new Quaternion().setFromEuler(new Euler(...radians(request.orientation), 'XYZ'));
  const inverse = orientation.clone().invert();
  const rotation = new Quaternion().setFromEuler(new Euler(...radians(request.rotation), 'XYZ'));
  const scale = new Vector3(...(request.scale ?? [1, 1, 1]));
  const translation = new Vector3(...(request.translation ?? [0, 0, 0])).applyQuaternion(orientation);
  editor.mesh.vertices = input.vertices.map((vertex, index) => {
    if (!weights[index]) return [...vertex];
    const original = new Vector3(...vertex);
    const transformed = affine
      ? original.clone().applyMatrix4(affine)
      : original
          .clone()
          .sub(center)
          .applyQuaternion(inverse)
          .multiply(scale)
          .applyQuaternion(rotation)
          .applyQuaternion(orientation)
          .add(center)
          .add(translation);
    return original.lerp(transformed, weights[index]).toArray() as TopologyVector;
  });
  const result = editor.finish();
  return {
    ...result,
    weights: weights.flatMap((weight, index) =>
      weight > 0 ? [{ id: result.mesh.identity.vertexIds[index], weight }] : [],
    ),
    pivot: center.toArray() as TopologyVector,
  };
}
