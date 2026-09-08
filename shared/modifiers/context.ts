import type { Matrix4 } from 'three';
import type { MeshData } from '../modeling';

export interface ModifierEvaluationContext {
  objectId: string;
  resolveOperand: (operandId: string) => { mesh: MeshData; operandToTarget: Matrix4 };
}
