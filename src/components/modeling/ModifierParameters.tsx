import type { MeshModifier } from '../../../shared/modifier-schema';
import { Field, NumberInput, VectorInput } from '../Controls';
import { CurveArrayParameters } from './CurveArrayParameters';
import { ModelingNumberInput } from './ModelingNumberInput';
import type { SceneObject } from '../../../shared/types';

type Axis = 'x' | 'y' | 'z';

export function ModifierAxis({
  label,
  name,
  value,
  exclude,
  onChange,
}: {
  label: string;
  name: string;
  value: Axis;
  exclude?: Axis;
  onChange: (axis: Axis) => void;
}) {
  return (
    <Field label={label}>
      <select aria-label={name} value={value} onChange={(event) => onChange(event.target.value as Axis)}>
        {(['x', 'y', 'z'] as const)
          .filter((axis) => axis !== exclude)
          .map((axis) => (
            <option key={axis} value={axis}>
              {axis.toUpperCase()}
            </option>
          ))}
      </select>
    </Field>
  );
}

export function ModifierParameters({
  modifier,
  index,
  onChange,
  operands,
}: {
  modifier: MeshModifier;
  index: number;
  onChange: (modifier: MeshModifier) => void;
  operands: SceneObject[];
}) {
  const prefix = `修改器 ${index + 1}`;
  switch (modifier.type) {
    case 'boolean':
      return (
        <>
          <Field label="运算">
            <select
              aria-label={`${prefix} 布尔运算`}
              value={modifier.operation}
              onChange={(event) =>
                onChange({ ...modifier, operation: event.target.value as 'union' | 'subtract' | 'intersect' })
              }
            >
              <option value="union">并集</option>
              <option value="subtract">差集</option>
              <option value="intersect">交集</option>
            </select>
          </Field>
          <Field label="操作数">
            <select
              aria-label={`${prefix} 布尔操作数`}
              value={modifier.operandId}
              onChange={(event) => onChange({ ...modifier, operandId: event.target.value })}
            >
              {!operands.some((operand) => operand.id === modifier.operandId) && (
                <option value={modifier.operandId}>{modifier.operandId}</option>
              )}
              {operands.map((operand) => (
                <option key={operand.id} value={operand.id}>
                  {operand.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      );
    case 'bevel':
      return (
        <>
          <Field label="宽度">
            <ModelingNumberInput
              label={`${prefix} 倒角宽度`}
              value={modifier.width}
              min={0.000001}
              max={100000}
              suffix="m"
              onChange={(width) => onChange({ ...modifier, width })}
            />
          </Field>
          <Field label="段数">
            <NumberInput
              label={`${prefix} 倒角段数`}
              value={modifier.segments}
              min={1}
              max={16}
              step={1}
              onChange={(segments) => onChange({ ...modifier, segments: Math.round(segments) })}
            />
          </Field>
          <Field label="弧度比例">
            <NumberInput
              label={`${prefix} 倒角弧度比例`}
              value={modifier.shape}
              min={0}
              max={1}
              step={0.1}
              onChange={(shape) => onChange({ ...modifier, shape })}
            />
          </Field>
        </>
      );
    case 'mirror':
      return (
        <>
          <ModifierAxis
            label="镜像轴"
            name={`${prefix} 镜像轴`}
            value={modifier.axis}
            onChange={(axis) => onChange({ ...modifier, axis })}
          />
          <Field label="镜面位置">
            <NumberInput
              label={`${prefix} 镜面位置`}
              value={modifier.offset}
              min={-100000}
              max={100000}
              suffix="m"
              onChange={(offset) => onChange({ ...modifier, offset })}
            />
          </Field>
          <label className="row">
            <input
              type="checkbox"
              aria-label={`${prefix} 保留原几何`}
              checked={modifier.keepOriginal}
              onChange={(event) => onChange({ ...modifier, keepOriginal: event.target.checked })}
            />
            保留原几何
          </label>
          <label className="row">
            <input
              type="checkbox"
              aria-label={`${prefix} 焊接接缝`}
              checked={modifier.weldThreshold !== undefined}
              onChange={(event) => {
                if (event.target.checked) onChange({ ...modifier, weldThreshold: 0.001 });
                else {
                  const { weldThreshold: _weldThreshold, ...unwelded } = modifier;
                  onChange(unwelded);
                }
              }}
            />
            焊接接缝
          </label>
          {modifier.weldThreshold !== undefined && (
            <Field label="焊接距离">
              <ModelingNumberInput
                label={`${prefix} 焊接距离`}
                value={modifier.weldThreshold}
                min={0}
                max={1}
                step={0.001}
                suffix="m"
                onChange={(weldThreshold) => onChange({ ...modifier, weldThreshold })}
              />
            </Field>
          )}
        </>
      );
    case 'array':
      return (
        <>
          <Field label="数量">
            <NumberInput
              label={`${prefix} 数量`}
              value={modifier.count}
              min={2}
              max={32}
              step={1}
              onChange={(count) => onChange({ ...modifier, count: Math.round(count) })}
            />
          </Field>
          <VectorInput
            label={`${prefix} 偏移`}
            value={modifier.offset}
            onChange={(offset) => onChange({ ...modifier, offset })}
          />
        </>
      );
    case 'subdivision':
    case 'catmull-clark':
      return (
        <>
          <Field label="细分级别">
            <NumberInput
              label={`${prefix} 细分级别`}
              value={modifier.iterations}
              min={1}
              max={3}
              step={1}
              onChange={(iterations) => onChange({ ...modifier, iterations: Math.round(iterations) })}
            />
          </Field>
          {modifier.type === 'catmull-clark' && (
            <Field label="边界处理">
              <select
                aria-label={`${prefix} 边界处理`}
                value={modifier.boundary}
                onChange={(event) =>
                  onChange({ ...modifier, boundary: event.target.value as 'smooth' | 'corners' })
                }
              >
                <option value="corners">保持角点</option>
                <option value="smooth">平滑边界</option>
              </select>
            </Field>
          )}
          {modifier.type === 'subdivision' && (
            <>
              <label className="row">
                <input
                  type="checkbox"
                  aria-label={`${prefix} 保持边界`}
                  checked={modifier.preserveEdges}
                  onChange={(event) => onChange({ ...modifier, preserveEdges: event.target.checked })}
                />
                保持边界
              </label>
              <label className="row">
                <input
                  type="checkbox"
                  aria-label={`${prefix} 仅细分面片`}
                  checked={modifier.flatOnly}
                  onChange={(event) => onChange({ ...modifier, flatOnly: event.target.checked })}
                />
                仅细分面片
              </label>
            </>
          )}
        </>
      );
    case 'solidify':
      return (
        <>
          <Field label="厚度">
            <ModelingNumberInput
              label={`${prefix} 厚度`}
              value={modifier.thickness}
              min={0}
              max={10000}
              step={0.01}
              suffix="m"
              onChange={(thickness) => onChange({ ...modifier, thickness })}
            />
          </Field>
          <Field label="厚度偏移">
            <NumberInput
              label={`${prefix} 厚度偏移`}
              value={modifier.offset}
              min={-1}
              max={1}
              step={0.1}
              onChange={(offset) => onChange({ ...modifier, offset })}
            />
          </Field>
        </>
      );
    case 'bend':
    case 'twist':
      return (
        <>
          <ModifierAxis
            label="变形轴"
            name={`${prefix} 变形轴`}
            value={modifier.axis}
            onChange={(axis) => {
              if (modifier.type === 'bend') {
                const direction =
                  modifier.direction === axis ? (axis === 'x' ? 'y' : 'x') : modifier.direction;
                onChange({ ...modifier, axis, direction });
              } else onChange({ ...modifier, axis });
            }}
          />
          {modifier.type === 'bend' && (
            <ModifierAxis
              label="弯曲方向"
              name={`${prefix} 弯曲方向`}
              value={modifier.direction}
              exclude={modifier.axis}
              onChange={(direction) => onChange({ ...modifier, direction })}
            />
          )}
          <Field label="角度">
            <NumberInput
              label={`${prefix} 角度`}
              value={modifier.angle}
              min={modifier.type === 'bend' ? -180 : -720}
              max={modifier.type === 'bend' ? 180 : 720}
              step={1}
              suffix="deg"
              onChange={(angle) => onChange({ ...modifier, angle })}
            />
          </Field>
          <div className="two-fields">
            <Field label="起点">
              <NumberInput
                label={`${prefix} 起点`}
                value={modifier.from}
                min={-100000}
                max={100000}
                suffix="m"
                onChange={(from) => onChange({ ...modifier, from })}
              />
            </Field>
            <Field label="终点">
              <NumberInput
                label={`${prefix} 终点`}
                value={modifier.to}
                min={-100000}
                max={100000}
                suffix="m"
                onChange={(to) => onChange({ ...modifier, to })}
              />
            </Field>
          </div>
        </>
      );
    case 'curve-array':
      return <CurveArrayParameters modifier={modifier} index={index} onChange={onChange} />;
  }
}
