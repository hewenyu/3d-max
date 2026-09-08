import { Vector3 } from 'three';
import { buildTopology, meshFaceNormal } from './adjacency';
import { MeshEditor } from './editor';
import { stableEdgeId } from './identity';
import { faceSelection } from './regions';
import { resolveSelection, selectionVertices } from './selection';
import { TopologyError, type ComponentSelection, type TopologyMesh, type TopologyVector } from './types';

export function splitFaces(
  input: TopologyMesh,
  request: { selection: ComponentSelection; mode?: 'boundary' | 'individual' },
) {
  const topology = buildTopology(input);
  const faces = faceSelection(topology, request.selection);
  const editor = new MeshEditor(topology.mesh);
  const groups = request.mode === 'individual' ? faces.map((face) => [face]) : [faces];
  const aliases = new Map<number, number[]>();
  const edgeAliases = new Map<string, Set<string>>();
  for (const group of groups) {
    const selected = new Set(group);
    const vertices = [...new Set(group.flatMap((face) => input.faces[face]))];
    const copies = new Map<number, number>();
    for (const vertex of vertices) {
      if (topology.vertexFaces[vertex].every((face) => selected.has(face))) continue;
      const created = editor.addVertex(input.vertices[vertex]);
      copies.set(vertex, created);
      aliases.set(vertex, [...(aliases.get(vertex) ?? []), created]);
    }
    for (const face of group) {
      editor.replaceFace(
        face,
        input.faces[face].map((vertex) => copies.get(vertex) ?? vertex),
      );
      for (const edgeIndex of topology.faceEdges[face]) {
        const edge = topology.edges[edgeIndex];
        const [left, right] = edge.vertices.map((vertex) => copies.get(vertex) ?? vertex);
        const id = stableEdgeId(editor.mesh.identity.vertexIds[left], editor.mesh.identity.vertexIds[right]);
        const replacements = edgeAliases.get(edge.id) ?? new Set<string>();
        replacements.add(id);
        edgeAliases.set(edge.id, replacements);
      }
    }
  }
  const used = new Set(editor.mesh.faces.flat());
  for (const [vertex, copies] of aliases)
    editor.map('vertex', editor.before.identity.vertexIds[vertex], [
      ...(used.has(vertex) ? [editor.before.identity.vertexIds[vertex]] : []),
      ...copies.map((index) => editor.mesh.identity.vertexIds[index]),
    ]);
  editor.removeVertices([...aliases.keys()].filter((vertex) => !used.has(vertex)));
  const finalEdges = buildTopology(editor.mesh).edgeById;
  for (const [old, replacements] of edgeAliases)
    editor.map('edge', old, [...(finalEdges.has(old) ? [old] : []), ...replacements]);
  return editor.finish();
}

export function deleteComponents(
  input: TopologyMesh,
  request: {
    selection: ComponentSelection;
    incidentFaces?: 'reject' | 'delete';
    removeLooseVertices?: boolean;
  },
) {
  const topology = buildTopology(input);
  const indices = resolveSelection(topology, request.selection);
  if (!indices.length) throw new TopologyError('Select components to delete', 'EMPTY_SELECTION');
  if (request.selection.kind !== 'face' && !request.incidentFaces)
    throw new TopologyError(
      'Vertex and edge deletion require an explicit incidentFaces policy',
      'INCIDENT_FACE_POLICY_REQUIRED',
    );
  const faces =
    request.selection.kind === 'face'
      ? indices
      : [
          ...new Set(
            request.selection.kind === 'edge'
              ? indices.flatMap((edge) => topology.edges[edge].faces)
              : indices.flatMap((vertex) => topology.vertexFaces[vertex]),
          ),
        ];
  if (request.selection.kind !== 'face' && request.incidentFaces === 'reject' && faces.length)
    throw new TopologyError(
      'Selected components are referenced by faces; incidentFaces=delete must be explicit',
      'INCIDENT_FACES',
      409,
      { faceIds: faces.map((face) => topology.mesh.identity.faceIds[face]) },
    );
  if (faces.length === input.faces.length)
    throw new TopologyError(
      'Deletion would remove every face; delete the scene object instead',
      'EMPTY_MESH',
    );
  const editor = new MeshEditor(topology.mesh);
  const candidates = new Set(faces.flatMap((face) => input.faces[face]));
  editor.removeFaces(faces);
  const used = new Set(editor.mesh.faces.flat());
  const removed = new Set(request.selection.kind === 'vertex' ? indices : []);
  if (request.removeLooseVertices)
    for (const vertex of candidates) if (!used.has(vertex)) removed.add(vertex);
  editor.removeVertices(removed);
  return editor.finish();
}

export interface VertexMerge {
  selection: ComponentSelection;
  target: 'first' | 'center' | 'cursor';
  position?: TopologyVector;
  collapseFaces?: 'remove' | 'reject';
}

export function mergeVertices(input: TopologyMesh, request: VertexMerge) {
  const topology = buildTopology(input);
  const vertices = selectionVertices(topology, request.selection);
  if (vertices.length < 2)
    throw new TopologyError('Merge requires at least two selected vertices', 'EMPTY_SELECTION');
  if (!['first', 'center', 'cursor'].includes(request.target))
    throw new TopologyError('Unknown merge target');
  if (
    request.target === 'cursor' &&
    (!request.position ||
      request.position.length !== 3 ||
      request.position.some((value) => !Number.isFinite(value) || Math.abs(value) > 100000))
  )
    throw new TopologyError('Cursor merge requires an explicit local-space position');
  if (request.target !== 'cursor' && request.position !== undefined)
    throw new TopologyError('Only cursor merge accepts an explicit position');
  const kept = vertices[0];
  const selected = new Set(vertices);
  const editor = new MeshEditor(topology.mesh);
  editor.mesh.vertices[kept] =
    request.target === 'first'
      ? [...input.vertices[kept]]
      : request.target === 'cursor'
        ? [...request.position!]
        : (vertices
            .reduce((point, vertex) => point.add(new Vector3(...input.vertices[vertex])), new Vector3())
            .multiplyScalar(1 / vertices.length)
            .toArray() as TopologyVector);
  for (const vertex of vertices)
    editor.map('vertex', editor.mesh.identity.vertexIds[vertex], [editor.mesh.identity.vertexIds[kept]]);
  const removed: number[] = [];
  editor.mesh.faces = editor.mesh.faces.map((face, index) => {
    const mapped = face.map((vertex) => (selected.has(vertex) ? kept : vertex));
    const compressed = mapped.filter(
      (vertex, corner) => vertex !== mapped[(corner + mapped.length - 1) % mapped.length],
    );
    const collapsed =
      compressed.length < 3 ||
      new Set(compressed).size !== compressed.length ||
      meshFaceNormal(editor.mesh, compressed).length() < 1e-8;
    if (collapsed) {
      if ((request.collapseFaces ?? 'remove') === 'reject')
        throw new TopologyError('Merge would collapse an incident face', 'COLLAPSED_FACE', 409, {
          faceId: editor.mesh.identity.faceIds[index],
        });
      removed.push(index);
    }
    return compressed;
  });
  if (removed.length === input.faces.length)
    throw new TopologyError('Merge would remove every face', 'EMPTY_MESH');
  for (const edge of topology.edges) {
    const [left, right] = edge.vertices.map((vertex) => (selected.has(vertex) ? kept : vertex));
    editor.map(
      'edge',
      edge.id,
      left === right
        ? []
        : [stableEdgeId(editor.mesh.identity.vertexIds[left], editor.mesh.identity.vertexIds[right])],
    );
  }
  editor.removeFaces(removed);
  editor.removeVertices(vertices.slice(1));
  const finalEdges = buildTopology(editor.mesh).edgeById;
  for (const [old, replacements] of Object.entries(editor.replacements.edge ?? {}))
    editor.map(
      'edge',
      old,
      replacements.filter((id) => finalEdges.has(id)),
    );
  return {
    ...editor.finish(),
    mergedInto: topology.mesh.identity.vertexIds[kept],
    mergedIds: vertices.map((vertex) => topology.mesh.identity.vertexIds[vertex]),
  };
}
