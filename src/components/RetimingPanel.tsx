import { useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import type { CameraTiming, ClipRetiming, SequenceClip, SpeedSegment } from '../../shared/types';
import {
  clipDuration,
  fitRetiming,
  hasSpeedRamp,
  retimingSourceDuration,
  segmentSpeed,
} from '../../shared/time-map';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, Modal, NumberInput } from './Controls';
import './RetimingPanel.css';

export function RetimingPanel({
  clip,
  sequenceId,
  editor,
  onClose,
}: {
  clip: SequenceClip;
  sequenceId: string;
  editor: EditorActions;
  onClose: () => void;
}) {
  const [retiming, setRetiming] = useState<ClipRetiming>(
    clip.retiming ?? {
      segments: [{ duration: clipDuration(clip), fromSpeed: 1, toSpeed: 1, easing: 'constant' }],
      audio: 'follow',
    },
  );
  const [camera, setCamera] = useState<CameraTiming>(
    clip.cameraTiming ?? { mode: 'source', sourceIn: clip.sourceIn, rate: 1 },
  );
  const [fit, setFit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const evaluated = fit ? fitRetiming(retiming, clip.sourceOut - clip.sourceIn) : retiming;
  const editDuration = evaluated.segments.reduce((sum, segment) => sum + segment.duration, 0);
  const maxSpeed = Math.max(
    1,
    ...evaluated.segments.flatMap((segment) => [segmentSpeed(segment, 0), segmentSpeed(segment, 1)]),
  );
  const points: string[] = [];
  let offset = 0;
  for (const segment of evaluated.segments) {
    for (let index = 0; index <= 32; index++)
      points.push(
        `${20 + ((offset + (segment.duration * index) / 32) / editDuration) * 560},${130 - (segmentSpeed(segment, index / 32) / maxSpeed) * 105}`,
      );
    offset += segment.duration;
  }
  const patchSegment = (index: number, patch: Partial<SpeedSegment>) =>
    setRetiming((previous) => {
      const segments = previous.segments.map((segment, current) => {
        if (current !== index) return segment;
        const editsCurve =
          patch.fromSpeed !== undefined || patch.toSpeed !== undefined || patch.easing !== undefined;
        const base = editsCurve
          ? {
              ...segment,
              fromSpeed: segmentSpeed(segment, 0),
              toSpeed: segmentSpeed(segment, 1),
              curveIn: undefined,
              curveOut: undefined,
            }
          : segment;
        const next = { ...base, ...patch };
        if (next.easing === 'constant') next.toSpeed = next.fromSpeed;
        return next;
      });
      const next = { ...previous, segments };
      return hasSpeedRamp(next) && next.audio === 'follow' ? { ...next, audio: 'warp' } : next;
    });
  const preset = (value: string) => {
    const duration = clip.sourceOut - clip.sourceIn;
    const segment = (
      fromSpeed: number,
      toSpeed: number,
      length: number,
      easing: SpeedSegment['easing'],
    ): SpeedSegment => ({ duration: length, fromSpeed, toSpeed, easing });
    setFit(true);
    setRetiming(
      value === 'ramp'
        ? {
            audio: 'warp',
            segments: [
              segment(1, 1, duration / 5, 'constant'),
              segment(1, 0.25, duration / 5, 'smooth'),
              segment(0.25, 0.25, duration / 5, 'constant'),
              segment(0.25, 1, duration / 5, 'smooth'),
              segment(1, 1, duration / 5, 'constant'),
            ],
          }
        : {
            audio: 'follow',
            segments: [
              segment(value === 'slow' ? 0.25 : 1, value === 'slow' ? 0.25 : 1, duration, 'constant'),
            ],
          },
    );
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await editor.command('clip.retime', {
        sequenceId,
        clipId: clip.id,
        retiming,
        fitSourceRange: fit,
        cameraTiming: camera,
      });
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="片段速度与时间" onClose={onClose} wide>
      <div className="retiming-panel">
        <div className="retiming-summary">
          <span>
            源时间{' '}
            <b>
              {clip.sourceIn.toFixed(2)} - {(clip.sourceIn + retimingSourceDuration(evaluated)).toFixed(2)} s
            </b>
          </span>
          <span>
            成片时长 <b>{editDuration.toFixed(2)} s</b>
          </span>
          <Field label="预设">
            <select
              aria-label="速度曲线预设"
              defaultValue="custom"
              onChange={(event) => preset(event.target.value)}
            >
              <option value="custom" disabled>
                自定义
              </option>
              <option value="normal">正常速度</option>
              <option value="slow">四分之一慢动作</option>
              <option value="ramp">正常 - 渐慢 - 恢复</option>
            </select>
          </Field>
        </div>
        <svg className="retiming-curve" viewBox="0 0 600 150" role="img" aria-label="片段速度曲线">
          <line x1="20" y1="130" x2="580" y2="130" />
          <line x1="20" y1={130 - 105 / maxSpeed} x2="580" y2={130 - 105 / maxSpeed} strokeDasharray="4 4" />
          <polyline points={points.join(' ')} fill="none" />
          <text x="22" y="15">
            {maxSpeed.toFixed(2)}x
          </text>
          <text x="550" y="146">
            {editDuration.toFixed(1)} s
          </text>
        </svg>
        <div className="retiming-table-wrap">
          <table className="retiming-table">
            <thead>
              <tr>
                <th>段</th>
                <th>成片秒</th>
                <th>起始倍速</th>
                <th>结束倍速</th>
                <th>变化曲线</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {retiming.segments.map((segment, index) => (
                <tr key={index}>
                  <td>{index + 1}</td>
                  <td>
                    <NumberInput
                      label={`速度段 ${index + 1} 时长`}
                      value={segment.duration}
                      min={0.01}
                      max={86400}
                      step={0.1}
                      onChange={(duration) => patchSegment(index, { duration })}
                    />
                  </td>
                  <td>
                    <NumberInput
                      label={`速度段 ${index + 1} 起速`}
                      value={segmentSpeed(segment, 0)}
                      min={0.0625}
                      max={16}
                      step={0.05}
                      onChange={(fromSpeed) => patchSegment(index, { fromSpeed })}
                    />
                  </td>
                  <td>
                    <fieldset disabled={segment.easing === 'constant'}>
                      <NumberInput
                        label={`速度段 ${index + 1} 末速`}
                        value={segmentSpeed(segment, 1)}
                        min={0.0625}
                        max={16}
                        step={0.05}
                        onChange={(toSpeed) => patchSegment(index, { toSpeed })}
                      />
                    </fieldset>
                  </td>
                  <td>
                    <select
                      aria-label={`速度段 ${index + 1} 曲线`}
                      value={segment.easing}
                      onChange={(event) =>
                        patchSegment(index, { easing: event.target.value as SpeedSegment['easing'] })
                      }
                    >
                      <option value="constant">恒定</option>
                      <option value="linear">线性渐变</option>
                      <option value="smooth">平滑渐变</option>
                    </select>
                  </td>
                  <td>
                    <IconButton
                      icon={Trash2}
                      label={`删除速度段 ${index + 1}`}
                      disabled={retiming.segments.length === 1}
                      onClick={() =>
                        setRetiming((previous) => ({
                          ...previous,
                          segments: previous.segments.filter((_, current) => current !== index),
                        }))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          className="text-button"
          onClick={() =>
            setRetiming((previous) => ({
              ...previous,
              segments: [
                ...previous.segments,
                {
                  duration: 1,
                  fromSpeed: previous.segments.at(-1)!.toSpeed,
                  toSpeed: previous.segments.at(-1)!.toSpeed,
                  easing: 'constant',
                },
              ],
            }))
          }
        >
          <Plus size={14} />
          添加速度段
        </button>
        <div className="retiming-settings">
          <Field label="固定源范围">
            <input type="checkbox" checked={fit} onChange={(event) => setFit(event.target.checked)} />
          </Field>
          <Field label="同步源音频">
            <select
              aria-label="变速音频策略"
              value={retiming.audio}
              onChange={(event) =>
                setRetiming((previous) => ({
                  ...previous,
                  audio: event.target.value as ClipRetiming['audio'],
                }))
              }
            >
              <option value="follow" disabled={hasSpeedRamp(retiming)}>
                跟随倍速 · 保持音调
              </option>
              <option value="warp">连续跟随 · 随速度变调</option>
              <option value="mute">静音源音频</option>
            </select>
          </Field>
          <Field label="摄影机时间">
            <select
              aria-label="摄影机时间基准"
              value={camera.mode}
              onChange={(event) =>
                setCamera((previous) => ({ ...previous, mode: event.target.value as CameraTiming['mode'] }))
              }
            >
              <option value="source">跟随表演源时间</option>
              <option value="independent">独立成片时钟</option>
            </select>
          </Field>
          {camera.mode === 'independent' && (
            <>
              <Field label="机位动画入点">
                <NumberInput
                  value={camera.sourceIn ?? clip.sourceIn}
                  min={0}
                  onChange={(sourceIn) => setCamera((previous) => ({ ...previous, sourceIn }))}
                />
              </Field>
              <Field label="机位动画倍速">
                <NumberInput
                  value={camera.rate ?? 1}
                  min={-16}
                  max={16}
                  onChange={(rate) => setCamera((previous) => ({ ...previous, rate }))}
                />
              </Field>
            </>
          )}
        </div>
        {error && <p className="inline-error">{error}</p>}
        <div className="retiming-actions">
          <button className="text-button" disabled={busy} onClick={() => void save()}>
            <Check size={14} />
            应用速度曲线
          </button>
        </div>
      </div>
    </Modal>
  );
}
