import { useEffect, useState } from 'react';
import { Check, Layers, Rotate3d, RotateCcw, Route } from 'lucide-react';
import { dequal } from 'dequal';
import type { SurfaceCurve2, SurfaceCurve3, SurfaceData } from '../../../shared/surfaces/schema';
import type { SceneObject } from '../../../shared/types';
import type { EditorActions } from '../../useEditor';
import { Field, IconButton } from '../Controls';
import { ModelingNumberInput } from './ModelingNumberInput';
import { SurfaceCurveEditor } from './SurfaceCurveEditor';
import { SurfaceLoftEditor } from './SurfaceLoftEditor';
import { SurfaceProfileEditor } from './SurfaceProfileEditor';
import { defaultSurface } from './surface-presets';
import './surfaces.css';

export function SurfacePanel({
  object,
  surface,
  editor,
}: {
  object: SceneObject;
  surface: SurfaceData;
  editor: EditorActions;
}) {
  const [draft, setDraft] = useState<SurfaceData>(() => structuredClone(surface));
  const [baseline, setBaseline] = useState<SurfaceData>(() => structuredClone(surface));
  const [tab, setTab] = useState<'path' | 'profile'>('path');
  const dirty = !dequal(draft, baseline);
  const stale = !dequal(surface, baseline) && !dequal(surface, draft);
  useEffect(() => {
    if (!dequal(surface, baseline) && (!dirty || dequal(surface, draft))) {
      setDraft(structuredClone(surface));
      setBaseline(structuredClone(surface));
    }
  }, [baseline, dirty, draft, surface]);
  const apply = () =>
    editor.run((latest) => {
      const objectModeling = latest.objects.find((item) => item.id === object.id)?.modeling;
      const current = objectModeling?.kind === 'stack' ? objectModeling.base : objectModeling;
      if (!dequal(current, baseline)) throw new Error('曲面参数已被其他操作修改，请还原参数后继续');
      return [{ type: 'surface.set', payload: { id: object.id, surface: draft } }];
    });
  return (
    <div className="surface-panel" data-testid="surface-panel">
      <div className="surface-actions">
        <strong>曲面造型</strong>
        <span className="surface-draft-state">{stale ? '外部更新' : dirty ? '未应用' : '已应用'}</span>
        <IconButton
          icon={RotateCcw}
          label="还原曲面参数"
          disabled={!dirty && !stale}
          onClick={() => {
            setDraft(structuredClone(surface));
            setBaseline(structuredClone(surface));
            editor.setError('');
          }}
        />
        <IconButton icon={Check} label="应用曲面参数" disabled={!dirty || stale} onClick={apply} />
      </div>
      <div className="surface-modes" role="group" aria-label="曲面方式">
        {(
          [
            { kind: 'sweep', label: '扫掠', icon: Route },
            { kind: 'revolve', label: '旋转', icon: Rotate3d },
            { kind: 'loft', label: '放样', icon: Layers },
          ] as const
        ).map(({ kind, label, icon: Icon }) => (
          <button
            key={kind}
            type="button"
            aria-pressed={draft.operation === kind}
            onClick={() => {
              if (draft.operation !== kind) {
                setDraft(defaultSurface(kind));
                setTab('path');
              }
            }}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>
      <div className="surface-common-fields">
        <Field label={draft.operation === 'revolve' ? '旋转分段' : '路径分段'}>
          <ModelingNumberInput
            label="曲面路径分段"
            value={draft.segments}
            min={1}
            max={256}
            step={1}
            onChange={(segments) => setDraft({ ...draft, segments })}
          />
        </Field>
        <Field label="轮廓分段">
          <ModelingNumberInput
            label="曲面轮廓分段"
            value={draft.profileSegments}
            min={1}
            max={64}
            step={1}
            onChange={(profileSegments) => setDraft({ ...draft, profileSegments })}
          />
        </Field>
      </div>
      <Field label="厚度">
        <ModelingNumberInput
          label="曲面厚度"
          value={draft.thickness}
          min={0}
          max={1000}
          suffix="m"
          onChange={(thickness) => setDraft({ ...draft, thickness })}
        />
      </Field>
      <div className="surface-checks">
        <label className="surface-check">
          <input
            type="checkbox"
            aria-label="曲面封口"
            checked={draft.caps}
            onChange={(event) => setDraft({ ...draft, caps: event.target.checked })}
          />
          封口
        </label>
        <label className="surface-check">
          <input
            type="checkbox"
            aria-label="曲面平滑"
            checked={draft.smooth}
            onChange={(event) => setDraft({ ...draft, smooth: event.target.checked })}
          />
          平滑
        </label>
      </div>
      {draft.operation === 'sweep' && (
        <>
          <div className="surface-tabs" role="tablist" aria-label="扫掠参数">
            <button role="tab" aria-selected={tab === 'path'} onClick={() => setTab('path')}>
              路径
            </button>
            <button role="tab" aria-selected={tab === 'profile'} onClick={() => setTab('profile')}>
              截面
            </button>
          </div>
          {tab === 'path' ? (
            <SurfaceCurveEditor
              label="扫掠路径"
              dimensions={3}
              curve={draft.path}
              onChange={(path) => setDraft({ ...draft, path: path as SurfaceCurve3 })}
            />
          ) : (
            <SurfaceProfileEditor
              profile={draft.profile}
              onChange={(profile) => setDraft({ ...draft, profile })}
            />
          )}
        </>
      )}
      {draft.operation === 'revolve' && (
        <>
          <Field label="旋转角度">
            <ModelingNumberInput
              label="曲面旋转角度"
              value={draft.angle}
              min={0.001}
              max={360}
              suffix="deg"
              onChange={(angle) => setDraft({ ...draft, angle })}
            />
          </Field>
          <Field label="起始角度">
            <ModelingNumberInput
              label="曲面起始角度"
              value={draft.startAngle}
              min={-360}
              max={360}
              suffix="deg"
              onChange={(startAngle) => setDraft({ ...draft, startAngle })}
            />
          </Field>
          <SurfaceCurveEditor
            label="旋转母线"
            dimensions={2}
            radial
            curve={draft.profile}
            onChange={(profile) => setDraft({ ...draft, profile: profile as SurfaceCurve2 })}
          />
        </>
      )}
      {draft.operation === 'loft' && <SurfaceLoftEditor surface={draft} onChange={setDraft} />}
    </div>
  );
}
