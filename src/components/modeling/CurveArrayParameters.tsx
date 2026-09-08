import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { MeshModifier } from '../../../shared/modifier-schema';
import type { Vec3 } from '../../../shared/types';
import { Field, IconButton, NumberInput, VectorInput } from '../Controls';

type CurveArrayModifier = Extract<MeshModifier, { type: 'curve-array' }>;

export function CurveArrayParameters({
  modifier,
  index,
  onChange,
}: {
  modifier: CurveArrayModifier;
  index: number;
  onChange: (modifier: MeshModifier) => void;
}) {
  const [selectedPoint, setSelectedPoint] = useState(0);
  const pointIndex = Math.min(selectedPoint, modifier.points.length - 1);
  const prefix = `修改器 ${index + 1}`;
  const add = () => {
    const last = modifier.points.at(-1)!;
    const previous = modifier.points.at(-2)!;
    const point = last.map((value, axis) => value + value - previous[axis]) as Vec3;
    onChange({ ...modifier, points: [...modifier.points, point] });
    setSelectedPoint(modifier.points.length);
  };
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
      <Field label="前进轴">
        <select
          aria-label={`${prefix} 前进轴`}
          value={modifier.axis}
          onChange={(event) => onChange({ ...modifier, axis: event.target.value as 'x' | 'y' | 'z' })}
        >
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
      </Field>
      <label className="row">
        <input
          type="checkbox"
          aria-label={`${prefix} 跟随切线`}
          checked={modifier.orient}
          onChange={(event) => onChange({ ...modifier, orient: event.target.checked })}
        />
        跟随切线
      </label>
      <label className="row">
        <input
          type="checkbox"
          aria-label={`${prefix} 闭合路径`}
          checked={modifier.closed}
          disabled={!modifier.closed && modifier.points.length < 3}
          onChange={(event) => onChange({ ...modifier, closed: event.target.checked })}
        />
        闭合路径
      </label>
      <Field label="路径控制点">
        <select
          aria-label={`${prefix} 路径控制点`}
          value={pointIndex}
          onChange={(event) => setSelectedPoint(Number(event.target.value))}
        >
          {modifier.points.map((_, point) => (
            <option key={point} value={point}>
              {point + 1}
            </option>
          ))}
        </select>
      </Field>
      <VectorInput
        label={`${prefix} 控制点坐标`}
        value={modifier.points[pointIndex]}
        onChange={(position) =>
          onChange({
            ...modifier,
            points: modifier.points.map((point, current) => (current === pointIndex ? position : point)),
          })
        }
      />
      <div className="row">
        <IconButton
          icon={Plus}
          label={`${prefix} 添加路径点`}
          disabled={modifier.points.length >= 256}
          onClick={add}
        />
        <IconButton
          icon={Trash2}
          label={`${prefix} 删除路径点`}
          disabled={modifier.points.length <= (modifier.closed ? 3 : 2)}
          onClick={() =>
            onChange({ ...modifier, points: modifier.points.filter((_, point) => point !== pointIndex) })
          }
        />
      </div>
    </>
  );
}
