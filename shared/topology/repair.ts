import { Vector3 } from 'three';
import { buildTopology, meshFaceNormal } from './adjacency';
import { MeshEditor } from './editor';
import { resolveSelection, selectionVertices } from './selection';
import { TopologyError, type ComponentSelection, type MeshTopology, type TopologyMesh } from './types';

export interface MeshRepair {
  selection?: ComponentSelection;
  removeDegenerateFaces?: boolean;
  removeDuplicateFaces?: boolean;
  removeLooseVertices?: boolean;
  orientFaces?: 'consistent' | 'outward';
}

function selectedFaces(topology: MeshTopology, selection?: ComponentSelection): Set<number> {
  if (!selection) return new Set(topology.mesh.faces.map((_, index) => index));
  const indices = resolveSelection(topology, selection);
  return new Set(
    selection.kind === 'face'
      ? indices
      : selection.kind === 'edge'
        ? indices.flatMap((index) => topology.edges[index].faces)
        : indices.flatMap((index) => topology.vertexFaces[index]),
  );
}

function signature(face: number[]): string {
  const smallest = face.indexOf(Math.min(...face));
  const forward = [...face.slice(smallest), ...face.slice(0, smallest)];
  const reverse = [forward[0], ...forward.slice(1).reverse()];
  return (forward[1] < reverse[1] ? forward : reverse).join(',');
}

function orient(editor: MeshEditor, selectedIds: Set<string>, mode: 'consistent' | 'outward'): string[] {
  const topology = buildTopology(editor.mesh);
  const selected = new Set(
    editor.mesh.identity.faceIds.flatMap((id, index) => (selectedIds.has(id) ? [index] : [])),
  );
  const unvisited = new Set(selected);
  const signs = new Map<number, number>();
  while (unvisited.size) {
    const seed = unvisited.values().next().value!;
    const component = [seed];
    const relative = new Map([[seed, 1]]);
    unvisited.delete(seed);
    let fixedSign: number | undefined;
    let closed = true;
    for (let cursor = 0; cursor < component.length; cursor++) {
      const face = component[cursor];
      for (const edgeIndex of topology.faceEdges[face]) {
        const edge = topology.edges[edgeIndex];
        if (edge.faces.length > 2)
          throw new TopologyError(
            'Orientation repair cannot orient a non-manifold edge',
            'NON_MANIFOLD_SELECTION',
            400,
            { edgeId: edge.id },
          );
        if (edge.faces.length < 2) {
          closed = false;
          continue;
        }
        const other = edge.faces.find((index) => index !== face)!;
        const relation = edge.directions[0] === edge.directions[1] ? -1 : 1;
        const expected = relative.get(face)! * relation;
        if (!selected.has(other)) {
          closed = false;
          if (fixedSign !== undefined && fixedSign !== expected)
            throw new TopologyError(
              'Selected faces cannot match all unselected boundary orientations',
              'INCONSISTENT_BOUNDARY',
            );
          fixedSign = expected;
        } else if (relative.has(other)) {
          if (relative.get(other) !== expected)
            throw new TopologyError('Selected mesh component is not orientable', 'NON_ORIENTABLE_SURFACE');
        } else {
          relative.set(other, expected);
          component.push(other);
          unvisited.delete(other);
        }
      }
    }
    let global = fixedSign ?? 1;
    if (mode === 'outward') {
      if (!closed)
        throw new TopologyError(
          'Outward orientation requires complete closed mesh components',
          'OPEN_COMPONENT',
        );
      let volume = 0;
      for (const faceIndex of component) {
        const face = editor.mesh.faces[faceIndex];
        for (let index = 1; index < face.length - 1; index++) {
          const a = new Vector3(...editor.mesh.vertices[face[0]]);
          const b = new Vector3(...editor.mesh.vertices[face[index]]);
          const c = new Vector3(...editor.mesh.vertices[face[index + 1]]);
          volume += (relative.get(faceIndex)! * a.dot(b.cross(c))) / 6;
        }
      }
      if (Math.abs(volume) < 1e-10)
        throw new TopologyError('Closed component has no reliable signed volume', 'DEGENERATE_VOLUME');
      global = volume > 0 ? 1 : -1;
    }
    for (const [face, sign] of relative) signs.set(face, sign * global);
  }
  const flipped: string[] = [];
  for (const [face, sign] of signs)
    if (sign === -1) {
      editor.mesh.faces[face].reverse();
      flipped.push(editor.mesh.identity.faceIds[face]);
    }
  return flipped;
}

export function repairMesh(input: TopologyMesh, request: MeshRepair) {
  if (
    !request.removeDegenerateFaces &&
    !request.removeDuplicateFaces &&
    !request.removeLooseVertices &&
    !request.orientFaces
  )
    throw new TopologyError('Choose at least one explicit mesh repair action');
  const topology = buildTopology(input);
  const selected = selectedFaces(topology, request.selection);
  const selectedIds = new Set([...selected].map((index) => topology.mesh.identity.faceIds[index]));
  const vertexIds = new Set(
    (request.selection
      ? selectionVertices(topology, request.selection)
      : input.vertices.map((_, index) => index)
    ).map((index) => topology.mesh.identity.vertexIds[index]),
  );
  const editor = new MeshEditor(topology.mesh);
  const removed = new Set<number>();
  if (request.removeDegenerateFaces)
    for (const index of selected) {
      const face = input.faces[index];
      if (
        meshFaceNormal(input, face).length() < 1e-8 ||
        face.some(
          (vertex, corner) =>
            new Vector3(...input.vertices[vertex]).distanceTo(
              new Vector3(...input.vertices[face[(corner + 1) % face.length]]),
            ) < 1e-10,
        )
      )
        removed.add(index);
    }
  if (request.removeDuplicateFaces) {
    const groups = new Map<string, number[]>();
    input.faces.forEach((face, index) => {
      if (removed.has(index)) return;
      const key = signature(face);
      const group = groups.get(key) ?? [];
      group.push(index);
      groups.set(key, group);
    });
    for (const group of groups.values())
      if (group.length > 1) {
        const kept = group.find((face) => !selected.has(face)) ?? group[0];
        for (const face of group)
          if (face !== kept && selected.has(face)) {
            removed.add(face);
            editor.map('face', editor.mesh.identity.faceIds[face], [editor.mesh.identity.faceIds[kept]]);
          }
      }
  }
  editor.removeFaces(removed);
  const flippedFaces = request.orientFaces ? orient(editor, selectedIds, request.orientFaces) : [];
  if (request.removeLooseVertices) {
    const used = new Set(editor.mesh.faces.flat());
    editor.removeVertices(
      editor.mesh.vertices.flatMap((_, index) =>
        !used.has(index) && vertexIds.has(editor.mesh.identity.vertexIds[index]) ? [index] : [],
      ),
    );
  }
  return { ...editor.finish(), flippedFaces };
}
