import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { MotionEvent } from '../../shared/motion';
import type { Command, Project, SceneObject } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, NumberInput, VectorInput } from './Controls';

const labels: Record<MotionEvent['kind'], string> = {
  collision: '碰撞',
  impact: '命中',
  projectile: '弹道',
  explosion: '爆炸',
};
const groupsFor = (project: Project | null, objectId: string, eventId: string) =>
  (project?.synchronization ?? []).filter((group) =>
    group.members.some(
      (member) => member.kind === 'motion-event' && member.objectId === objectId && member.id === eventId,
    ),
  );
function isLocked(object: SceneObject, project: Project | null): boolean {
  if (object.locked) return true;
  const parent = project?.objects.find((item) => item.id === object.parentId);
  return parent ? isLocked(parent, project) : false;
}

export function MotionEventsPanel({
  object,
  sourceTime,
  editor,
}: {
  object: SceneObject;
  sourceTime: number;
  editor: EditorActions;
}) {
  const [selected, setSelected] = useState('');
  const events = object.motionEvents ?? [];
  const event = events.find((item) => item.id === selected) ?? events[0];
  const locked = editor.busy || isLocked(object, editor.project);
  const groups = event ? groupsFor(editor.project, object.id, event.id) : [];
  const timingLocked = locked || groups.some((group) => group.locked);
  const change = (transform: (current: MotionEvent[]) => MotionEvent[], removedId?: string) =>
    editor.run((project) => {
      const current = project.objects.find((item) => item.id === object.id);
      if (!current) throw new Error('事件所属对象已变化，请重新选择');
      const commands: Command[] = [];
      if (removedId)
        for (const group of groupsFor(project, object.id, removedId)) {
          const member = group.members.find(
            (item) => item.kind === 'motion-event' && item.objectId === object.id && item.id === removedId,
          )!;
          commands.push({ type: 'sync.member.remove', payload: { id: group.id, member } });
        }
      commands.push({
        type: 'motion.events.set',
        payload: { id: object.id, events: transform(current.motionEvents ?? []) },
      });
      return commands;
    });
  const update = (patch: Partial<MotionEvent>) => {
    if (event)
      change((current) => {
        if (!current.some((item) => item.id === event.id)) throw new Error('事件已变化，请重新选择');
        return current.map((item) => (item.id === event.id ? { ...item, ...patch } : item));
      });
  };
  return (
    <div className="motion-event-editor" role="group" aria-label="运动事件">
      <div className="row motion-event-heading">
        <span>运动事件 · {events.length}</span>
        <IconButton
          icon={Plus}
          label="添加运动事件"
          disabled={locked || events.length >= 10000}
          onClick={() => {
            const id = crypto.randomUUID();
            change((current) => [
              ...current,
              { id, time: sourceTime, kind: 'collision', position: [0, 0, 0], strength: 1, duration: 0.5 },
            ]);
            setSelected(id);
          }}
        />
      </div>
      {event && (
        <>
          <div className="row">
            <select
              aria-label="运动事件"
              value={event.id}
              onChange={(input) => setSelected(input.target.value)}
            >
              {events.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.time.toFixed(3)} s / {labels[item.kind]}
                </option>
              ))}
            </select>
            <IconButton
              icon={Trash2}
              label="删除运动事件"
              disabled={timingLocked}
              onClick={() => change((current) => current.filter((item) => item.id !== event.id), event.id)}
            />
          </div>
          <fieldset className="motion-fields" disabled={locked}>
            <Field label="类型">
              <select
                aria-label="事件类型"
                value={event.kind}
                onChange={(input) => update({ kind: input.target.value as MotionEvent['kind'] })}
              >
                {Object.entries(labels).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="源时间">
              <NumberInput
                label="事件源时间"
                value={event.time}
                min={0}
                max={86400}
                step={1 / (editor.project?.settings.fps ?? 24)}
                disabled={timingLocked}
                suffix="s"
                onChange={(time) => update({ time })}
              />
            </Field>
            <Field label="时长">
              <NumberInput
                label="事件时长"
                value={event.duration}
                min={0.01}
                max={60}
                step={0.05}
                suffix="s"
                onChange={(duration) => update({ duration })}
              />
            </Field>
            <Field label="强度">
              <NumberInput
                label="事件强度"
                value={event.strength}
                min={0}
                max={1e12}
                onChange={(strength) => update({ strength })}
              />
            </Field>
            <Field label="关联目标">
              <select
                aria-label="事件关联目标"
                value={event.otherId ?? ''}
                onChange={(input) => update({ otherId: input.target.value || undefined })}
              >
                <option value="">无</option>
                {editor.project?.objects
                  .filter((item) => item.id !== object.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </Field>
            <VectorInput
              label="事件世界位置"
              value={event.position}
              onChange={(position) => update({ position })}
            />
          </fieldset>
        </>
      )}
    </div>
  );
}
