import { useState } from 'react';
import { ArrowLeftRight, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { SurfaceCurve2, SurfaceCurve3 } from '../../../shared/surfaces/schema';
import { Field, IconButton } from '../Controls';
import { ModelingNumberInput } from './ModelingNumberInput';
import { pathPreset, profilePreset } from './surface-presets';

type Curve = SurfaceCurve2 | SurfaceCurve3;
type Knot = { position: number[]; inTangent?: number[]; outTangent?: number[] };
const add = (a: number[], b: number[]) => a.map((value, axis) => value + b[axis]);
const subtract = (a: number[], b: number[]) => a.map((value, axis) => value - b[axis]);
const scale = (a: number[], value: number) => a.map((coordinate) => coordinate * value);
const midpoint = (a: number[], b: number[]) => scale(add(a, b), 0.5);

export function SurfaceVectorInput({
  label,
  value,
  onChange,
  axes,
}: {
  label: string;
  value: number[];
  onChange: (value: number[]) => void;
  axes?: string[];
}) {
  return (
    <div className="surface-vector">
      <span>{label}</span>
      <div
        className="surface-vector-values"
        style={{ gridTemplateColumns: `repeat(${value.length}, minmax(0, 1fr))` }}
      >
        {value.map((coordinate, axis) => (
          <label key={axis}>
            <span className={`axis axis-${axis}`}>{axes?.[axis] ?? ['X', 'Y', 'Z'][axis]}</span>
            <ModelingNumberInput
              label={`${label} ${axes?.[axis] ?? ['X', 'Y', 'Z'][axis]}`}
              value={coordinate}
              onChange={(next) => onChange(value.map((item, index) => (index === axis ? next : item)))}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

export function SurfaceCurveEditor({
  curve,
  onChange,
  label,
  dimensions,
  fixedClosed = false,
  radial = false,
}: {
  curve: Curve;
  onChange: (curve: Curve) => void;
  label: string;
  dimensions: 2 | 3;
  fixedClosed?: boolean;
  radial?: boolean;
}) {
  const [selection, setSelection] = useState(0);
  const [preset, setPreset] = useState(dimensions === 3 ? 'arc' : 'rectangle');
  const selected = Math.min(selection, curve.points.length - 1);
  const point: Knot = curve.points[selected];
  const update = (knots: Knot[], closed = curve.closed) => onChange({ points: knots, closed } as Curve);
  const patchKnot = (patch: Partial<Knot>) =>
    update(curve.points.map((item, index) => (index === selected ? { ...item, ...patch } : item)));
  const removeHandle = (key: 'inTangent' | 'outTangent') => {
    const next = { ...point };
    delete next[key];
    update(curve.points.map((item, index) => (index === selected ? next : item)));
  };
  const handle = (key: 'inTangent' | 'outTangent') => {
    const direction = key === 'inTangent' ? -1 : 1;
    const target = selected + direction;
    const adjacent = curve.closed
      ? curve.points[(target + curve.points.length) % curve.points.length]
      : curve.points[Math.min(curve.points.length - 1, Math.max(0, target))];
    const opposite = curve.points[Math.min(curve.points.length - 1, Math.max(0, selected - direction))];
    return adjacent !== curve.points[selected]
      ? scale(subtract(adjacent.position, point.position), 1 / 3)
      : scale(subtract(point.position, opposite.position), 1 / 3);
  };
  const insert = () => {
    const knots: Knot[] = structuredClone(curve.points);
    const nextIndex = (selected + 1) % knots.length;
    if (!curve.closed && selected === knots.length - 1) {
      const previous = knots[selected - 1];
      knots.push({ position: add(point.position, subtract(point.position, previous.position)) });
    } else {
      const next = knots[nextIndex];
      let inserted: Knot;
      if (!point.outTangent && !next.inTangent)
        inserted = { position: midpoint(point.position, next.position) };
      else {
        const chord = subtract(next.position, point.position);
        const a = add(point.position, point.outTangent ?? scale(chord, 1 / 3));
        const b = add(next.position, next.inTangent ?? scale(chord, -1 / 3));
        const q0 = midpoint(point.position, a),
          q1 = midpoint(a, b),
          q2 = midpoint(b, next.position);
        const r0 = midpoint(q0, q1),
          r1 = midpoint(q1, q2);
        const position = midpoint(r0, r1);
        knots[selected] = { ...knots[selected], outTangent: subtract(q0, point.position) };
        knots[nextIndex] = { ...knots[nextIndex], inTangent: subtract(q2, next.position) };
        inserted = { position, inTangent: subtract(r0, position), outTangent: subtract(r1, position) };
      }
      knots.splice(selected + 1, 0, inserted);
    }
    update(knots);
    setSelection(selected + 1);
  };
  const reverse = () => {
    const points = curve.closed
      ? [curve.points[0], ...curve.points.slice(1).reverse()]
      : curve.points.slice().reverse();
    update(
      points.map((knot) => ({
        position: [...knot.position],
        ...(knot.outTangent ? { inTangent: [...knot.outTangent] } : {}),
        ...(knot.inTangent ? { outTangent: [...knot.inTangent] } : {}),
      })),
    );
    setSelection(0);
  };
  const replacePreset = () => {
    if (dimensions === 3) onChange(pathPreset(preset as 'line' | 'arc' | 'loop'));
    else {
      const next = profilePreset(preset as 'rectangle' | 'circle' | 'arch');
      const min = [0, 1].map((axis) => Math.min(...curve.points.map((knot) => knot.position[axis])));
      const max = [0, 1].map((axis) => Math.max(...curve.points.map((knot) => knot.position[axis])));
      const half = min.map((value, axis) => Math.max(0.001, (max[axis] - value) / 2));
      next.points = next.points.map((knot) => ({
        position: knot.position.map((value, axis) => value * half[axis] + (min[axis] + max[axis]) / 2) as [
          number,
          number,
        ],
        ...(knot.inTangent
          ? { inTangent: knot.inTangent.map((value, axis) => value * half[axis]) as [number, number] }
          : {}),
        ...(knot.outTangent
          ? { outTangent: knot.outTangent.map((value, axis) => value * half[axis]) as [number, number] }
          : {}),
      }));
      onChange(next);
    }
    setSelection(0);
  };
  return (
    <div className="surface-curve" aria-label={`${label}编辑`}>
      <div className="surface-control-heading">
        <strong>{label}</strong>
        <span className="muted">{curve.points.length} 点</span>
        <IconButton icon={ArrowLeftRight} label={`${label}反转方向`} onClick={reverse} />
      </div>
      {!radial && (
        <div className="surface-inline">
          <select
            aria-label={`${label}预设`}
            value={preset}
            onChange={(event) => setPreset(event.target.value)}
          >
            {dimensions === 3 ? (
              <>
                <option value="line">直线</option>
                <option value="arc">弧线</option>
                <option value="loop">闭合环</option>
              </>
            ) : (
              <>
                <option value="rectangle">矩形</option>
                <option value="circle">圆形</option>
                <option value="arch">拱形</option>
              </>
            )}
          </select>
          <IconButton icon={RotateCcw} label={`${label}替换为预设`} onClick={replacePreset} />
        </div>
      )}
      {!fixedClosed && (
        <label className="surface-check">
          <input
            type="checkbox"
            aria-label={`${label}闭合`}
            checked={curve.closed}
            onChange={(event) => onChange({ ...curve, closed: event.target.checked })}
          />
          闭合
        </label>
      )}
      <div className="surface-inline">
        <Field label="控制点">
          <select
            aria-label={`${label}控制点`}
            value={selected}
            onChange={(event) => setSelection(Number(event.target.value))}
          >
            {curve.points.map((_, index) => (
              <option key={index} value={index}>
                {String(index + 1).padStart(2, '0')}
              </option>
            ))}
          </select>
        </Field>
        <IconButton
          icon={Plus}
          label={`${label}插入控制点`}
          disabled={curve.points.length >= 128}
          onClick={insert}
        />
        <IconButton
          icon={Trash2}
          label={`${label}删除控制点`}
          disabled={curve.points.length <= (curve.closed ? 3 : 2)}
          onClick={() => {
            update(curve.points.filter((_, index) => index !== selected));
            setSelection(Math.max(0, selected - 1));
          }}
        />
      </div>
      <SurfaceVectorInput
        label={`${label}控制点坐标`}
        value={point.position}
        axes={radial ? ['R', 'Y'] : undefined}
        onChange={(position) => patchKnot({ position })}
      />
      {(['inTangent', 'outTangent'] as const).map((key) => (
        <div key={key} className="surface-handle">
          <label className="surface-check">
            <input
              type="checkbox"
              aria-label={`${label}${key === 'inTangent' ? '入切线' : '出切线'}`}
              checked={Boolean(point[key])}
              onChange={(event) =>
                event.target.checked ? patchKnot({ [key]: handle(key) }) : removeHandle(key)
              }
            />
            {key === 'inTangent' ? '入切线' : '出切线'}
          </label>
          {point[key] && (
            <SurfaceVectorInput
              label={`${label}${key === 'inTangent' ? '入切线向量' : '出切线向量'}`}
              value={point[key]!}
              onChange={(value) => patchKnot({ [key]: value })}
            />
          )}
        </div>
      ))}
    </div>
  );
}
