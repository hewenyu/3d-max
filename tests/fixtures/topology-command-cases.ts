import {
  buildTopology,
  stableEdgeId,
  type ComponentKind,
  type ComponentSelection,
  type TopologyMesh,
} from '../../shared/topology';
import type { Command, Project } from '../../shared/types';
import type { McpCommandCase } from './mcp-command-cases';

export function topologyCube(): TopologyMesh {
  return {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
    faces: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [3, 7, 6, 2],
      [0, 4, 7, 3],
      [1, 2, 6, 5],
    ],
  };
}
export function topologyGrid(columns = 2, rows = 1): TopologyMesh {
  const vertices: TopologyMesh['vertices'] = [];
  const faces: number[][] = [];
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) vertices.push([x, y, 0]);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const start = y * (columns + 1) + x;
      faces.push([start, start + 1, start + columns + 2, start + columns + 1]);
    }
  return { kind: 'mesh', smooth: false, vertices, faces };
}
export function topologySource(project: Project): TopologyMesh {
  const mesh = project.objects.find((object) => object.id === 'target')?.modeling;
  if (mesh?.kind !== 'mesh') throw new Error('Topology fixture requires an editable source mesh');
  return mesh;
}
export function topologySelection(
  project: Project,
  kind: ComponentKind,
  indices?: number[],
): ComponentSelection {
  const topology = buildTopology(topologySource(project));
  const ids =
    kind === 'vertex'
      ? topology.mesh.identity.vertexIds
      : kind === 'face'
        ? topology.mesh.identity.faceIds
        : topology.edges.map((edge) => edge.id);
  return {
    namespace: topology.mesh.identity.namespace,
    kind,
    ids: indices ? indices.map((index) => ids[index]) : ids,
  };
}
function edges(project: Project, pairs: [number, number][]): ComponentSelection {
  const topology = buildTopology(topologySource(project));
  return {
    namespace: topology.mesh.identity.namespace,
    kind: 'edge',
    ids: pairs.map(([left, right]) =>
      stableEdgeId(topology.mesh.identity.vertexIds[left], topology.mesh.identity.vertexIds[right]),
    ),
  };
}
function boundary(project: Project): ComponentSelection {
  const topology = buildTopology(topologySource(project));
  return {
    namespace: topology.mesh.identity.namespace,
    kind: 'edge',
    ids: topology.edges.filter((edge) => edge.faces.length === 1).map((edge) => edge.id),
  };
}
const meshSetup = (mesh: TopologyMesh): Command[] => [
  {
    type: 'mesh.set',
    payload: { id: 'target', mesh: { vertices: mesh.vertices, faces: mesh.faces, smooth: mesh.smooth } },
  },
];

export function topologyCommandCases(): McpCommandCase[] {
  const cube = topologyCube();
  const open = topologyCube();
  open.faces.splice(3, 1);
  const ends = topologyCube();
  ends.faces = [ends.faces[0], ends.faces[1]];
  const repair = topologyCube();
  repair.faces[0].reverse();
  repair.vertices.push([9, 9, 9]);
  const weld: TopologyMesh = {
    kind: 'mesh',
    smooth: false,
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
    faces: [
      [0, 1, 2],
      [3, 4, 5],
    ],
  };
  const item = (
    type: string,
    mesh: TopologyMesh,
    payload: (project: Project) => Record<string, unknown>,
  ): McpCommandCase => ({
    type,
    setup: meshSetup(mesh),
    payload: (project) => ({ id: 'target', ...payload(project) }),
  });
  return [
    item('topology.transform', cube, (project) => ({
      selection: topologySelection(project, 'face', [3]),
      translation: [0, 0.2, 0],
    })),
    item('topology.extrude', cube, (project) => ({
      selection: topologySelection(project, 'face', [3]),
      distance: 0.5,
      mode: 'region',
    })),
    item('topology.inset', cube, (project) => ({
      selection: topologySelection(project, 'face', [3]),
      thickness: 0.2,
      depth: -0.1,
    })),
    item('topology.fill', open, (project) => ({ selection: boundary(project) })),
    item('topology.bridge', ends, (project) => ({ selection: boundary(project), segments: 2 })),
    item('topology.weld', weld, (project) => ({
      selection: topologySelection(project, 'vertex'),
      tolerance: 1e-5,
    })),
    item('topology.dissolve', topologyGrid(), (project) => ({ selection: edges(project, [[1, 4]]) })),
    item('topology.loop-cut', cube, (project) => ({ selection: edges(project, [[0, 1]]), cuts: 2 })),
    item('topology.slide', topologyGrid(3, 2), (project) => ({
      selection: edges(project, [
        [4, 5],
        [5, 6],
        [6, 7],
      ]),
      amount: 0.3,
    })),
    item('topology.bisect', cube, () => ({ normal: [1, 0, 0], offset: 0, keep: 'positive', fill: true })),
    item('topology.repair', repair, () => ({ removeLooseVertices: true, orientFaces: 'outward' })),
    item('topology.bevel', cube, (project) => ({
      selection: edges(project, [[2, 6]]),
      width: 0.2,
      segments: 3,
    })),
    item('topology.split', topologyGrid(), (project) => ({
      selection: topologySelection(project, 'face', [0]),
      mode: 'boundary',
    })),
    item('topology.delete', topologyGrid(), (project) => ({
      selection: topologySelection(project, 'vertex', [0]),
      incidentFaces: 'delete',
      removeLooseVertices: true,
    })),
    item('topology.merge', topologyGrid(), (project) => ({
      selection: topologySelection(project, 'vertex', [0, 1]),
      target: 'center',
      collapseFaces: 'reject',
    })),
    {
      type: 'surface.set',
      payload: {
        id: 'target',
        surface: {
          kind: 'surface',
          operation: 'sweep',
          segments: 4,
          profileSegments: 2,
          path: { closed: false, points: [{ position: [0, 0, 0] }, { position: [0, 0, 4] }] },
          profile: {
            outer: {
              closed: true,
              points: [
                [-1, -1],
                [1, -1],
                [1, 1],
                [-1, 1],
              ].map((position) => ({ position })),
            },
            holes: [],
          },
        },
      },
    },
  ];
}
