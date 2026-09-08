import type { Command, Project, SceneObject } from './types';
import { topologySchemas } from './topology-schema';
import { transformModelComponents } from './modeling-transforms';
import {
  bisectMesh,
  bridgeBoundaries,
  dissolveEdges,
  dissolveVertices,
  ensureMeshIdentity,
  extrudeFaces,
  fillBoundaries,
  insetFaces,
  loopCut,
  repairMesh,
  slideComponents,
  weldVertices,
  TopologyError,
  type MeshEditResult,
  type TopologyMesh,
  bevelMesh,
  splitFaces,
  deleteComponents,
  mergeVertices,
} from './topology';

export function applyTopologyCommand(
  project: Project,
  object: SceneObject,
  input: TopologyMesh,
  command: Command,
): MeshEditResult {
  const mesh = ensureMeshIdentity(input);
  const p = command.payload;
  switch (command.type) {
    case 'topology.transform':
      return transformModelComponents(project, object, mesh, topologySchemas[command.type].parse(p));
    case 'topology.extrude':
      return extrudeFaces(mesh, topologySchemas[command.type].parse(p));
    case 'topology.inset':
      return insetFaces(mesh, topologySchemas[command.type].parse(p));
    case 'topology.bevel':
      return bevelMesh(mesh, topologySchemas[command.type].parse(p));
    case 'topology.split':
      return splitFaces(mesh, topologySchemas[command.type].parse(p));
    case 'topology.delete':
      return deleteComponents(mesh, topologySchemas[command.type].parse(p));
    case 'topology.merge':
      return mergeVertices(mesh, topologySchemas[command.type].parse(p));
    case 'topology.fill':
      return fillBoundaries(mesh, topologySchemas[command.type].parse(p));
    case 'topology.bridge':
      return bridgeBoundaries(mesh, topologySchemas[command.type].parse(p));
    case 'topology.weld':
      return weldVertices(mesh, topologySchemas[command.type].parse(p));
    case 'topology.dissolve': {
      const request = topologySchemas[command.type].parse(p);
      if (request.selection.kind === 'face') throw new TopologyError('Dissolve requires edges or vertices');
      return request.selection.kind === 'edge'
        ? dissolveEdges(mesh, request)
        : dissolveVertices(mesh, request);
    }
    case 'topology.loop-cut':
      return loopCut(mesh, topologySchemas[command.type].parse(p));
    case 'topology.slide':
      return slideComponents(mesh, topologySchemas[command.type].parse(p));
    case 'topology.bisect':
      return bisectMesh(mesh, topologySchemas[command.type].parse(p));
    case 'topology.repair':
      return repairMesh(mesh, topologySchemas[command.type].parse(p));
    default:
      throw new TopologyError(`Unknown topology command: ${command.type}`);
  }
}
