import type { MeshModifier } from '../../../shared/modifier-schema';
import type { Vec3 } from '../../../shared/types';

export const modifierNames: Record<MeshModifier['type'], string> = {
  mirror: '镜像',
  array: '阵列',
  subdivision: 'Loop 细分',
  solidify: '实体化',
  bend: '弯曲',
  twist: '扭转',
  'catmull-clark': '多边形细分',
  'curve-array': '曲线阵列',
  boolean: '布尔',
  bevel: '倒角',
};

export function defaultModifier(
  type: MeshModifier['type'],
  dimensions: Vec3,
  operandId?: string,
): MeshModifier {
  const common = { id: `modifier-${crypto.randomUUID()}`, enabled: true };
  const width = Math.max(dimensions[0], 0.1);
  const height = Math.max(dimensions[1], 0.1);
  switch (type) {
    case 'boolean':
      if (!operandId) throw new Error('选择布尔操作数');
      return { ...common, type, operandId, operation: 'subtract' };
    case 'bevel':
      return {
        ...common,
        type,
        width: Math.max(0.00001, Math.min(...dimensions) * 0.05),
        segments: 3,
        shape: 1,
      };
    case 'array':
      return { ...common, type, count: 2, offset: [width * 1.5, 0, 0] };
    case 'mirror':
      return { ...common, type, axis: 'x', offset: width * 0.75, keepOriginal: true };
    case 'subdivision':
      return { ...common, type, iterations: 1, preserveEdges: false, flatOnly: false };
    case 'solidify':
      return { ...common, type, thickness: 0.1, offset: 0 };
    case 'bend':
      return { ...common, type, axis: 'y', direction: 'x', angle: 30, from: 0, to: height };
    case 'twist':
      return { ...common, type, axis: 'y', angle: 45, from: 0, to: height };
    case 'catmull-clark':
      return { ...common, type, iterations: 1, boundary: 'corners' };
    case 'curve-array':
      return {
        ...common,
        type,
        points: [
          [0, 0, 0],
          [width * 4, 0, 0],
          [width * 8, 0, width * 2],
        ],
        closed: false,
        count: 3,
        axis: 'x',
        orient: true,
      };
  }
}
