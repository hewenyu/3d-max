import { useState } from 'react';
import { Wand2 } from 'lucide-react';
import { rigidBodySchema, type RigidBodySettings } from '../../shared/physics';
import type { Project, SceneObject, Vec3 } from '../../shared/types';
import { api } from '../api';
import type { EditorActions } from '../useEditor';
import { Field, NumberInput, Section, VectorInput } from './Controls';
import './motion.css';

export function PhysicsPanel({
  object,
  project,
  editor,
  sourceTime = 0,
}: {
  object: SceneObject;
  project: Project;
  editor: EditorActions;
  sourceTime?: number;
}) {
  const [start, setStart] = useState(sourceTime);
  const [duration, setDuration] = useState(5);
  const [gravity, setGravity] = useState<Vec3>([0, -9.81, 0]);
  const [stepRate, setStepRate] = useState(120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const update = (patch: Partial<RigidBodySettings>) =>
    editor.run((latest) => {
      const target = latest.objects.find((item) => item.id === object.id);
      if (!target?.physics) throw new Error('刚体已删除');
      const body = { ...target.physics, ...patch };
      if (body.mode !== 'static' && body.shape === 'mesh') body.shape = 'box';
      return [{ type: 'physics.body.set', payload: { id: object.id, body } }];
    });
  const bake = async () => {
    setBusy(true);
    setError('');
    setResult('');
    try {
      const response = await api<{ project: Project; frames?: number }>('/simulation/bake', {
        method: 'POST',
        body: JSON.stringify({
          projectId: project.id,
          expectedRevision: project.revision,
          expectedContext: {
            sceneId: project.production?.activeSceneId ?? null,
            performanceId: project.production?.activePerformanceId ?? null,
          },
          requestId: crypto.randomUUID(),
          options: { start, duration, fps: project.settings.fps, stepRate, gravity },
        }),
      });
      editor.acceptCurrent(response.project);
      setResult(`${duration.toFixed(2)} s · ${Math.ceil(duration * project.settings.fps) + 1} 帧`);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="刚体模拟" defaultOpen={Boolean(object.physics)}>
      <Field label="启用刚体">
        <input
          aria-label="启用刚体"
          type="checkbox"
          checked={Boolean(object.physics)}
          disabled={object.locked || editor.busy || busy}
          onChange={(event) =>
            editor.run('physics.body.set', {
              id: object.id,
              body: event.target.checked
                ? rigidBodySchema.parse({
                    mode: ['plane', 'wall'].includes(object.type) ? 'static' : 'dynamic',
                  })
                : null,
            })
          }
        />
      </Field>
      {object.physics && (
        <fieldset className="motion-fields" disabled={object.locked || editor.busy || busy}>
          <Field label="刚体类型">
            <select
              aria-label="刚体类型"
              value={object.physics.mode}
              onChange={(event) => update({ mode: event.target.value as RigidBodySettings['mode'] })}
            >
              <option value="static">静态</option>
              <option value="dynamic">动态</option>
              <option value="kinematic">运动学</option>
            </select>
          </Field>
          <Field label="碰撞形状">
            <select
              aria-label="碰撞形状"
              value={object.physics.shape}
              onChange={(event) => update({ shape: event.target.value as RigidBodySettings['shape'] })}
            >
              <option value="box">包围盒</option>
              <option value="sphere">球体</option>
              <option value="capsule">胶囊</option>
              <option value="mesh" disabled={object.physics.mode !== 'static' || Boolean(object.assetUrl)}>
                实际网格
              </option>
            </select>
          </Field>
          {(
            ['mass', 'friction', 'restitution', 'linearDamping', 'angularDamping', 'gravityScale'] as const
          ).map((key) => (
            <Field
              key={key}
              label={
                {
                  mass: '质量 kg',
                  friction: '摩擦系数',
                  restitution: '回弹系数',
                  linearDamping: '线性阻尼',
                  angularDamping: '角阻尼',
                  gravityScale: '重力倍率',
                }[key]
              }
            >
              <NumberInput
                label={`刚体 ${key}`}
                value={object.physics![key]}
                min={key === 'mass' ? 0.001 : key === 'gravityScale' ? -10 : 0}
                max={
                  key === 'restitution'
                    ? 1
                    : key === 'friction'
                      ? 5
                      : key === 'gravityScale'
                        ? 10
                        : key === 'mass'
                          ? 1e8
                          : 100
                }
                onChange={(value) => update({ [key]: value })}
              />
            </Field>
          ))}
          <VectorInput
            label="初速度 m/s"
            value={object.physics.linearVelocity}
            onChange={(linearVelocity) => update({ linearVelocity })}
          />
          <VectorInput
            label="角速度 rad/s"
            value={object.physics.angularVelocity}
            onChange={(angularVelocity) => update({ angularVelocity })}
          />
          <div className="motion-axis-locks">
            {['X', 'Y', 'Z'].map((axis, index) => (
              <label key={axis}>
                <input
                  type="checkbox"
                  aria-label={`锁定刚体 ${axis} 旋转`}
                  checked={object.physics!.lockRotation[index]}
                  onChange={(event) =>
                    update({
                      lockRotation: object.physics!.lockRotation.map((value, current) =>
                        current === index ? event.target.checked : value,
                      ) as [boolean, boolean, boolean],
                    })
                  }
                />
                锁定 {axis}
              </label>
            ))}
          </div>
          <Field label="连续碰撞">
            <input
              type="checkbox"
              aria-label="连续碰撞检测"
              checked={object.physics.ccd}
              onChange={(event) => update({ ccd: event.target.checked })}
            />
          </Field>
          <Field label="模拟入点">
            <NumberInput label="模拟源时间入点" value={start} min={0} max={86400} onChange={setStart} />
          </Field>
          <Field label="模拟时长">
            <NumberInput
              label="模拟时长"
              value={duration}
              min={0.05}
              max={600}
              onChange={setDuration}
              suffix="s"
            />
          </Field>
          <Field label="模拟频率">
            <NumberInput
              label="模拟步进频率"
              value={stepRate}
              min={30}
              max={240}
              step={1}
              onChange={setStepRate}
              suffix="Hz"
            />
          </Field>
          <Field label="重力环境">
            <select
              aria-label="重力环境"
              value={
                gravity.every((value) => value === 0)
                  ? 'zero'
                  : gravity[0] === 0 && gravity[1] === -9.81 && gravity[2] === 0
                    ? 'earth'
                    : 'custom'
              }
              onChange={(event) => {
                if (event.target.value !== 'custom')
                  setGravity(event.target.value === 'zero' ? [0, 0, 0] : [0, -9.81, 0]);
              }}
            >
              <option value="earth">地面</option>
              <option value="zero">零重力</option>
              <option value="custom">自定义</option>
            </select>
          </Field>
          <VectorInput label="重力 m/s2" value={gravity} onChange={setGravity} />
          <button className="primary-button full-button" onClick={() => void bake()}>
            <Wand2 size={14} />
            {busy ? '正在计算' : '烘焙场景刚体'}
          </button>
        </fieldset>
      )}
      {result && (
        <p className="inline-status" role="status">
          {result}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
