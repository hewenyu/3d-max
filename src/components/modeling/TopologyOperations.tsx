import { useState } from 'react';
import { Check } from 'lucide-react';
import type { Vec3 } from '../../../shared/types';
import type { ComponentKind } from '../../../shared/topology/types';
import type { topologySchemas } from '../../../shared/topology-schema';
import { Field } from '../Controls';
import { ModelingNumberInput } from './ModelingNumberInput';
import { TopologyCheck, TopologySelect, TopologyVector } from './TopologyFields';

type Operation = Exclude<keyof typeof topologySchemas, 'topology.transform'>;
const operations: {
  type: Operation;
  label: string;
  kinds: ComponentKind[];
  defaults: Record<string, unknown>;
  global?: boolean;
}[] = [
  { type: 'topology.extrude', label: '挤出', kinds: ['face'], defaults: { distance: 0.5, mode: 'region' } },
  {
    type: 'topology.inset',
    label: '内插',
    kinds: ['face'],
    defaults: { thickness: 0.1, depth: 0, mode: 'region' },
  },
  {
    type: 'topology.bevel',
    label: '倒角',
    kinds: ['edge'],
    defaults: { width: 0.1, segments: 1, shape: 1 },
    global: true,
  },
  { type: 'topology.split', label: '拆分', kinds: ['face'], defaults: { mode: 'boundary' } },
  {
    type: 'topology.delete',
    label: '删除',
    kinds: ['vertex', 'edge', 'face'],
    defaults: { incidentFaces: 'reject', removeLooseVertices: true },
  },
  {
    type: 'topology.merge',
    label: '合并顶点',
    kinds: ['vertex'],
    defaults: { target: 'center', collapseFaces: 'reject' },
  },
  { type: 'topology.fill', label: '填洞', kinds: ['edge'], defaults: { triangulate: false } },
  { type: 'topology.bridge', label: '桥接', kinds: ['edge'], defaults: { segments: 1, twist: 0 } },
  {
    type: 'topology.weld',
    label: '按距离焊接',
    kinds: ['vertex', 'edge', 'face'],
    defaults: { tolerance: 0.001, position: 'center' },
  },
  { type: 'topology.dissolve', label: '融并', kinds: ['vertex', 'edge'], defaults: {} },
  { type: 'topology.loop-cut', label: '环切', kinds: ['edge'], defaults: { cuts: 1, slide: 0 } },
  { type: 'topology.slide', label: '滑移', kinds: ['vertex', 'edge'], defaults: { amount: 0.1 } },
  {
    type: 'topology.bisect',
    label: '平面切割',
    kinds: [],
    defaults: { normal: [1, 0, 0], offset: 0, keep: 'both', fill: false, tolerance: 0.000001 },
    global: true,
  },
  {
    type: 'topology.repair',
    label: '修复网格',
    kinds: ['vertex', 'edge', 'face'],
    defaults: {
      removeDegenerateFaces: true,
      removeDuplicateFaces: true,
      removeLooseVertices: true,
      orientFaces: 'outward',
    },
    global: true,
  },
];
export function TopologyOperations({
  kind,
  hasSelection,
  busy,
  execute,
}: {
  kind: ComponentKind | null;
  hasSelection: boolean;
  busy: boolean;
  execute(type: Operation, payload: Record<string, unknown>, useSelection: boolean): void;
}) {
  const [operation, setOperation] = useState<Operation>('topology.extrude');
  const definition = operations.find((item) => item.type === operation)!;
  const [parameters, setParameters] = useState<Record<string, unknown>>({ ...definition.defaults });
  const [wholeMesh, setWholeMesh] = useState(false);
  const set = (key: string, value: unknown) => setParameters((previous) => ({ ...previous, [key]: value }));
  const number = (key: string, label: string, min?: number, max?: number, step?: number) => (
    <Field label={label}>
      <ModelingNumberInput
        label={`拓扑${label}`}
        value={Number(parameters[key])}
        onChange={(value) => set(key, value)}
        min={min}
        max={max}
        step={step}
      />
    </Field>
  );
  const select = (key: string, label: string, options: readonly (readonly [string, string])[]) => (
    <TopologySelect
      label={`拓扑${label}`}
      value={String(parameters[key])}
      options={options}
      onChange={(value) => set(key, value)}
    />
  );
  const check = (key: string, label: string) => (
    <TopologyCheck label={`拓扑${label}`} checked={!!parameters[key]} onChange={(value) => set(key, value)} />
  );
  const global = definition.global && (wholeMesh || operation === 'topology.bisect');
  const permitted = global || (hasSelection && kind !== null && definition.kinds.includes(kind));
  return (
    <details className="topology-details" open>
      <summary>拓扑工具</summary>
      <TopologySelect
        label="拓扑操作"
        value={operation}
        options={operations.map((item) => [item.type, item.label])}
        onChange={(value) => {
          const next = operations.find((item) => item.type === value)!;
          setOperation(next.type);
          setParameters(structuredClone(next.defaults));
          setWholeMesh(next.type === 'topology.bisect');
        }}
      />
      {definition.global && operation !== 'topology.bisect' && (
        <TopologyCheck label="作用于整个网格" checked={wholeMesh} onChange={setWholeMesh} />
      )}
      {(operation === 'topology.extrude' || operation === 'topology.inset') && (
        <>
          {select('mode', '区域方式', [
            ['region', '连通区域'],
            ['individual', '各面独立'],
          ])}
          {operation === 'topology.extrude' ? (
            <>
              {number('distance', '挤出距离')}
              <TopologyCheck
                label="指定挤出方向"
                checked={Array.isArray(parameters.direction)}
                onChange={(checked) => {
                  if (checked) set('direction', [0, 1, 0]);
                  else
                    setParameters((previous) => {
                      const next = { ...previous };
                      delete next.direction;
                      return next;
                    });
                }}
              />
              {Array.isArray(parameters.direction) && (
                <TopologyVector
                  label="拓扑挤出方向"
                  value={parameters.direction as Vec3}
                  onChange={(value) => set('direction', value)}
                />
              )}
            </>
          ) : (
            <>
              {number('thickness', '内插厚度', 0.001)}
              {number('depth', '内插深度')}
            </>
          )}
        </>
      )}
      {operation === 'topology.bevel' && (
        <>
          {number('width', '倒角宽度', 0.001)}
          {number('segments', '倒角分段', 1, 16, 1)}
          {number('shape', '倒角圆度', 0, 1, 0.05)}
        </>
      )}
      {operation === 'topology.split' &&
        select('mode', '拆分方式', [
          ['boundary', '区域边界'],
          ['individual', '各面独立'],
        ])}
      {operation === 'topology.delete' && (
        <>
          {select('incidentFaces', '相连面处理', [
            ['reject', '拒绝删除相连面'],
            ['delete', '同时删除相连面'],
          ])}
          {check('removeLooseVertices', '移除受影响孤立顶点')}
        </>
      )}
      {operation === 'topology.merge' && (
        <>
          <TopologySelect
            label="拓扑合并目标"
            value={String(parameters.target)}
            options={[
              ['first', '首个顶点'],
              ['center', '中心'],
              ['cursor', '指定坐标'],
            ]}
            onChange={(target) =>
              setParameters((previous) => {
                const next = { ...previous, target };
                if (target === 'cursor') return { ...next, position: [0, 0, 0] };
                delete (next as Record<string, unknown>).position;
                return next;
              })
            }
          />
          {parameters.target === 'cursor' && (
            <TopologyVector
              label="拓扑合并坐标"
              value={parameters.position as Vec3}
              onChange={(value) => set('position', value)}
            />
          )}
          {select('collapseFaces', '塌陷面处理', [
            ['reject', '拒绝塌陷'],
            ['remove', '移除塌陷面'],
          ])}
        </>
      )}
      {operation === 'topology.fill' && check('triangulate', '三角化填面')}
      {operation === 'topology.bridge' && (
        <>
          {number('segments', '桥接分段', 1, 64, 1)}
          {number('twist', '桥接错位', -2048, 2048, 1)}
        </>
      )}
      {operation === 'topology.weld' && (
        <>
          {number('tolerance', '焊接距离', 0.000001)}
          {select('position', '焊接位置', [
            ['first', '首个顶点'],
            ['center', '中心'],
          ])}
        </>
      )}
      {operation === 'topology.loop-cut' && (
        <>
          {number('cuts', '环切数量', 1, 32, 1)}
          {number('slide', '环切偏移', -0.999, 0.999, 0.01)}
        </>
      )}
      {operation === 'topology.slide' && number('amount', '滑移比例', -0.999, 0.999, 0.01)}
      {operation === 'topology.bisect' && (
        <>
          <TopologyVector
            label="拓扑切面法线"
            value={parameters.normal as Vec3}
            onChange={(value) => set('normal', value)}
          />
          {number('offset', '切面偏移')}
          {select('keep', '切割保留', [
            ['both', '两侧'],
            ['positive', '正侧'],
            ['negative', '负侧'],
          ])}
          {check('fill', '切割封口')}
          {number('tolerance', '切割容差', 0.000001)}
        </>
      )}
      {operation === 'topology.repair' && (
        <>
          {check('removeDegenerateFaces', '移除退化面')}
          {check('removeDuplicateFaces', '移除重复面')}
          {check('removeLooseVertices', '移除孤立顶点')}
          {select('orientFaces', '法线修复', [
            ['consistent', '统一方向'],
            ['outward', '朝向外侧'],
          ])}
        </>
      )}
      <button
        className="text-button full-width"
        disabled={busy || !permitted}
        title={
          !permitted
            ? `需要选择${definition.kinds.map((value) => ({ vertex: '顶点', edge: '边', face: '面' })[value]).join('、')}`
            : undefined
        }
        onClick={() => execute(operation, parameters, !global)}
      >
        <Check size={14} />
        执行{definition.label}
      </button>
    </details>
  );
}
