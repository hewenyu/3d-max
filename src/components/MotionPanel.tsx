import { useState } from 'react';
import { Check, Plus, Route, Trash2, Wand2 } from 'lucide-react';
import {
  compilePath,
  motionPathSchema,
  pathDistance,
  pathDuration,
  type MotionPath,
} from '../../shared/motion';
import type { SceneObject, Vec3 } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, Modal, NumberInput, Section, VectorInput } from './Controls';
import { VehiclePanel } from './VehiclePanel';
import { MotionEventsPanel } from './MotionEventsPanel';
import './motion.css';

export function MotionPanel({
  object,
  editor,
  sourceTime = 0,
}: {
  object: SceneObject;
  editor: EditorActions;
  sourceTime?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="路径与载具"
      defaultOpen={Boolean(object.vehicle || object.motion || object.effect || object.motionEvents?.length)}
    >
      <VehiclePanel object={object} editor={editor} />
      <button
        className="subtle-button full-button"
        disabled={object.locked || editor.busy}
        onClick={() => setOpen(true)}
      >
        <Route size={14} />
        {object.motion ? '编辑运动路径' : '创建运动路径'}
      </button>
      {object.motion && (
        <div className="motion-actions">
          <button
            className="subtle-button"
            disabled={object.locked || editor.busy}
            onClick={() =>
              editor.run('motion.path.bake', { id: object.id, fps: editor.project?.settings.fps ?? 24 })
            }
          >
            <Wand2 size={14} />
            烘焙路径
          </button>
          <IconButton
            icon={Trash2}
            label="移除运动路径"
            disabled={object.locked || editor.busy}
            onClick={() => editor.run('motion.path.set', { id: object.id, path: null })}
          />
        </div>
      )}
      {object.effect && (
        <fieldset className="motion-fields" disabled={object.locked || editor.busy}>
          <Field label="效果类型">
            <select
              aria-label="效果类型"
              value={object.effect.kind}
              onChange={(event) =>
                editor.run('effect.configure', {
                  id: object.id,
                  effect: { ...object.effect, kind: event.target.value },
                })
              }
            >
              <option value="projectile">弹道</option>
              <option value="impact">命中</option>
              <option value="explosion">爆炸占位</option>
            </select>
          </Field>
          {(['start', 'duration', 'radius'] as const).map((key) => (
            <Field key={key} label={{ start: '效果入点', duration: '效果时长', radius: '效果半径' }[key]}>
              <NumberInput
                label={`效果 ${key}`}
                value={object.effect![key]}
                min={key === 'start' ? 0 : 0.01}
                max={key === 'duration' ? 60 : key === 'radius' ? 1000 : 86400}
                onChange={(value) =>
                  editor.run('effect.configure', {
                    id: object.id,
                    effect: { ...object.effect, [key]: value },
                  })
                }
              />
            </Field>
          ))}
        </fieldset>
      )}
      <MotionEventsPanel object={object} editor={editor} sourceTime={sourceTime} />
      {open && (
        <PathEditor object={object} sourceTime={sourceTime} editor={editor} onClose={() => setOpen(false)} />
      )}
    </Section>
  );
}

function PathEditor({
  object,
  sourceTime,
  editor,
  onClose,
}: {
  object: SceneObject;
  sourceTime: number;
  editor: EditorActions;
  onClose: () => void;
}) {
  const [path, setPath] = useState<MotionPath>(
    () =>
      object.motion ??
      motionPathSchema.parse({
        points: [
          { position: object.position },
          { position: [object.position[0], object.position[1], object.position[2] + 10] },
        ],
        start: sourceTime,
        speed: [{ duration: 5, fromSpeed: 2, toSpeed: 2, easing: 'constant' }],
      }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (patch: Partial<MotionPath>) => setPath((previous) => ({ ...previous, ...patch }));
  const point = (index: number, position: Vec3) =>
    setPath((previous) => ({
      ...previous,
      points: previous.points.map((value, current) => (current === index ? { ...value, position } : value)),
    }));
  const speed = (index: number, patch: Partial<MotionPath['speed'][number]>) =>
    setPath((previous) => ({
      ...previous,
      speed: previous.speed.map((value, current) => {
        if (current !== index) return value;
        const next = { ...value, ...patch };
        if (next.easing === 'constant') next.toSpeed = next.fromSpeed;
        return next;
      }),
    }));
  const fit = () => {
    try {
      const length = compilePath(path).length - path.distanceOffset;
      const distance = pathDistance(path);
      if (length <= 0 || distance <= 0) throw new Error('路径路程与速度积分必须大于零');
      setPath((previous) => ({
        ...previous,
        speed: previous.speed.map((segment) => ({
          ...segment,
          fromSpeed: (segment.fromSpeed * length) / distance,
          toSpeed: (segment.toSpeed * length) / distance,
        })),
      }));
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  const save = async (bake: boolean) => {
    setBusy(true);
    setError('');
    try {
      const parsed = motionPathSchema.parse(path);
      await editor.command([
        { type: 'motion.path.set', payload: { id: object.id, path: parsed } },
        ...(bake
          ? [
              {
                type: 'motion.path.bake',
                payload: { id: object.id, fps: editor.project?.settings.fps ?? 24 },
              },
            ]
          : []),
      ]);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="运动路径" wide onClose={onClose}>
      <fieldset className="motion-editor" disabled={busy || object.locked}>
        <div className="motion-settings">
          <Field label="源时间入点">
            <NumberInput
              label="路径源时间入点"
              value={path.start}
              min={0}
              max={86400}
              onChange={(start) => update({ start })}
            />
          </Field>
          <Field label="首段偏移">
            <NumberInput
              label="路径距离偏移"
              value={path.distanceOffset}
              min={0}
              onChange={(distanceOffset) => update({ distanceOffset })}
              suffix="m"
            />
          </Field>
          <Field label="曲线类型">
            <select
              aria-label="路径曲线类型"
              value={path.curve}
              onChange={(event) => update({ curve: event.target.value as MotionPath['curve'] })}
            >
              <option value="centripetal">向心曲线</option>
              <option value="chordal">弦长曲线</option>
              <option value="catmullrom">Catmull-Rom</option>
            </select>
          </Field>
          {path.curve === 'catmullrom' && (
            <Field label="曲线张力">
              <NumberInput
                label="路径张力"
                value={path.tension}
                min={0}
                max={1}
                onChange={(tension) => update({ tension })}
              />
            </Field>
          )}
          <Field label="闭合路径">
            <input
              type="checkbox"
              aria-label="闭合路径"
              checked={path.closed}
              onChange={(event) => update({ closed: event.target.checked })}
            />
          </Field>
          <Field label="朝向模式">
            <select
              aria-label="路径朝向"
              value={path.orientation}
              onChange={(event) => update({ orientation: event.target.value as MotionPath['orientation'] })}
            >
              <option value="path">沿路径朝向</option>
              <option value="fixed">保持基础朝向</option>
            </select>
          </Field>
          <Field label="朝向前瞻">
            <NumberInput
              label="路径朝向前瞻"
              value={path.lookAhead}
              min={0}
              max={1000}
              onChange={(lookAhead) => update({ lookAhead })}
              suffix="m"
            />
          </Field>
          <Field label="自动倾侧">
            <NumberInput
              label="路径自动倾侧"
              value={path.bankStrength}
              min={-2}
              max={2}
              onChange={(bankStrength) => update({ bankStrength })}
            />
          </Field>
          <VectorInput label="路径初始上轴" value={path.up} onChange={(up) => update({ up })} />
        </div>
        <div className="motion-list">
          {path.points.map((value, index) => (
            <div className="motion-point" key={index}>
              <VectorInput
                label={`路径点 ${index + 1}`}
                value={value.position}
                onChange={(position) => point(index, position)}
              />
              <Field label="倾侧角">
                <NumberInput
                  label={`路径点 ${index + 1} 倾侧角`}
                  value={value.roll}
                  min={-3600}
                  max={3600}
                  onChange={(roll) =>
                    update({
                      points: path.points.map((item, current) =>
                        current === index ? { ...item, roll } : item,
                      ),
                    })
                  }
                />
              </Field>
              <IconButton
                icon={Trash2}
                label={`移除路径点 ${index + 1}`}
                disabled={path.points.length <= 2}
                onClick={() => update({ points: path.points.filter((_item, current) => current !== index) })}
              />
            </div>
          ))}
        </div>
        <button
          className="subtle-button"
          onClick={() =>
            update({
              points: [
                ...path.points,
                {
                  position: [
                    path.points.at(-1)!.position[0],
                    path.points.at(-1)!.position[1],
                    path.points.at(-1)!.position[2] + 5,
                  ],
                  roll: path.points.at(-1)!.roll,
                },
              ],
            })
          }
        >
          <Plus size={14} />
          添加路径点
        </button>
        <div className="motion-speed-list">
          {path.speed.map((segment, index) => (
            <div className="motion-speed" key={index}>
              <Field label="源秒">
                <NumberInput
                  label={`路径速度段 ${index + 1} 时长`}
                  value={segment.duration}
                  min={0.01}
                  max={3600}
                  onChange={(duration) => speed(index, { duration })}
                />
              </Field>
              <Field label="起速 m/s">
                <NumberInput
                  label={`路径速度段 ${index + 1} 起速`}
                  value={segment.fromSpeed}
                  min={0}
                  max={10000}
                  onChange={(fromSpeed) => speed(index, { fromSpeed })}
                />
              </Field>
              <Field label="末速 m/s">
                <NumberInput
                  label={`路径速度段 ${index + 1} 末速`}
                  value={segment.toSpeed}
                  min={0}
                  max={10000}
                  onChange={(toSpeed) => speed(index, { toSpeed })}
                />
              </Field>
              <select
                aria-label={`路径速度段 ${index + 1} 曲线`}
                value={segment.easing}
                onChange={(event) =>
                  speed(index, { easing: event.target.value as MotionPath['speed'][number]['easing'] })
                }
              >
                <option value="constant">恒速</option>
                <option value="linear">线性变速</option>
                <option value="smooth">平滑变速</option>
              </select>
              <IconButton
                icon={Trash2}
                label={`移除路径速度段 ${index + 1}`}
                disabled={path.speed.length <= 1}
                onClick={() => update({ speed: path.speed.filter((_item, current) => current !== index) })}
              />
            </div>
          ))}
        </div>
        <div className="motion-actions">
          <button
            className="subtle-button"
            onClick={() =>
              update({
                speed: [
                  ...path.speed,
                  {
                    duration: 2,
                    fromSpeed: path.speed.at(-1)!.toSpeed,
                    toSpeed: path.speed.at(-1)!.toSpeed,
                    easing: 'constant',
                  },
                ],
              })
            }
          >
            <Plus size={14} />
            添加速度段
          </button>
          <button className="subtle-button" onClick={fit}>
            <Wand2 size={14} />
            匹配全路径
          </button>
        </div>
        <div className="motion-metrics">
          <span>{pathDuration(path).toFixed(2)} s</span>
          <span>{pathDistance(path).toFixed(2)} m</span>
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="motion-actions">
          <button className="subtle-button" onClick={() => void save(false)}>
            <Check size={14} />
            保存路径
          </button>
          <button className="primary-button" onClick={() => void save(true)}>
            <Wand2 size={14} />
            保存并烘焙
          </button>
        </div>
      </fieldset>
    </Modal>
  );
}
