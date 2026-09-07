import { Camera, DiamondPlus, LockKeyhole, Trash2, UnlockKeyhole } from 'lucide-react';
import { useWorkspaceInspectorMode } from '../workspace/Surfaces';
import type { Project, SequenceClip, Shot, ShotCamera, Vec3 } from '../../shared/types';
import { sampleCamera } from '../../shared/timeline';
import type { CameraPresetKind } from '../../shared/camera-presets';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, NumberInput, Section, TextInput, VectorInput, timecode } from './Controls';
import { CameraMotionPanel } from './CameraMotionPanel';
import { ShotBindingPanel } from './ShotBindingPanel';
import { aspectComposition, type CameraComposition } from '../../shared/camera-optics';
import { CameraOpticsPanel } from './CameraOpticsPanel';
import { ShotLightingPanel } from './LightingPlansPanel';

interface Props {
  project: Project;
  camera: ShotCamera;
  shot?: Shot | null;
  clip?: SequenceClip | null;
  editor: EditorActions;
  sourceTime: number;
  subjectTime?: number;
  onSeek: (time: number) => void;
  getView: () => { position: Vec3; target: Vec3; fov: number } | undefined;
  getTarget?: (id: string) => Vec3 | undefined;
}

export function CameraInspector({
  project,
  camera,
  shot,
  clip,
  editor,
  sourceTime,
  subjectTime = sourceTime,
  onSeek,
  getView,
}: Props) {
  const [mode, setMode] = useWorkspaceInspectorMode();
  const aspect = project.settings.aspect;
  const editingCamera = aspectComposition(camera, aspect);
  const current = mode === 'base' ? editingCamera : sampleCamera(camera, sourceTime, aspect);
  const shotLocked = project.shots.some((item) => item.cameraId === camera.id && item.locked);
  const locked = camera.locked || shotLocked;
  const update = (patch: Partial<ShotCamera>) => {
    if (mode === 'base') editor.run((latest) => [baseCommand(latest, patch)]);
    else setFrame(patch);
  };
  const setFrame = (patch: Partial<ShotCamera> = {}) => {
    editor.run((latest) => [frameCommand(latest, patch)]);
  };
  const latestCamera = (latest: Project) => {
    const target = latest.cameras.find((item) => item.id === camera.id);
    if (!target) throw new Error('摄影机已删除，未执行编辑');
    return target;
  };
  const frameCommand = (latest: Project, patch: Partial<ShotCamera>) => {
    const target = latestCamera(latest);
    const view = aspectComposition(target, aspect);
    const sampled = sampleCamera(target, sourceTime, aspect);
    const existing = view.keyframes.find(
      (frame) => Math.abs(frame.time - sourceTime) < 0.5 / latest.settings.fps,
    );
    return {
      type: 'camera.keyframe.set',
      payload: {
        id: camera.id,
        ...(target.compositions?.[aspect] ? { aspect } : {}),
        keyframe: {
          ...existing,
          id: existing?.id ?? crypto.randomUUID(),
          time: sourceTime,
          position: sampled.position,
          target: sampled.target,
          fov: sampled.fov,
          easing: existing?.easing ?? 'smooth',
          ...patch,
        },
      },
    };
  };
  const baseCommand = (latest: Project, patch: Partial<CameraComposition>) => {
    const target = latestCamera(latest);
    const composition = target.compositions?.[aspect];
    return composition
      ? {
          type: 'camera.composition.set',
          payload: { id: camera.id, aspect, composition: { ...composition, ...patch } },
        }
      : { type: 'camera.update', payload: { id: camera.id, patch } };
  };
  const vectorAxis = (field: 'position' | 'target', axis: number, value: number) => {
    editor.run((latest) => {
      const target = latestCamera(latest);
      const sampled =
        mode === 'base' ? aspectComposition(target, aspect) : sampleCamera(target, sourceTime, aspect);
      const vector = [...sampled[field]] as Vec3;
      vector[axis] = value;
      const patch = { [field]: vector };
      return [mode === 'base' ? baseCommand(latest, patch) : frameCommand(latest, patch)];
    });
  };
  const preset = (kind: CameraPresetKind) =>
    editor.run('camera.preset', {
      id: camera.id,
      preset: kind,
      ...(shot ? { shotId: shot.id } : {}),
      sourceTime: subjectTime,
      cameraTime: sourceTime,
      mode,
      ...(camera.compositions?.[aspect] ? { aspect } : {}),
    });
  const referencedClips = project.sequences
    .flatMap((sequence) => sequence.clips)
    .filter((clip) => clip.shotId === shot?.id);
  const maxSourceIn = shot
    ? Math.min(shot.sourceOut - 1 / project.settings.fps, ...referencedClips.map((clip) => clip.sourceIn))
    : 0;
  const minSourceOut = shot
    ? Math.max(shot.sourceIn + 1 / project.settings.fps, ...referencedClips.map((clip) => clip.sourceOut))
    : 0;
  const shotUpdate = (patch: Partial<Shot>) => {
    if (shot) editor.run('shot.update', { id: shot.id, patch });
  };

  return (
    <>
      {shot && <ShotBindingPanel project={project} shot={shot} editor={editor} />}
      {shot && <ShotLightingPanel project={project} shot={shot} editor={editor} />}
      <Section
        title="摄影机"
        extra={
          <IconButton
            icon={locked ? LockKeyhole : UnlockKeyhole}
            label={shotLocked ? '关联镜头已锁定' : camera.locked ? '解锁摄影机' : '锁定摄影机'}
            disabled={shotLocked}
            onClick={() => editor.run('camera.update', { id: camera.id, patch: { locked: !camera.locked } })}
          />
        }
      >
        <fieldset disabled={locked}>
          <Field label="名称">
            <TextInput
              value={camera.name}
              onChange={(name) => editor.run('camera.update', { id: camera.id, patch: { name } })}
            />
          </Field>
        </fieldset>
        <div className="segmented compact">
          <button className={mode === 'base' ? 'active' : ''} onClick={() => setMode('base')}>
            基础机位
          </button>
          <button className={mode === 'keyframe' ? 'active' : ''} onClick={() => setMode('keyframe')}>
            当前帧
          </button>
        </div>
        <fieldset disabled={locked}>
          <VectorInput
            label="机位 · m"
            value={current.position}
            onChange={(position) => update({ position })}
            onAxisChange={(axis, value) => vectorAxis('position', axis, value)}
          />
          <VectorInput
            label="朝向目标 · m"
            value={current.target}
            onChange={(target) => update({ target })}
            onAxisChange={(axis, value) => vectorAxis('target', axis, value)}
          />
          <Field label="视场角">
            <NumberInput
              value={current.fov}
              onChange={(fov) => update({ fov })}
              min={5}
              max={150}
              step={1}
              suffix="°"
            />
          </Field>
          <div className="lens-readout">
            <span>35 mm 等效焦距</span>
            <b>{Math.round(12 / Math.tan((current.fov * Math.PI) / 360))} mm</b>
          </div>
          <button
            className="text-button full-width"
            onClick={() => {
              const view = getView();
              if (view) update(view);
            }}
          >
            <Camera size={14} />
            使用自由视角机位
          </button>
        </fieldset>
      </Section>
      <CameraMotionPanel
        key={camera.id}
        project={project}
        camera={camera}
        shot={shot}
        clip={clip}
        sourceTime={sourceTime}
        locked={locked}
        editor={editor}
      />
      <CameraOpticsPanel
        camera={camera}
        project={project}
        editor={editor}
        time={sourceTime}
        onSeek={onSeek}
        locked={locked}
      />
      <Section title="构图预设">
        <div className="preset-grid">
          {[
            ['extreme_wide', '大远景'],
            ['wide', '全景'],
            ['medium', '中景'],
            ['close', '近景'],
            ['detail', '特写'],
            ['high', '俯拍'],
            ['low', '仰拍'],
            ['two_shot', '双人'],
            ['over_shoulder', '过肩'],
          ].map(([key, label]) => (
            <button key={key} onClick={() => preset(key as CameraPresetKind)} disabled={locked}>
              <Camera size={14} />
              {label}
            </button>
          ))}
        </div>
      </Section>
      {shot && (
        <Section title="镜头意图">
          <fieldset disabled={shot.locked}>
            <Field label="镜头名称">
              <TextInput value={shot.name} label="镜头名称" onChange={(name) => shotUpdate({ name })} />
            </Field>
            <div className="two-fields">
              <Field label="拍摄入点">
                <NumberInput
                  label="拍摄入点"
                  value={shot.sourceIn}
                  min={0}
                  max={maxSourceIn}
                  step={1 / project.settings.fps}
                  onChange={(sourceIn) => shotUpdate({ sourceIn })}
                />
              </Field>
              <Field label="拍摄出点">
                <NumberInput
                  label="拍摄出点"
                  value={shot.sourceOut}
                  min={minSourceOut}
                  max={86400}
                  step={1 / project.settings.fps}
                  onChange={(sourceOut) => shotUpdate({ sourceOut })}
                />
              </Field>
            </div>
            <Field label="叙事主体">
              <select
                value={shot.subjectIds[0] ?? ''}
                onChange={(event) =>
                  shotUpdate({ subjectIds: event.target.value ? [event.target.value] : [] })
                }
              >
                <option value="">未指定</option>
                {project.objects.map((object) => (
                  <option value={object.id} key={object.id}>
                    {object.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="剧情节拍">
              <select
                value={shot.beatId ?? ''}
                onChange={(event) => shotUpdate({ beatId: event.target.value || null })}
              >
                <option value="">未关联</option>
                {project.beats.map((beat) => (
                  <option value={beat.id} key={beat.id}>
                    {beat.label}
                  </option>
                ))}
              </select>
            </Field>
            <TextInput
              multiline
              label="镜头叙事意图"
              value={shot.intent}
              onChange={(intent) => shotUpdate({ intent })}
            />
          </fieldset>
          <Field label="锁定镜头">
            <input
              type="checkbox"
              checked={shot.locked}
              onChange={(event) => shotUpdate({ locked: event.target.checked })}
            />
          </Field>
        </Section>
      )}
      <Section
        title="摄影机关键帧"
        extra={
          <IconButton
            icon={DiamondPlus}
            label="在当前时间添加摄影机关键帧"
            disabled={locked}
            onClick={() => setFrame()}
          />
        }
      >
        <div className="keyframe-list">
          {!editingCamera.keyframes.length && <span className="muted small">固定机位</span>}
          {editingCamera.keyframes.map((frame) => (
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
                aria-label="运镜插值"
                disabled={locked}
                value={frame.easing}
                onChange={(event) =>
                  editor.run('camera.keyframe.set', {
                    id: camera.id,
                    ...(camera.compositions?.[aspect] ? { aspect } : {}),
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
                label="删除摄影机关键帧"
                disabled={locked}
                onClick={() =>
                  editor.run('camera.keyframe.delete', {
                    id: camera.id,
                    keyframeId: frame.id,
                    ...(camera.compositions?.[aspect] ? { aspect } : {}),
                  })
                }
              />
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
