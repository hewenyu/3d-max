import type { MeshData } from '../modeling';
import type { AdvancedModifier } from './schema';
import { curveArray } from './curve-array';
import { deformMesh } from './deform';
import { solidifyMesh } from './solidify';
import { subdividePolygons } from './subdivision';

export function evaluateAdvancedModifier(mesh: MeshData, modifier: AdvancedModifier): MeshData {
  switch (modifier.type) {
    case 'solidify':
      return solidifyMesh(mesh, modifier);
    case 'bend':
    case 'twist':
      return deformMesh(mesh, modifier);
    case 'curve-array':
      return curveArray(mesh, modifier);
    case 'catmull-clark':
      return subdividePolygons(mesh, modifier);
  }
}
