import { buildTopology } from './adjacency';
import {
  TopologyError,
  type ComponentKind,
  type ComponentSelection,
  type MeshTopology,
  type TopologyMesh,
} from './types';

export type SelectionOperation = 'replace' | 'connected' | 'loop' | 'ring' | 'grow' | 'shrink' | 'invert';
export interface SelectionRequest extends ComponentSelection {
  operation: SelectionOperation;
  steps?: number;
}
export interface SelectionResult extends ComponentSelection {
  indices: number[];
  stopped: { id: string; reason: 'boundary' | 'non-quad' | 'non-manifold' | 'pole' }[];
}

export function componentIds(topology: MeshTopology, kind: ComponentKind): string[] {
  return kind === 'vertex'
    ? topology.mesh.identity.vertexIds
    : kind === 'face'
      ? topology.mesh.identity.faceIds
      : topology.edges.map((edge) => edge.id);
}

export function resolveSelection(topology: MeshTopology, selection: ComponentSelection): number[] {
  if (selection.namespace !== topology.mesh.identity.namespace)
    throw new TopologyError('Selection belongs to a different mesh generation', 'STALE_SELECTION', 409);
  const lookup =
    selection.kind === 'vertex'
      ? topology.vertexById
      : selection.kind === 'face'
        ? topology.faceById
        : topology.edgeById;
  const missing = selection.ids.filter((id) => !lookup.has(id));
  if (missing.length)
    throw new TopologyError('Selection contains deleted or unknown components', 'COMPONENT_NOT_FOUND', 404, {
      ids: missing,
    });
  return [...new Set(selection.ids.map((id) => lookup.get(id)!))];
}

export function selectionVertices(topology: MeshTopology, selection: ComponentSelection): number[] {
  const indices = resolveSelection(topology, selection);
  return [
    ...new Set(
      selection.kind === 'vertex'
        ? indices
        : selection.kind === 'edge'
          ? indices.flatMap((index) => topology.edges[index].vertices)
          : indices.flatMap((index) => topology.mesh.faces[index]),
    ),
  ];
}

function adjacent(topology: MeshTopology, kind: ComponentKind, index: number): number[] {
  if (kind === 'vertex')
    return topology.vertexEdges[index].map((edgeIndex) => {
      const [left, right] = topology.edges[edgeIndex].vertices;
      return left === index ? right : left;
    });
  if (kind === 'edge')
    return [
      ...new Set(topology.edges[index].vertices.flatMap((vertex) => topology.vertexEdges[vertex])),
    ].filter((neighbor) => neighbor !== index);
  return [
    ...new Set(topology.faceEdges[index].flatMap((edgeIndex) => topology.edges[edgeIndex].faces)),
  ].filter((neighbor) => neighbor !== index);
}

function onBoundary(topology: MeshTopology, kind: ComponentKind, index: number): boolean {
  const edges =
    kind === 'edge' ? [index] : kind === 'vertex' ? topology.vertexEdges[index] : topology.faceEdges[index];
  return edges.some((edge) => topology.edges[edge].faces.length < 2);
}

function traceEdges(topology: MeshTopology, indices: number[], operation: 'loop' | 'ring') {
  const selected = new Set(indices);
  const queue = [...indices];
  const stopped = new Map<string, SelectionResult['stopped'][number]>();
  const stop = (edgeIndex: number, reason: SelectionResult['stopped'][number]['reason']) => {
    const id = topology.edges[edgeIndex].id;
    stopped.set(`${id}:${reason}`, { id, reason });
  };
  const add = (edgeIndex: number) => {
    if (!selected.has(edgeIndex)) {
      selected.add(edgeIndex);
      queue.push(edgeIndex);
    }
  };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = queue[cursor];
    const edge = topology.edges[index];
    if (edge.faces.length > 2) {
      stop(index, 'non-manifold');
      continue;
    }
    if (operation === 'ring') {
      if (edge.faces.length < 2) stop(index, 'boundary');
      for (const face of edge.faces) {
        const edges = topology.faceEdges[face];
        if (edges.length !== 4) {
          stop(index, 'non-quad');
          continue;
        }
        add(edges[(edges.indexOf(index) + 2) % 4]);
      }
    } else {
      for (const vertex of edge.vertices) {
        const incident = topology.vertexEdges[vertex];
        if (incident.some((candidate) => topology.edges[candidate].faces.length > 2)) {
          stop(index, 'non-manifold');
          continue;
        }
        if (topology.vertexFaces[vertex].some((face) => topology.mesh.faces[face].length !== 4)) {
          stop(index, 'non-quad');
          continue;
        }
        const candidates = incident.filter(
          (candidate) =>
            candidate !== index && !topology.edges[candidate].faces.some((face) => edge.faces.includes(face)),
        );
        if (candidates.length === 1 && incident.length <= 4) add(candidates[0]);
        else stop(index, onBoundary(topology, 'vertex', vertex) ? 'boundary' : 'pole');
      }
    }
  }
  return { selected, stopped: [...stopped.values()] };
}

export function selectComponents(mesh: TopologyMesh, request: SelectionRequest): SelectionResult {
  return selectTopologyComponents(buildTopology(mesh), request);
}

export function selectTopologyComponents(topology: MeshTopology, request: SelectionRequest): SelectionResult {
  const indices = resolveSelection(topology, request);
  const all = componentIds(topology, request.kind);
  let selected = new Set(indices);
  let stopped: SelectionResult['stopped'] = [];
  if (request.operation === 'loop' || request.operation === 'ring') {
    if (request.kind !== 'edge') throw new TopologyError('Loop and ring selection require edge mode');
    ({ selected, stopped } = traceEdges(topology, indices, request.operation));
  } else if (request.operation === 'invert') {
    selected = new Set(all.map((_, index) => index).filter((index) => !selected.has(index)));
  } else if (request.operation === 'connected') {
    const queue = [...indices];
    for (let cursor = 0; cursor < queue.length; cursor++)
      for (const neighbor of adjacent(topology, request.kind, queue[cursor]))
        if (!selected.has(neighbor)) {
          selected.add(neighbor);
          queue.push(neighbor);
        }
  } else if (request.operation === 'grow' || request.operation === 'shrink') {
    const steps = request.steps ?? 1;
    if (!Number.isInteger(steps) || steps < 1 || steps > 100)
      throw new TopologyError('Selection steps must be an integer between 1 and 100');
    for (let step = 0; step < steps; step++) {
      if (request.operation === 'grow')
        selected = new Set([
          ...selected,
          ...[...selected].flatMap((index) => adjacent(topology, request.kind, index)),
        ]);
      else
        selected = new Set(
          [...selected].filter(
            (index) =>
              !onBoundary(topology, request.kind, index) &&
              adjacent(topology, request.kind, index).every((neighbor) => selected.has(neighbor)),
          ),
        );
    }
  } else if (request.operation !== 'replace') {
    throw new TopologyError('Unknown component selection operation');
  }
  const sorted = [...selected].sort((left, right) => left - right);
  return {
    namespace: topology.mesh.identity.namespace,
    kind: request.kind,
    ids: sorted.map((index) => all[index]),
    indices: sorted,
    stopped,
  };
}
