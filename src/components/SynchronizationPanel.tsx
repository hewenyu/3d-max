import { useState } from 'react';
import { Link2, LockKeyhole, Plus, Unlink, UnlockKeyhole } from 'lucide-react';
import {
  resolveTimingMember,
  timingAnchor,
  timingMembers,
  timingReferenceKey,
  type SynchronizationGroup,
  type SynchronizationProject,
  type TimingReference,
} from '../../shared/synchronization';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, NumberInput, Section, TextInput } from './Controls';

export function SynchronizationPanel({
  project,
  editor,
}: {
  project: SynchronizationProject;
  editor: EditorActions;
}) {
  const groups = project.synchronization ?? [];
  const [selected, setSelected] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [candidate, setCandidate] = useState('');
  const group = groups.find((item) => item.id === selected) ?? groups[0];
  const allMembers = timingMembers(project).filter((member) => member.clock === 'source');
  const occupied = new Set(groups.flatMap((item) => item.members.map(timingReferenceKey)));
  const available = allMembers.filter((member) => !occupied.has(timingReferenceKey(member.reference)));
  const pick = available.find((member) => timingReferenceKey(member.reference) === candidate) ?? available[0];
  const locked = Boolean(group?.locked || editor.busy);
  const update = (transform: (current: SynchronizationGroup) => SynchronizationGroup) => {
    if (!group) return;
    editor.run((latest) => {
      const current = (latest as SynchronizationProject).synchronization?.find(
        (item) => item.id === group.id,
      );
      if (!current) throw new Error('同步组已变化，请重新选择');
      return [{ type: 'sync.group.set', payload: { group: transform(current) } }];
    });
  };
  const create = () => {
    const members = available
      .filter((member) => chosen.includes(timingReferenceKey(member.reference)))
      .map((member) => member.reference);
    if (members.length < 2) return;
    const id = crypto.randomUUID();
    editor.run('sync.group.set', { group: { id, name: '新同步组', locked: false, members } });
    setSelected(id);
    setChosen([]);
  };
  return (
    <Section title="时间同步">
      {group && (
        <>
          <div className="row">
            <select
              aria-label="同步组"
              value={group.id}
              onChange={(event) => setSelected(event.target.value)}
            >
              {groups.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <IconButton
              icon={group.locked ? LockKeyhole : UnlockKeyhole}
              label={group.locked ? '解锁同步组' : '锁定同步组'}
              disabled={editor.busy}
              active={group.locked}
              onClick={() => update((current) => ({ ...current, locked: !current.locked }))}
            />
            <IconButton
              icon={Unlink}
              label="解除同步组"
              disabled={locked}
              onClick={() => editor.run('sync.group.delete', { id: group.id })}
            />
          </div>
          <fieldset disabled={locked}>
            <Field label="名称">
              <TextInput
                label="同步组名称"
                value={group.name}
                onChange={(name) => update((current) => ({ ...current, name }))}
              />
            </Field>
            <Field label="起始锚点">
              <NumberInput
                label="同步组起始锚点"
                value={Math.min(
                  ...group.members.flatMap((reference) => {
                    const member = resolveTimingMember(project, reference);
                    return member ? [timingAnchor(member)] : [];
                  }),
                )}
                min={0}
                max={86400}
                step={1 / project.settings.fps}
                suffix="s"
                onChange={(time) => editor.run('sync.group.move', { id: group.id, time })}
              />
            </Field>
            {group.members.map((reference) => {
              const member = resolveTimingMember(project, reference);
              if (!member) return null;
              const key = timingReferenceKey(reference);
              return (
                <div className="beat-item" key={key}>
                  <div className="row">
                    <Link2 size={14} />
                    <span className="truncate">{member.label}</span>
                    <IconButton
                      icon={Unlink}
                      label={`解除同步 ${member.label}`}
                      onClick={() => editor.run('sync.member.remove', { id: group.id, member: reference })}
                    />
                  </div>
                  <Field label="锚点">
                    <select
                      aria-label={`同步锚点 ${member.label}`}
                      value={reference.anchor}
                      onChange={(event) => {
                        const anchor = event.target.value as TimingReference['anchor'];
                        update((current) => ({
                          ...current,
                          members: current.members.map((item) =>
                            timingReferenceKey(item) === key ? { ...item, anchor } : item,
                          ),
                        }));
                      }}
                    >
                      <option value="start">开始 / {member.start.toFixed(3)} s</option>
                      <option value="end">结束 / {member.end.toFixed(3)} s</option>
                    </select>
                  </Field>
                </div>
              );
            })}
            {!!available.length && (
              <div className="row">
                <select
                  aria-label="加入同步的内容"
                  value={pick ? timingReferenceKey(pick.reference) : ''}
                  onChange={(event) => setCandidate(event.target.value)}
                >
                  {available.map((member) => (
                    <option
                      key={timingReferenceKey(member.reference)}
                      value={timingReferenceKey(member.reference)}
                    >
                      {member.label} / {member.start.toFixed(2)} s
                    </option>
                  ))}
                </select>
                <IconButton
                  icon={Plus}
                  label="加入同步组"
                  disabled={!pick || group.members.length >= 128}
                  onClick={() => {
                    if (pick)
                      update((current) => ({ ...current, members: [...current.members, pick.reference] }));
                  }}
                />
              </div>
            )}
          </fieldset>
        </>
      )}
      <details>
        <summary>新建同步组</summary>
        <fieldset disabled={editor.busy}>
          <div className="beats-list">
            {available.map((member) => {
              const key = timingReferenceKey(member.reference);
              return (
                <label className="row" key={key}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(key)}
                    aria-label={`关联 ${member.label}`}
                    onChange={(event) =>
                      setChosen((current) =>
                        event.target.checked ? [...current, key] : current.filter((item) => item !== key),
                      )
                    }
                  />
                  <span className="truncate">{member.label}</span>
                  <span className="muted">{member.start.toFixed(2)} s</span>
                </label>
              );
            })}
          </div>
          <button
            className="text-button full-width"
            disabled={
              available.filter((member) => chosen.includes(timingReferenceKey(member.reference))).length < 2
            }
            onClick={create}
          >
            <Link2 size={15} />
            建立同步
          </button>
        </fieldset>
      </details>
    </Section>
  );
}
