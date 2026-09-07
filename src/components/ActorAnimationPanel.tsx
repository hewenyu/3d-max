import { useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import {
  actorActionCatalog,
  actorJointLabels,
  actorJointNames,
  type ActorAnimation,
  type ActorClip,
  type ActorConstraint,
  type ActorConstraintResult,
  type ActorEffector,
  type ActorJointKey,
  type ActorJointName,
} from '../../shared/actor-animation';
import type { Project, SceneObject, Vec3 } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, NumberInput, Section, VectorInput } from './Controls';

interface Props {
  object: SceneObject;
  project: Project;
  editor: EditorActions;
  time: number;
  diagnostics?: ActorConstraintResult[];
}
const empty: ActorAnimation = { clips: [], constraints: [], jointKeys: [] };
const effectorLabels: Record<ActorEffector, string> = {
  leftHand: '左手',
  rightHand: '右手',
  leftFoot: '左脚踝',
  rightFoot: '右脚踝',
};
function currentAnimation(project: Project, id: string): ActorAnimation {
  const actor = project.objects.find((object) => object.id === id)?.actor;
  if (!actor) throw new Error('角色已变化，请重新选择');
  return actor.animation ?? empty;
}
type Interval = Pick<ActorClip, 'start' | 'end' | 'fadeIn' | 'fadeOut' | 'weight'>;
function IntervalFields({
  value,
  prefix,
  onChange,
}: {
  value: Interval;
  prefix: string;
  onChange: (patch: Partial<Interval> | ((current: Interval) => Partial<Interval>)) => void;
}) {
  const duration = value.end - value.start;
  return (
    <>
      <div className="two-fields">
        <Field label="开始">
          <NumberInput
            value={value.start}
            min={0}
            max={86400 - duration}
            label={`${prefix}开始时间`}
            suffix="s"
            onChange={(start) => onChange((current) => ({ start, end: start + current.end - current.start }))}
          />
        </Field>
        <Field label="结束">
          <NumberInput
            value={value.end}
            min={value.start + 0.001}
            max={86400}
            label={`${prefix}结束时间`}
            suffix="s"
            onChange={(end) =>
              onChange((current) => {
                const duration = end - current.start;
                const fadeIn = Math.min(current.fadeIn, duration);
                return { end, fadeIn, fadeOut: Math.min(current.fadeOut, duration - fadeIn) };
              })
            }
          />
        </Field>
      </div>
      <div className="two-fields">
        <Field label="淡入">
          <NumberInput
            value={value.fadeIn}
            min={0}
            max={Math.max(0, duration - value.fadeOut)}
            label={`${prefix}淡入`}
            suffix="s"
            onChange={(fadeIn) => onChange({ fadeIn })}
          />
        </Field>
        <Field label="淡出">
          <NumberInput
            value={value.fadeOut}
            min={0}
            max={Math.max(0, duration - value.fadeIn)}
            label={`${prefix}淡出`}
            suffix="s"
            onChange={(fadeOut) => onChange({ fadeOut })}
          />
        </Field>
      </div>
      <Field label="权重">
        <NumberInput
          value={value.weight}
          min={0}
          max={1}
          step={0.05}
          label={`${prefix}权重`}
          onChange={(weight) => onChange({ weight })}
        />
      </Field>
    </>
  );
}

function ActionClips({ object, editor, time }: Props) {
  const clips = object.actor?.animation?.clips ?? [];
  const [selected, setSelected] = useState('');
  const [newAction, setNewAction] = useState<ActorClip['action']>('punch');
  const clip = clips.find((item) => item.id === selected) ?? clips[0];
  const update = (patch: Partial<ActorClip> | ((current: ActorClip) => Partial<ActorClip>)) => {
    if (!clip) return;
    editor.run((latest) => {
      const current = currentAnimation(latest, object.id).clips.find((item) => item.id === clip.id);
      if (!current) throw new Error('动作片段已变化，请重新选择');
      return [
        {
          type: 'actor.clip.set',
          payload: {
            id: object.id,
            clip: { ...current, ...(typeof patch === 'function' ? patch(current) : patch) },
          },
        },
      ];
    });
  };
  const add = () => {
    const definition = actorActionCatalog.find((item) => item.action === newAction)!;
    const id = crypto.randomUUID();
    const start = Math.max(0, Math.min(time, 86400 - definition.duration));
    editor.run('actor.clip.set', {
      id: object.id,
      clip: {
        id,
        action: newAction,
        start,
        end: start + definition.duration,
        sourceOffset: 0,
        speed: 1,
        weight: 1,
        fadeIn: 0.1,
        fadeOut: 0.1,
        loop: definition.loop,
        mirror: false,
      },
    });
    setSelected(id);
  };
  return (
    <Section title="动作片段">
      <fieldset disabled={object.locked || editor.busy}>
        <div className="row">
          <select
            aria-label="新动作"
            value={newAction}
            onChange={(event) => setNewAction(event.target.value as ActorClip['action'])}
          >
            {actorActionCatalog.map((item) => (
              <option key={item.action} value={item.action}>
                {item.label}
              </option>
            ))}
          </select>
          <IconButton icon={Plus} label="添加动作片段" onClick={add} />
        </div>
        {clip && (
          <>
            <Field label="片段">
              <select
                aria-label="动作片段"
                value={clip.id}
                onChange={(event) => setSelected(event.target.value)}
              >
                {clips.map((item) => (
                  <option key={item.id} value={item.id}>
                    {actorActionCatalog.find((definition) => definition.action === item.action)!.label} /{' '}
                    {item.start.toFixed(2)} - {item.end.toFixed(2)} s
                  </option>
                ))}
              </select>
            </Field>
            <Field label="动作">
              <select
                aria-label="动作类型"
                value={clip.action}
                onChange={(event) => update({ action: event.target.value as ActorClip['action'] })}
              >
                {actorActionCatalog.map((item) => (
                  <option key={item.action} value={item.action}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <IntervalFields prefix="动作" value={clip} onChange={update} />
            <div className="two-fields">
              <Field label="源偏移">
                <NumberInput
                  value={clip.sourceOffset}
                  min={0}
                  max={86400}
                  suffix="s"
                  label="动作源偏移"
                  onChange={(sourceOffset) => update({ sourceOffset })}
                />
              </Field>
              <Field label="速度">
                <NumberInput
                  value={clip.speed}
                  min={-16}
                  max={16}
                  step={0.1}
                  suffix="x"
                  label="动作速度"
                  onChange={(speed) => update({ speed })}
                />
              </Field>
            </div>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  checked={clip.loop}
                  onChange={(event) => update({ loop: event.target.checked })}
                />
                循环
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={clip.mirror}
                  onChange={(event) => update({ mirror: event.target.checked })}
                />
                镜像
              </label>
              <IconButton
                icon={Copy}
                label="复制动作片段"
                onClick={() => {
                  const id = crypto.randomUUID();
                  editor.run((latest) => {
                    const current = currentAnimation(latest, object.id).clips.find(
                      (item) => item.id === clip.id,
                    );
                    if (!current) throw new Error('动作片段已变化，请重新选择');
                    return [
                      {
                        type: 'actor.clip.set',
                        payload: {
                          id: object.id,
                          clip: {
                            ...current,
                            id,
                            start: current.end,
                            end: current.end + current.end - current.start,
                          },
                        },
                      },
                    ];
                  });
                  setSelected(id);
                }}
              />
              <IconButton
                icon={Trash2}
                label="删除动作片段"
                onClick={() => editor.run('actor.clip.delete', { id: object.id, itemId: clip.id })}
              />
            </div>
          </>
        )}
      </fieldset>
    </Section>
  );
}

function JointKeys({ object, editor, time, project }: Props) {
  const keys = object.actor?.animation?.jointKeys ?? [];
  const [selected, setSelected] = useState('');
  const [newJoint, setNewJoint] = useState<ActorJointName>('rightElbow');
  const key = keys.find((item) => item.id === selected) ?? keys[0];
  const update = (patch: Partial<ActorJointKey> | ((current: ActorJointKey) => Partial<ActorJointKey>)) => {
    if (!key) return;
    editor.run((latest) => {
      const current = currentAnimation(latest, object.id).jointKeys.find((item) => item.id === key.id);
      if (!current) throw new Error('关节关键帧已变化，请重新选择');
      return [
        {
          type: 'actor.joint-key.set',
          payload: {
            id: object.id,
            keyframe: { ...current, ...(typeof patch === 'function' ? patch(current) : patch) },
          },
        },
      ];
    });
  };
  const add = () => {
    const at = Math.round(time * project.settings.fps) / project.settings.fps;
    const existing = keys.find((item) => item.joint === newJoint && Math.abs(item.time - at) < 1e-8);
    if (existing) {
      setSelected(existing.id);
      return;
    }
    const id = crypto.randomUUID();
    editor.run('actor.joint-key.set', {
      id: object.id,
      keyframe: { id, joint: newJoint, time: at, rotation: [0, 0, 0], easing: 'linear' },
    });
    setSelected(id);
  };
  return (
    <Section title="关节关键帧">
      <fieldset disabled={object.locked || editor.busy}>
        <div className="row">
          <select
            aria-label="新关键帧关节"
            value={newJoint}
            onChange={(event) => setNewJoint(event.target.value as ActorJointName)}
          >
            {actorJointNames.map((joint) => (
              <option key={joint} value={joint}>
                {actorJointLabels[joint]}
              </option>
            ))}
          </select>
          <IconButton icon={Plus} label="添加关节关键帧" onClick={add} />
        </div>
        {key && (
          <>
            <Field label="关键帧">
              <select
                aria-label="关节关键帧"
                value={key.id}
                onChange={(event) => setSelected(event.target.value)}
              >
                {[...keys]
                  .sort((a, b) => a.time - b.time)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {actorJointLabels[item.joint]} / {item.time.toFixed(3)} s
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="时间">
              <NumberInput
                value={key.time}
                min={0}
                max={86400}
                step={1 / project.settings.fps}
                suffix="s"
                label="关节关键帧时间"
                onChange={(time) => update({ time })}
              />
            </Field>
            <VectorInput
              label="关节偏转"
              value={key.rotation}
              onChange={(rotation) => update({ rotation })}
              onAxisChange={(axis, value) =>
                update((current) => {
                  const rotation = [...current.rotation] as Vec3;
                  rotation[axis] = value;
                  return { rotation };
                })
              }
            />
            {key.joint === 'hips' && (
              <VectorInput
                label="骨盆位移"
                value={key.hipsOffset ?? [0, 0, 0]}
                onChange={(hipsOffset) => update({ hipsOffset })}
                onAxisChange={(axis, value) =>
                  update((current) => {
                    const hipsOffset = [...(current.hipsOffset ?? [0, 0, 0])] as Vec3;
                    hipsOffset[axis] = value;
                    return { hipsOffset };
                  })
                }
              />
            )}
            <Field label="插值">
              <select
                aria-label="关节关键帧插值"
                value={key.easing}
                onChange={(event) => update({ easing: event.target.value as ActorJointKey['easing'] })}
              >
                <option value="linear">线性</option>
                <option value="smooth">平滑</option>
              </select>
            </Field>
            <IconButton
              icon={Trash2}
              label="删除关节关键帧"
              onClick={() => editor.run('actor.joint-key.delete', { id: object.id, itemId: key.id })}
            />
          </>
        )}
      </fieldset>
    </Section>
  );
}

function ContactConstraints({ object, project, editor, time, diagnostics }: Props) {
  const constraints = object.actor?.animation?.constraints ?? [];
  const [selected, setSelected] = useState('');
  const [effector, setEffector] = useState<ActorEffector>('rightHand');
  const constraint = constraints.find((item) => item.id === selected) ?? constraints[0];
  const result = diagnostics?.find((item) => item.id === constraint?.id);
  const update = (
    patch: Partial<ActorConstraint> | ((current: ActorConstraint) => Partial<ActorConstraint>),
  ) => {
    if (!constraint) return;
    editor.run((latest) => {
      const current = currentAnimation(latest, object.id).constraints.find(
        (item) => item.id === constraint.id,
      );
      if (!current) throw new Error('接触约束已变化，请重新选择');
      return [
        {
          type: 'actor.constraint.set',
          payload: {
            id: object.id,
            constraint: { ...current, ...(typeof patch === 'function' ? patch(current) : patch) },
          },
        },
      ];
    });
  };
  const add = () => {
    const id = crypto.randomUUID();
    const start = Math.min(time, 86399);
    editor.run('actor.constraint.set', {
      id: object.id,
      constraint: {
        id,
        effector,
        start,
        end: start + 1,
        fadeIn: 0.1,
        fadeOut: 0.1,
        weight: 1,
        target: { kind: 'world', position: [0, effector.endsWith('Foot') ? 0.075 : 1.2, 0.25] },
        iterations: 48,
        tolerance: 0.02,
      },
    });
    setSelected(id);
  };
  const targetVector =
    constraint?.target.kind === 'world' ? constraint.target.position : constraint?.target.offset;
  const updateTargetVector = (axis: number | null, value: number | Vec3) =>
    update((current) => {
      const vector = [
        ...(current.target.kind === 'world' ? current.target.position : current.target.offset),
      ] as Vec3;
      if (axis !== null) vector[axis] = value as number;
      const next = axis === null ? (value as Vec3) : vector;
      return {
        target:
          current.target.kind === 'world'
            ? { ...current.target, position: next }
            : { ...current.target, offset: next },
      };
    });
  return (
    <Section title="手脚接触">
      <fieldset disabled={object.locked || editor.busy}>
        <div className="row">
          <select
            aria-label="新接触部位"
            value={effector}
            onChange={(event) => setEffector(event.target.value as ActorEffector)}
          >
            {Object.entries(effectorLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <IconButton icon={Plus} label="添加接触约束" onClick={add} />
        </div>
        {constraint && (
          <>
            <Field label="约束">
              <select
                aria-label="接触约束"
                value={constraint.id}
                onChange={(event) => setSelected(event.target.value)}
              >
                {constraints.map((item) => (
                  <option key={item.id} value={item.id}>
                    {effectorLabels[item.effector]} / {item.start.toFixed(2)} - {item.end.toFixed(2)} s
                  </option>
                ))}
              </select>
            </Field>
            <Field label="部位">
              <select
                aria-label="接触部位"
                value={constraint.effector}
                onChange={(event) => update({ effector: event.target.value as ActorEffector })}
              >
                {Object.entries(effectorLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <IntervalFields prefix="接触" value={constraint} onChange={update} />
            <Field label="目标类型">
              <select
                aria-label="接触目标类型"
                value={constraint.target.kind}
                onChange={(event) =>
                  update({
                    target:
                      event.target.value === 'world'
                        ? { kind: 'world', position: result?.target ?? [0, 1.2, 0.25] }
                        : {
                            kind: 'object',
                            objectId: project.objects.find((item) => item.id !== object.id)?.id ?? object.id,
                            bone: 'root',
                            offset: [0, 0, 0],
                          },
                  })
                }
              >
                <option value="world">世界坐标</option>
                <option value="object">对象 / 骨骼</option>
              </select>
            </Field>
            {constraint.target.kind === 'object' && (
              <>
                <Field label="目标对象">
                  <select
                    aria-label="接触目标对象"
                    value={constraint.target.objectId}
                    onChange={(event) => {
                      const objectId = event.target.value;
                      update((current) => ({
                        target:
                          current.target.kind === 'object'
                            ? { ...current.target, objectId, bone: 'root' }
                            : { kind: 'object', objectId, bone: 'root', offset: [0, 0, 0] },
                      }));
                    }}
                  >
                    {project.objects.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {project.objects.find(
                  (item) =>
                    item.id === (constraint.target.kind === 'object' ? constraint.target.objectId : ''),
                )?.actor && (
                  <Field label="目标骨骼">
                    <select
                      aria-label="接触目标骨骼"
                      value={constraint.target.bone ?? 'root'}
                      onChange={(event) => {
                        const bone = event.target.value as ActorJointName | 'root';
                        update((current) => ({
                          target:
                            current.target.kind === 'object' ? { ...current.target, bone } : current.target,
                        }));
                      }}
                    >
                      <option value="root">对象原点</option>
                      {actorJointNames.map((joint) => (
                        <option key={joint} value={joint}>
                          {actorJointLabels[joint]}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </>
            )}
            <VectorInput
              label={constraint.target.kind === 'world' ? '接触世界坐标' : '目标局部偏移'}
              value={targetVector!}
              onChange={(value) => updateTargetVector(null, value)}
              onAxisChange={updateTargetVector}
            />
            <div className="two-fields">
              <Field label="迭代次数">
                <NumberInput
                  value={constraint.iterations}
                  min={1}
                  max={128}
                  step={1}
                  label="接触迭代次数"
                  onChange={(iterations) => update({ iterations: Math.floor(iterations) })}
                />
              </Field>
              <Field label="误差容限">
                <NumberInput
                  value={constraint.tolerance}
                  min={0.0001}
                  max={1}
                  step={0.001}
                  suffix="m"
                  label="接触误差容限"
                  onChange={(tolerance) => update({ tolerance })}
                />
              </Field>
            </div>
            {result && (
              <div className="two-fields">
                <Field label="状态">
                  <output>
                    {
                      (
                        {
                          inactive: '未启用',
                          'missing-target': '目标缺失',
                          unreachable: '超出范围',
                          solved: '已接触',
                          partial: '未达到目标',
                        } as const
                      )[result.status]
                    }
                  </output>
                </Field>
                <Field label="接触误差">
                  <output>{result.error === null ? '-' : `${result.error.toFixed(3)} m`}</output>
                </Field>
              </div>
            )}
            <IconButton
              icon={Trash2}
              label="删除接触约束"
              onClick={() => editor.run('actor.constraint.delete', { id: object.id, itemId: constraint.id })}
            />
          </>
        )}
      </fieldset>
    </Section>
  );
}

export function ActorAnimationPanel(props: Props) {
  if (!props.object.actor) return null;
  return (
    <>
      <ActionClips {...props} />
      <JointKeys {...props} />
      <ContactConstraints {...props} />
    </>
  );
}
