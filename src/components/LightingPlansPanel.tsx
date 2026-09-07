import { useState } from 'react';
import { Copy, LockKeyhole, Plus, Trash2, UnlockKeyhole } from 'lucide-react';
import {
  lightingPlanUsage,
  resolveLighting,
  sceneLighting,
  type Lighting,
} from '../../shared/lighting-plans';
import type { Project, Shot } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, NumberInput, Section, TextInput } from './Controls';
import './lighting-plans.css';

function shotIsLocked(project: Project, shot: Shot) {
  return (
    shot.locked ||
    project.sequences.some(
      (sequence) => sequence.locked && sequence.clips.some((clip) => clip.shotId === shot.id),
    )
  );
}

export function LightingPlansPanel({ project, editor }: { project: Project; editor: EditorActions }) {
  const [selectedId, setSelectedId] = useState(project.settings.lightingPlanId ?? '');
  const plans = project.lightingPlans ?? [];
  const selected = plans.find((plan) => plan.id === selectedId);
  const sceneId = project.production?.activeSceneId;
  const scene = project.production?.scenes.find((item) => item.id === sceneId);
  const lighting = selected?.lighting ?? project.settings.lighting;
  const usage = selected ? lightingPlanUsage(project, selected.id) : null;
  const affectedShots = selected
    ? usage!.shotIds
    : project.shots
        .filter(
          (shot) =>
            !shot.lightingPlanId &&
            (!sceneId || shot.sceneId === sceneId) &&
            !project.settings.lightingPlanId,
        )
        .map((shot) => shot.id);
  const affectedScenes = selected ? usage!.sceneIds : sceneId ? [sceneId] : [];
  const lockedReference =
    project.production?.scenes.some((item) => item.locked && affectedScenes.includes(item.id)) ||
    project.shots.some((shot) => affectedShots.includes(shot.id) && shotIsLocked(project, shot));
  const blocked = Boolean(selected?.locked || lockedReference || (!selected && scene?.locked));
  const inUse = Boolean(usage && (usage.workspace || usage.sceneIds.length || usage.directShotIds.length));
  const bindLocked = Boolean(
    scene?.locked ||
    project.shots.some(
      (shot) => !shot.lightingPlanId && (!sceneId || shot.sceneId === sceneId) && shotIsLocked(project, shot),
    ),
  );
  const create = async (duplicate = false) => {
    const id = `lighting-${crypto.randomUUID()}`;
    try {
      await editor.command(
        duplicate && selected ? 'lighting.plan.duplicate' : 'lighting.plan.create',
        duplicate && selected
          ? { id: selected.id, newId: id }
          : { id, name: `布光方案 ${String(plans.length + 1).padStart(2, '0')}`, lighting },
      );
      setSelectedId(id);
    } catch {
      /* The shared editor displays the structured command failure. */
    }
  };
  const change = (key: keyof Lighting, value: number) =>
    editor.run((latest) => {
      if (!selected)
        return [
          { type: 'project.settings', payload: { lighting: { ...latest.settings.lighting, [key]: value } } },
        ];
      const current = latest.lightingPlans?.find((plan) => plan.id === selected.id);
      if (!current) throw new Error('布光方案已删除');
      return [
        {
          type: 'lighting.plan.update',
          payload: { id: current.id, patch: { lighting: { ...current.lighting, [key]: value } } },
        },
      ];
    });
  return (
    <Section title="布光方案">
      <Field label="场景默认">
        <select
          aria-label="场景默认布光"
          disabled={bindLocked}
          value={project.settings.lightingPlanId ?? ''}
          onChange={(event) =>
            editor.run('lighting.scene.bind', {
              ...(sceneId ? { sceneId } : {}),
              planId: event.target.value || null,
            })
          }
        >
          <option value="">基础灯光</option>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="编辑方案">
        <select
          aria-label="编辑布光方案"
          value={selected?.id ?? ''}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          <option value="">基础灯光</option>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="lighting-actions">
        <IconButton icon={Plus} label="新建布光方案" disabled={editor.busy} onClick={() => void create()} />
        <IconButton
          icon={Copy}
          label="复制布光方案"
          disabled={!selected || editor.busy}
          onClick={() => void create(true)}
        />
        <IconButton
          icon={selected?.locked ? UnlockKeyhole : LockKeyhole}
          label={selected?.locked ? '解锁布光方案' : '锁定布光方案'}
          disabled={!selected || editor.busy}
          onClick={() =>
            selected &&
            editor.run('lighting.plan.update', { id: selected.id, patch: { locked: !selected.locked } })
          }
        />
        <IconButton
          icon={Trash2}
          label={inUse ? '布光方案仍被引用' : '删除布光方案'}
          disabled={!selected || selected.locked || inUse || editor.busy}
          onClick={() => selected && editor.run('lighting.plan.delete', { id: selected.id })}
        />
      </div>
      {selected && (
        <fieldset disabled={selected.locked}>
          <Field label="名称">
            <TextInput
              label="布光方案名称"
              value={selected.name}
              onChange={(name) => editor.run('lighting.plan.update', { id: selected.id, patch: { name } })}
            />
          </Field>
        </fieldset>
      )}
      <fieldset disabled={blocked} title={blocked ? '布光方案或受影响的场景、镜头已锁定' : undefined}>
        {(
          [
            ['intensity', '主光强度', 0, 10, 0.1],
            ['ambient', '环境光', 0, 5, 0.1],
            ['azimuth', '方位角', -360, 360, 5],
            ['elevation', '高度角', -90, 90, 5],
          ] as const
        ).map(([key, label, min, max, step]) => (
          <Field key={key} label={label}>
            <NumberInput
              label={`布光${label}`}
              value={lighting[key]}
              min={min}
              max={max}
              step={step}
              onChange={(value) => change(key, value)}
            />
          </Field>
        ))}
      </fieldset>
      <div className="muted" aria-label="布光影响范围">
        {selected
          ? `${usage!.sceneIds.length + Number(usage!.workspace)} 个场景 · ${usage!.shotIds.length} 个镜头`
          : `${affectedShots.length} 个镜头使用基础灯光`}
      </div>
      {affectedShots.length > 0 && (
        <ul className="lighting-usage">
          {project.shots
            .filter((shot) => affectedShots.includes(shot.id))
            .map((shot) => (
              <li key={shot.id}>{shot.name}</li>
            ))}
        </ul>
      )}
    </Section>
  );
}

export function ShotLightingPanel({
  project,
  shot,
  editor,
}: {
  project: Project;
  shot: Shot;
  editor: EditorActions;
}) {
  const inherited = sceneLighting(project, shot.sceneId);
  const inheritedName =
    project.lightingPlans?.find((plan) => plan.id === inherited.planId)?.name ?? '基础灯光';
  const lighting = resolveLighting(project, shot);
  return (
    <Section title="镜头布光">
      <Field label="方案">
        <select
          aria-label="镜头布光方案"
          value={shot.lightingPlanId ?? ''}
          disabled={shotIsLocked(project, shot)}
          onChange={(event) =>
            editor.run('lighting.shot.bind', { shotId: shot.id, planId: event.target.value || null })
          }
        >
          <option value="">场景默认 · {inheritedName}</option>
          {project.lightingPlans?.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="muted">
        主光 {lighting.intensity} · 环境光 {lighting.ambient} · {lighting.azimuth}° / {lighting.elevation}°
      </div>
    </Section>
  );
}
