import { useState } from 'react';
import { Move3d, RotateCcw } from 'lucide-react';
import type { Vec3 } from '../../../shared/types';
import type { ComponentWorkspaceCommand, ComponentWorkspaceState } from '../../../shared/topology-workspace';
import { Field, IconButton } from '../Controls';
import { ModelingNumberInput } from './ModelingNumberInput';
import { TopologyCheck, TopologySelect, TopologyVector } from './TopologyFields';

export function TopologyTransform({
  state,
  update,
  execute,
  disabled,
}: {
  state: ComponentWorkspaceState;
  update(command: Omit<ComponentWorkspaceCommand, 'type'>): void;
  execute(payload: Record<string, unknown>): void;
  disabled: boolean;
}) {
  const [translation, setTranslation] = useState<Vec3>([0, 0, 0]);
  const [rotation, setRotation] = useState<Vec3>([0, 0, 0]);
  const [scale, setScale] = useState<Vec3>([1, 1, 1]);
  const [snapping, setSnapping] = useState(false);
  const [snap, setSnap] = useState({ translation: 0.1, rotation: 15, scale: 0.1 });
  const reset = () => {
    setTranslation([0, 0, 0]);
    setRotation([0, 0, 0]);
    setScale([1, 1, 1]);
  };
  return (
    <details className="topology-details" open>
      <summary>组件变换</summary>
      <TopologySelect
        label="组件坐标空间"
        value={state.space}
        options={[
          ['local', '局部'],
          ['world', '世界'],
          ['normal', '平均法线'],
        ]}
        onChange={(space) => update({ space: space as ComponentWorkspaceState['space'] })}
      />
      <TopologySelect
        label="组件轴心"
        value={state.pivotMode}
        options={[
          ['median', '选区中心'],
          ['bounds', '包围盒中心'],
          ['origin', '物体原点'],
          ['active', '活动组件'],
          ['custom', '自定义'],
        ]}
        onChange={(pivotMode) => update({ pivotMode: pivotMode as ComponentWorkspaceState['pivotMode'] })}
      />
      {state.pivotMode === 'custom' && (
        <TopologyVector
          label="组件自定义轴心"
          value={state.pivot ?? [0, 0, 0]}
          onChange={(pivot) => update({ pivot })}
        />
      )}
      <TopologyVector label="组件位移" value={translation} onChange={setTranslation} suffix="m" />
      <TopologyVector label="组件旋转" value={rotation} onChange={setRotation} suffix="deg" />
      <TopologyVector label="组件缩放" value={scale} onChange={setScale} />
      <TopologyCheck label="组件增量吸附" checked={snapping} onChange={setSnapping} />
      {snapping && (
        <div className="topology-snap">
          {(
            [
              ['translation', '位移吸附'],
              ['rotation', '旋转吸附'],
              ['scale', '缩放吸附'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <ModelingNumberInput
                label={`组件${label}`}
                min={0.001}
                value={snap[key]}
                onChange={(value) => setSnap({ ...snap, [key]: value })}
              />
            </Field>
          ))}
        </div>
      )}
      <TopologyCheck
        label="比例编辑"
        checked={!!state.proportional}
        onChange={(value) =>
          update({ proportional: value ? { radius: 1, falloff: 'smooth', connected: false } : null })
        }
      />
      {state.proportional && (
        <>
          <Field label="影响半径">
            <ModelingNumberInput
              label="比例编辑影响半径"
              min={0.001}
              value={state.proportional.radius}
              suffix="m"
              onChange={(radius) => update({ proportional: { ...state.proportional!, radius } })}
            />
          </Field>
          <TopologySelect
            label="比例编辑衰减"
            value={state.proportional.falloff}
            options={[
              ['linear', '线性'],
              ['smooth', '平滑'],
              ['sharp', '锐利'],
              ['constant', '恒定'],
            ]}
            onChange={(falloff) =>
              update({
                proportional: {
                  ...state.proportional!,
                  falloff: falloff as NonNullable<ComponentWorkspaceState['proportional']>['falloff'],
                },
              })
            }
          />
          <TopologyCheck
            label="仅影响相连组件"
            checked={state.proportional.connected ?? false}
            onChange={(connected) => update({ proportional: { ...state.proportional!, connected } })}
          />
        </>
      )}
      <div className="topology-command-row">
        <button
          className="text-button"
          disabled={disabled}
          onClick={() =>
            execute({
              translation,
              rotation,
              scale,
              space: state.space,
              pivotMode: state.pivotMode,
              ...(state.pivotMode === 'custom' ? { pivot: state.pivot ?? [0, 0, 0] } : {}),
              ...(state.proportional ? { proportional: state.proportional } : {}),
              ...(snapping ? { snap } : {}),
            })
          }
        >
          <Move3d size={14} />
          应用组件变换
        </button>
        <IconButton icon={RotateCcw} label="重置组件变换数值" onClick={reset} />
      </div>
    </details>
  );
}
