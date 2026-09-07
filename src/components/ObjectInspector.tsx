import { useEffect, useState } from 'react';
import { DiamondPlus, LockKeyhole, Trash2, UnlockKeyhole } from 'lucide-react';
import type { ActorPose, Attachment, ObjectKeyframe, Project, SceneObject, Vec3 } from '../../shared/types';
import { sampleObject } from '../../shared/timeline';
import { ModelingPanel } from './ModelingPanel';
import { ModelAssetPanel } from './ModelAssetPanel';
import { ActorAnimationPanel } from './ActorAnimationPanel';
import { FacePanel } from './FacePanel';
import type { ActorConstraintResult } from '../../shared/actor-animation';
import { MotionPanel } from './MotionPanel';
import { PhysicsPanel } from './PhysicsPanel';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, NumberInput, Section, TextInput, VectorInput, timecode } from './Controls';

export function ObjectInspector({
  object,
  project,
  sourceTime,
  editor,
  onSeek,
  getConstraints,
}: {
  object: SceneObject;
  project: Project;
  sourceTime: number;
  editor: EditorActions;
  onSeek: (time: number) => void;
  getConstraints?: (id: string) => ActorConstraintResult[];
}) {
  const [mode, setMode] = useState<'base' | 'keyframe'>('base');
  const [diagnostics, setDiagnostics] = useState<ActorConstraintResult[]>([]);
  useEffect(() => {
    if (!object.actor || !getConstraints) return;
    const refresh = () => setDiagnostics(getConstraints(object.id));
    const first = requestAnimationFrame(refresh);
    const interval = setInterval(refresh, 200);
    return () => {
      cancelAnimationFrame(first);
      clearInterval(interval);
    };
  }, [object.id, object.actor, getConstraints]);
  const current = mode === 'keyframe' ? sampleObject(object, sourceTime) : object;
  const latestObject = (latest: Project) => {
    const target = latest.objects.find((item) => item.id === object.id);
    if (!target) throw new Error('对象已删除，未执行编辑');
    return target;
  };
  const baseUpdate = (patch: Partial<SceneObject> | ((target: SceneObject) => Partial<SceneObject>)) =>
    editor.run((latest) => [
      {
        type: 'object.update',
        payload: { id: object.id, patch: typeof patch === 'function' ? patch(latestObject(latest)) : patch },
      },
    ]);
  const keyframe = (
    input: Partial<ObjectKeyframe> | ((target: SceneObject) => Partial<ObjectKeyframe>) = {},
  ) => {
    editor.run((latest) => {
      const target = latestObject(latest);
      const evaluated = sampleObject(target, sourceTime);
      const existing = target.keyframes.find(
        (k) => Math.abs(k.time - sourceTime) < 0.5 / latest.settings.fps,
      );
      const patch = typeof input === 'function' ? input(evaluated) : input;
      return [
        {
          type: 'object.keyframe.set',
          payload: {
            id: object.id,
            keyframe: {
              ...existing,
              id: existing?.id ?? crypto.randomUUID(),
              time: sourceTime,
              position: evaluated.position,
              rotation: evaluated.rotation,
              scale: evaluated.scale,
              ...(evaluated.actor
                ? { action: evaluated.actor.action, lookAtId: evaluated.actor.lookAtId }
                : {}),
              easing: existing?.easing ?? 'linear',
              ...patch,
              ...(evaluated.actor ? { pose: { ...evaluated.actor.pose, ...patch.pose } } : {}),
            },
          },
        },
      ];
    });
  };
  const transform = (patch: Partial<ObjectKeyframe>) =>
    mode === 'keyframe' ? keyframe(patch) : baseUpdate(patch as Partial<SceneObject>);
  const attach = (attachment: Attachment | null) =>
    mode === 'keyframe' ? keyframe({ attachment }) : baseUpdate({ attachment });
  const pose = (key: keyof ActorPose, value: number) => {
    if (!current.actor) return;
    if (mode === 'keyframe') keyframe({ pose: { [key]: value } });
    else
      baseUpdate((target) => ({
        actor: { ...target.actor!, pose: { ...target.actor!.pose, [key]: value } },
      }));
  };
  const vectorAxis = (
    field: 'position' | 'rotation' | 'scale' | 'dimensions',
    axis: number,
    value: number,
  ) => {
    const patch = (target: SceneObject) => {
      const vector = [...target[field]] as Vec3;
      vector[axis] = value;
      return { [field]: vector };
    };
    if (field === 'dimensions' || mode === 'base') baseUpdate(patch);
    else keyframe(patch);
  };
  const attachmentAxis = (axis: number, value: number) => {
    const patch = (target: SceneObject) => {
      if (!target.attachment) throw new Error('道具已解除附着，未修改附着偏移');
      const offset = [...target.attachment.offset] as Vec3;
      offset[axis] = value;
      return { attachment: { ...target.attachment, offset } };
    };
    if (mode === 'base') baseUpdate(patch);
    else keyframe(patch);
  };
  return (
    <>
      {object.type === 'model' && <ModelAssetPanel object={object} project={project} editor={editor} />}
      <Section
        title="对象"
        extra={
          <IconButton
            icon={object.locked ? LockKeyhole : UnlockKeyhole}
            label={object.locked ? '解锁对象' : '锁定对象'}
            onClick={() => baseUpdate({ locked: !object.locked })}
          />
        }
      >
        <fieldset disabled={object.locked}>
          <Field label="名称">
            <TextInput value={object.name} label="对象名称" onChange={(name) => baseUpdate({ name })} />
          </Field>
          <Field label="父级">
            <select
              aria-label="对象父级"
              value={object.parentId ?? ''}
              onChange={(e) => baseUpdate({ parentId: e.target.value || null })}
            >
              <option value="">场景根节点</option>
              {project.objects
                .filter((o) => o.id !== object.id && o.type === 'group')
                .map((o) => (
                  <option value={o.id} key={o.id}>
                    {o.name}
                  </option>
                ))}
            </select>
          </Field>
        </fieldset>
      </Section>
      <Section
        title="变换"
        extra={
          <IconButton
            icon={DiamondPlus}
            label="在当前时间添加对象关键帧"
            disabled={object.locked}
            onClick={() => keyframe()}
          />
        }
      >
        <div className="segmented compact">
          <button className={mode === 'base' ? 'active' : ''} onClick={() => setMode('base')}>
            基础
          </button>
          <button className={mode === 'keyframe' ? 'active' : ''} onClick={() => setMode('keyframe')}>
            当前帧
          </button>
        </div>
        <fieldset disabled={object.locked}>
          <VectorInput
            label="位置 · m"
            value={current.position}
            onChange={(position) => transform({ position })}
            onAxisChange={(axis, value) => vectorAxis('position', axis, value)}
          />
          <VectorInput
            label="旋转 · °"
            value={current.rotation}
            onChange={(rotation) => transform({ rotation })}
            onAxisChange={(axis, value) => vectorAxis('rotation', axis, value)}
            step={1}
          />
          <VectorInput
            label="缩放"
            value={current.scale}
            onChange={(scale) => transform({ scale })}
            onAxisChange={(axis, value) => vectorAxis('scale', axis, value)}
          />
          {!object.modeling && (
            <VectorInput
              label="尺寸 · m"
              value={object.dimensions}
              onChange={(dimensions) => baseUpdate({ dimensions })}
              onAxisChange={(axis, value) => vectorAxis('dimensions', axis, value)}
            />
          )}
          <Field label="白模色阶">
            <div className="swatches">
              {['#f2f1ee', '#d9dcda', '#adb5b5', '#767d80', '#42494a'].map((tone) => (
                <button
                  key={tone}
                  aria-label={`材质 ${tone}`}
                  title={tone}
                  className={object.tone === tone ? 'active' : ''}
                  style={{ background: tone }}
                  onClick={() => baseUpdate({ tone })}
                />
              ))}
            </div>
          </Field>
        </fieldset>
      </Section>
      {!current.actor && object.type !== 'group' && !object.vehicle && !object.effect && (
        <ModelingPanel object={object} project={project} editor={editor} />
      )}
      <MotionPanel object={object} editor={editor} sourceTime={sourceTime} />
      <PhysicsPanel object={object} project={project} editor={editor} sourceTime={sourceTime} />
      {current.actor && (
        <Section title="表演与注视">
          <fieldset disabled={object.locked}>
            <Field label="动作">
              <select
                aria-label="角色动作"
                value={current.actor.action}
                onChange={(e) => {
                  const action = e.target.value as NonNullable<SceneObject['actor']>['action'];
                  if (mode === 'keyframe') keyframe({ action });
                  else baseUpdate((target) => ({ actor: { ...target.actor!, action } }));
                }}
              >
                <option value="idle">站立</option>
                <option value="walk">行走</option>
                <option value="sit">坐姿</option>
                <option value="talk">说话</option>
              </select>
            </Field>
            <Field label="注视目标">
              <select
                value={current.actor.lookAtId ?? ''}
                onChange={(e) => {
                  const lookAtId = e.target.value || null;
                  if (mode === 'keyframe') keyframe({ lookAtId });
                  else baseUpdate((target) => ({ actor: { ...target.actor!, lookAtId } }));
                }}
              >
                <option value="">自由朝向</option>
                {project.objects
                  .filter((o) => o.id !== object.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
              </select>
            </Field>
            {(
              [
                ['headPitch', '头部俯仰'],
                ['headYaw', '头部转向'],
                ['leftArm', '左臂'],
                ['rightArm', '右臂'],
                ['leftLeg', '左腿'],
                ['rightLeg', '右腿'],
              ] as [keyof ActorPose, string][]
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <NumberInput
                  value={current.actor!.pose[key]}
                  onChange={(value) => pose(key, value)}
                  min={-170}
                  max={170}
                  step={5}
                  suffix="°"
                  label={label}
                />
              </Field>
            ))}
          </fieldset>
        </Section>
      )}
      {object.actor && (
        <ActorAnimationPanel
          object={object}
          project={project}
          editor={editor}
          time={sourceTime}
          diagnostics={diagnostics}
        />
      )}
      {(object.actor || object.type === 'model') && (
        <FacePanel object={object} project={project} time={sourceTime} editor={editor} onSeek={onSeek} />
      )}
      {object.type !== 'actor' && (
        <Section title="道具附着" defaultOpen={!!current.attachment}>
          <fieldset disabled={object.locked}>
            <Field label="角色">
              <select
                value={current.attachment?.objectId ?? ''}
                onChange={(e) =>
                  attach(
                    e.target.value
                      ? { objectId: e.target.value, bone: 'rightHand', offset: [0, 0, 0] }
                      : null,
                  )
                }
              >
                <option value="">无</option>
                {project.objects
                  .filter((o) => o.type === 'actor' && o.id !== object.id)
                  .map((o) => (
                    <option value={o.id} key={o.id}>
                      {o.name}
                    </option>
                  ))}
              </select>
            </Field>
            {current.attachment && (
              <>
                <Field label="附着位置">
                  <select
                    value={current.attachment.bone}
                    onChange={(e) =>
                      attach({ ...current.attachment!, bone: e.target.value as Attachment['bone'] })
                    }
                  >
                    <option value="rightHand">右手</option>
                    <option value="leftHand">左手</option>
                    <option value="head">头部</option>
                    <option value="root">根节点</option>
                  </select>
                </Field>
                <VectorInput
                  label="偏移"
                  value={current.attachment.offset}
                  onChange={(offset) => attach({ ...current.attachment!, offset })}
                  onAxisChange={attachmentAxis}
                />
              </>
            )}
          </fieldset>
        </Section>
      )}
      <Section title="对象关键帧">
        <div className="keyframe-list">
          {object.keyframes.length === 0 && <span className="muted small">无关键帧</span>}
          {object.keyframes.map((frame) => (
            <div key={frame.id}>
              <button
                className="keyframe-link"
                onClick={() => {
                  onSeek(frame.time);
                  setMode('keyframe');
                }}
              >
                <span className="diamond" />
                {timecode(frame.time, project.settings.fps)}
              </button>
              <select
                aria-label="关键帧插值"
                disabled={object.locked}
                value={frame.easing ?? 'linear'}
                onChange={(e) =>
                  editor.run('object.keyframe.set', {
                    id: object.id,
                    keyframe: { ...frame, easing: e.target.value },
                  })
                }
              >
                <option value="linear">线性</option>
                <option value="smooth">缓入缓出</option>
                <option value="step">保持</option>
              </select>
              <IconButton
                icon={Trash2}
                label="删除对象关键帧"
                disabled={object.locked}
                onClick={() => editor.run('object.keyframe.delete', { id: object.id, keyframeId: frame.id })}
              />
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
