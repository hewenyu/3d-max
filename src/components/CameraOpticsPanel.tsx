import { useState } from 'react';
import { Copy, DiamondPlus, Trash2 } from 'lucide-react';
import { sampleCamera } from '../../shared/timeline';
import {
  aspectComposition,
  type CameraOptics,
  type OpticsKeyframe,
  type SafeArea,
} from '../../shared/camera-optics';
import type { Project, ShotCamera } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, NumberInput, Section, timecode } from './Controls';

const defaults: CameraOptics = {
  enabled: true,
  focusDistance: 5,
  focusTargetId: null,
  fStop: 2.8,
  sensorWidthMm: 36,
  keyframes: [],
};
const safeDefaults: SafeArea = { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05, thirds: true };

export function CameraOpticsPanel({
  camera,
  project,
  editor,
  time,
  onSeek,
  locked,
}: {
  camera: ShotCamera;
  project: Project;
  editor: EditorActions;
  time: number;
  onSeek: (time: number) => void;
  locked: boolean;
}) {
  const [keyMode, setKeyMode] = useState(false);
  const aspect = project.settings.aspect;
  const optics = camera.optics ?? defaults;
  const sampled = sampleCamera(camera, time, aspect).optics ?? defaults;
  const value = keyMode ? sampled : optics;
  const latestCamera = (latest: Project) => {
    const target = latest.cameras.find((item) => item.id === camera.id);
    if (!target) throw new Error('摄影机已删除');
    return target;
  };
  const update = (patch: Partial<CameraOptics>) =>
    editor.run((latest) => [
      {
        type: 'camera.optics.set',
        payload: { id: camera.id, optics: { ...(latestCamera(latest).optics ?? defaults), ...patch } },
      },
    ]);
  const setKey = (patch: Partial<OpticsKeyframe> = {}) =>
    editor.run((latest) => {
      const target = latestCamera(latest);
      const evaluated = sampleCamera(target, time, aspect).optics ?? defaults;
      const existing = target.optics?.keyframes.find(
        (item) => Math.abs(item.time - time) < 0.5 / latest.settings.fps,
      );
      return [
        {
          type: 'camera.optics.keyframe.set',
          payload: {
            id: camera.id,
            keyframe: {
              ...existing,
              id: existing?.id ?? crypto.randomUUID(),
              time,
              focusDistance: evaluated.focusDistance,
              focusTargetId: evaluated.focusTargetId,
              fStop: evaluated.fStop,
              easing: existing?.easing ?? 'smooth',
              ...patch,
            },
          },
        },
      ];
    });
  const change = (patch: Partial<OpticsKeyframe>) => (keyMode ? setKey(patch) : update(patch));
  const safe = project.settings.safeArea ?? safeDefaults;
  const updateSafe = (patch: Partial<SafeArea>) =>
    editor.run((latest) => [
      {
        type: 'project.settings',
        payload: { safeArea: { ...(latest.settings.safeArea ?? safeDefaults), ...patch } },
      },
    ]);
  return (
    <>
      <Section title="画幅构图">
        <Field label="输出画幅">
          <select
            aria-label="构图画幅"
            value={aspect}
            onChange={(event) => editor.run('project.settings', { aspect: event.target.value })}
          >
            <option value="16:9">横屏 16:9</option>
            <option value="9:16">竖屏 9:16</option>
            <option value="1:1">方形 1:1</option>
          </select>
        </Field>
        <Field label="独立构图">
          <input
            type="checkbox"
            aria-label="当前画幅独立构图"
            checked={!!camera.compositions?.[aspect]}
            disabled={locked}
            onChange={(event) => {
              if (!event.target.checked) editor.run('camera.composition.delete', { id: camera.id, aspect });
              else
                editor.run((latest) => {
                  const target = latestCamera(latest);
                  return [
                    {
                      type: 'camera.composition.set',
                      payload: {
                        id: camera.id,
                        aspect,
                        composition: {
                          position: target.position,
                          target: target.target,
                          fov: target.fov,
                          keyframes: target.keyframes,
                        },
                      },
                    },
                  ];
                });
            }}
          />
        </Field>
        {camera.compositions?.[aspect] && (
          <button
            className="text-button full-width"
            disabled={locked}
            onClick={() =>
              editor.run((latest) => {
                const view = aspectComposition(latestCamera(latest), aspect === '16:9' ? '9:16' : '16:9');
                return [
                  {
                    type: 'camera.composition.set',
                    payload: {
                      id: camera.id,
                      aspect,
                      composition: {
                        position: view.position,
                        target: view.target,
                        fov: view.fov,
                        keyframes: view.keyframes,
                      },
                    },
                  },
                ];
              })
            }
          >
            <Copy size={14} />从{aspect === '16:9' ? '竖屏' : '横屏'}复制构图
          </button>
        )}
      </Section>
      <Section
        title="光学对焦"
        extra={
          <IconButton
            icon={DiamondPlus}
            label="添加对焦关键帧"
            disabled={locked || !camera.optics}
            onClick={() => setKey()}
          />
        }
      >
        <fieldset disabled={locked}>
          <Field label="景深">
            <input
              type="checkbox"
              aria-label="启用景深"
              checked={camera.optics?.enabled ?? false}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
          </Field>
          {camera.optics && (
            <>
              <div className="segmented compact">
                <button className={!keyMode ? 'active' : ''} onClick={() => setKeyMode(false)}>
                  基础
                </button>
                <button className={keyMode ? 'active' : ''} onClick={() => setKeyMode(true)}>
                  当前帧
                </button>
              </div>
              <Field label="对焦目标">
                <select
                  aria-label="光学对焦目标"
                  value={value.focusTargetId ?? ''}
                  onChange={(event) => change({ focusTargetId: event.target.value || null })}
                >
                  <option value="">手动距离</option>
                  {project.objects.map((object) => (
                    <option key={object.id} value={object.id}>
                      {object.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="对焦距离">
                <NumberInput
                  label="对焦距离"
                  value={value.focusDistance}
                  min={0.03}
                  max={10000}
                  suffix="m"
                  disabled={!!value.focusTargetId}
                  onChange={(focusDistance) => change({ focusDistance })}
                />
              </Field>
              <Field label="光圈">
                <NumberInput
                  label="光圈"
                  value={value.fStop}
                  min={0.7}
                  max={64}
                  step={0.1}
                  onChange={(fStop) => change({ fStop })}
                  suffix="f"
                />
              </Field>
              <Field label="传感器宽">
                <NumberInput
                  label="传感器宽度"
                  value={optics.sensorWidthMm}
                  min={1}
                  max={100}
                  step={1}
                  suffix="mm"
                  onChange={(sensorWidthMm) => update({ sensorWidthMm })}
                />
              </Field>
              <div className="keyframe-list">
                {optics.keyframes.map((frame) => (
                  <div key={frame.id}>
                    <button
                      className="keyframe-link"
                      onClick={() => {
                        setKeyMode(true);
                        onSeek(frame.time);
                      }}
                    >
                      <span className="diamond" />
                      {timecode(frame.time, project.settings.fps)}
                    </button>
                    <select
                      aria-label="对焦插值"
                      value={frame.easing}
                      onChange={(event) =>
                        editor.run('camera.optics.keyframe.set', {
                          id: camera.id,
                          keyframe: { ...frame, easing: event.target.value },
                        })
                      }
                    >
                      <option value="linear">线性</option>
                      <option value="smooth">缓入缓出</option>
                      <option value="step">保持</option>
                    </select>
                    <IconButton
                      icon={Trash2}
                      label="删除对焦关键帧"
                      onClick={() =>
                        editor.run('camera.optics.keyframe.delete', { id: camera.id, keyframeId: frame.id })
                      }
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </fieldset>
      </Section>
      <Section title="构图安全区" defaultOpen={false}>
        <Field label="三分线">
          <input
            type="checkbox"
            aria-label="显示三分线"
            checked={safe.thirds}
            onChange={(event) => updateSafe({ thirds: event.target.checked })}
          />
        </Field>
        {(
          [
            ['top', '上边距'],
            ['right', '右边距'],
            ['bottom', '下边距'],
            ['left', '左边距'],
          ] as const
        ).map(([side, label]) => (
          <Field key={side} label={label}>
            <NumberInput
              label={label}
              value={safe[side] * 100}
              min={0}
              max={45}
              step={1}
              suffix="%"
              onChange={(inset) => updateSafe({ [side]: inset / 100 })}
            />
          </Field>
        ))}
      </Section>
    </>
  );
}
