import { useEffect, useState } from 'react';
import { AudioLines, DiamondPlus, Download, Plus, ScanFace, Trash2, Upload } from 'lucide-react';
import {
  faceAnimationSchema,
  faceChannels,
  facePresets,
  morphChannelSchema,
  neutralFace,
  objectFace,
  sampleFace,
  visemeSchema,
  type FaceAnimation,
  type FaceChannel,
  type FaceClip,
  type FaceKey,
  type FaceValues,
  type MorphBinding,
} from '../../shared/face-animation';
import type { FaceAnalysisResult, MorphCatalog } from '../../shared/face-analysis';
import type { Project, SceneObject } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { api } from '../api';
import { Field, IconButton, NumberInput, Section, TextInput } from './Controls';
import './face.css';

const labels: Record<FaceChannel, string> = {
  jawOpen: '张口',
  smile: '微笑',
  frown: '嘴角下垂',
  pucker: '噘嘴',
  mouthWide: '嘴宽',
  upperLipRaise: '上唇抬起',
  lowerLipDown: '下唇下降',
  blinkLeft: '左眼闭合',
  blinkRight: '右眼闭合',
  browInnerUp: '内眉抬起',
  browDown: '压眉',
  browOuterUp: '外眉抬起',
  eyeWide: '睁大眼睛',
  gazeX: '视线水平',
  gazeY: '视线垂直',
};
const groups: Record<string, FaceChannel[]> = {
  嘴部: ['jawOpen', 'smile', 'frown', 'pucker', 'mouthWide', 'upperLipRaise', 'lowerLipDown'],
  眼睛与视线: ['blinkLeft', 'blinkRight', 'eyeWide', 'gazeX', 'gazeY'],
  眉部: ['browInnerUp', 'browDown', 'browOuterUp'],
};
const empty = faceAnimationSchema.parse({});

export function FacePanel({
  object,
  project,
  time,
  editor,
  onSeek,
}: {
  object: SceneObject;
  project: Project;
  time: number;
  editor: EditorActions;
  onSeek: (time: number) => void;
}) {
  const [mode, setMode] = useState<'base' | 'key'>('base');
  const [group, setGroup] = useState('嘴部');
  const [keyId, setKeyId] = useState('');
  const face = objectFace(object) ?? empty;
  const key = face.keys.find((item) => item.id === keyId);
  const updateFace = (change: (current: FaceAnimation) => FaceAnimation) =>
    editor.run((latest) => {
      const current = latest.objects.find((item) => item.id === object.id);
      if (!current) throw new Error('面部对象已删除');
      return [
        { type: 'actor.face.set', payload: { id: object.id, face: change(objectFace(current) ?? empty) } },
      ];
    });
  const updateKey = (patch: Partial<FaceKey>) => {
    if (key) editor.run('actor.face.key.set', { id: object.id, keyframe: { ...key, ...patch } });
  };
  const values = mode === 'key' && key ? { ...neutralFace, ...key.values } : { ...neutralFace, ...face.base };
  const setValues = (patch: Partial<FaceValues>) =>
    mode === 'key' && key
      ? updateKey({ values: { ...key.values, ...patch } })
      : updateFace((current) => ({ ...current, base: { ...current.base, ...patch } }));
  const addKey = () => {
    const id = crypto.randomUUID();
    const existing = face.keys.find((item) => Math.abs(item.time - time) < 0.5 / project.settings.fps);
    if (existing) {
      setKeyId(existing.id);
      setMode('key');
      return;
    }
    editor.run('actor.face.key.set', {
      id: object.id,
      keyframe: {
        id,
        time,
        values: sampleFace({ ...face, clips: [] }, time).values,
        easing: 'smooth',
      },
    });
    setKeyId(id);
    setMode('key');
  };
  return (
    <>
      <Section title="面部表演" defaultOpen={Boolean(objectFace(object))} extra={<ScanFace size={15} />}>
        <fieldset disabled={object.locked}>
          <label className="check-field">
            <input
              type="checkbox"
              aria-label="启用面部表演"
              checked={Boolean(objectFace(object)?.enabled)}
              onChange={(event) => updateFace((current) => ({ ...current, enabled: event.target.checked }))}
            />
            启用面部表演
          </label>
          <div className="face-toolbar">
            <div className="segmented" aria-label="面部编辑模式">
              <button className={mode === 'base' ? 'active' : ''} onClick={() => setMode('base')}>
                基础
              </button>
              <button className={mode === 'key' ? 'active' : ''} onClick={() => setMode('key')}>
                关键帧
              </button>
            </div>
            <IconButton icon={DiamondPlus} label="添加面部关键帧" onClick={addKey} />
          </div>
          {mode === 'key' && (
            <>
              <Field label="面部关键帧">
                <select
                  aria-label="面部关键帧"
                  value={key?.id ?? ''}
                  onChange={(event) => {
                    setKeyId(event.target.value);
                    const selected = face.keys.find((item) => item.id === event.target.value);
                    if (selected) onSeek(selected.time);
                  }}
                >
                  <option value="">未选择</option>
                  {face.keys.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.time.toFixed(3)} s
                    </option>
                  ))}
                </select>
              </Field>
              {key && (
                <div className="face-toolbar">
                  <NumberInput
                    label="面部关键帧时间"
                    value={key.time}
                    min={0}
                    step={1 / project.settings.fps}
                    onChange={(value) => updateKey({ time: value })}
                  />
                  <select
                    aria-label="面部关键帧插值"
                    value={key.easing}
                    onChange={(event) => updateKey({ easing: event.target.value as FaceKey['easing'] })}
                  >
                    <option value="smooth">平滑</option>
                    <option value="linear">线性</option>
                    <option value="step">保持</option>
                  </select>
                  <IconButton
                    icon={Trash2}
                    label="删除面部关键帧"
                    onClick={() => editor.run('actor.face.key.delete', { id: object.id, itemId: key.id })}
                  />
                </div>
              )}
            </>
          )}
          <fieldset disabled={mode === 'key' && !key}>
            <Field label="表情">
              <select
                aria-label="面部表情预设"
                value=""
                onChange={(event) => {
                  const preset = facePresets[event.target.value];
                  if (preset) setValues({ ...neutralFace, ...preset.values });
                }}
              >
                <option value="">自定义</option>
                {Object.entries(facePresets).map(([id, preset]) => (
                  <option key={id} value={id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="通道">
              <select
                aria-label="面部通道组"
                value={group}
                onChange={(event) => setGroup(event.target.value)}
              >
                {Object.keys(groups).map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </Field>
            <div className="face-channel-grid">
              {groups[group]!.map((channel) => (
                <Field key={channel} label={labels[channel]}>
                  <NumberInput
                    label={labels[channel]}
                    value={values[channel]}
                    min={channel.startsWith('gaze') ? -1 : 0}
                    max={1}
                    step={0.05}
                    onChange={(value) => setValues({ [channel]: value })}
                  />
                </Field>
              ))}
            </div>
          </fieldset>
        </fieldset>
      </Section>
      <LipSyncPanel object={object} project={project} time={time} editor={editor} onSeek={onSeek} />
      {object.type === 'model' && <MorphPanel object={object} project={project} editor={editor} />}
    </>
  );
}

function LipSyncPanel({
  object,
  project,
  time,
  editor,
  onSeek,
}: {
  object: SceneObject;
  project: Project;
  time: number;
  editor: EditorActions;
  onSeek: (time: number) => void;
}) {
  const [clipId, setClipId] = useState('');
  const [cueId, setCueId] = useState('');
  const [audioId, setAudioId] = useState('');
  const [recognizer, setRecognizer] = useState<'phonetic' | 'pocketsphinx'>('phonetic');
  const [dialogue, setDialogue] = useState('');
  const [link, setLink] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const clips = objectFace(object)?.clips ?? [];
  const clip = clips.find((item) => item.id === clipId) ?? clips[0];
  const cue = clip?.cues.find((item) => item.id === cueId) ?? clip?.cues[0];
  const audio = project.audio.filter((item) => item.sync === 'source');
  const selectedAudio = audio.find((item) => item.id === audioId) ?? audio[0];
  const update = (patch: Partial<FaceClip>) => {
    if (clip) editor.run('actor.face.clip.set', { id: object.id, clip: { ...clip, ...patch } });
  };
  const analyze = async () => {
    if (!selectedAudio) return;
    setBusy(true);
    setStatus('音素识别中');
    try {
      const result = await api<FaceAnalysisResult>('/face/analyze', {
        method: 'POST',
        body: JSON.stringify({
          objectId: object.id,
          audioId: selectedAudio.id,
          recognizer,
          linkTiming: link,
          ...(recognizer === 'pocketsphinx' && dialogue ? { dialogue } : {}),
          projectId: project.id,
          expectedRevision: project.revision,
          expectedContext: {
            sceneId: project.production?.activeSceneId ?? null,
            performanceId: project.production?.activePerformanceId ?? null,
          },
        }),
      });
      await editor.command(
        (latest) => {
          if (latest.revision !== result.revision) throw new Error('识别期间项目已修改，请重新分析口型');
          return result.commands;
        },
        {},
        { projectId: result.projectId, expectedContext: result.context },
      );
      setClipId(result.clip.id);
      setStatus(`${result.clip.cues.length} 个口型片段`);
    } catch (error) {
      editor.setError((error as Error).message);
      setStatus('分析失败');
    } finally {
      setBusy(false);
    }
  };
  const importCues = async (file: File | undefined) => {
    if (!file) return;
    const context = {
      projectId: project.id,
      expectedContext: {
        sceneId: project.production?.activeSceneId ?? null,
        performanceId: project.production?.activePerformanceId ?? null,
      },
      staleMessage: '项目已切换，未导入上一项目的口型',
    };
    try {
      const parsed = JSON.parse(await file.text());
      const imported = faceAnimationSchema.parse({ clips: [parsed] }).clips[0]!;
      imported.id = crypto.randomUUID();
      if (!project.audio.some((item) => item.id === imported.audioId)) imported.audioId = null;
      await editor.command('actor.face.clip.set', { id: object.id, clip: imported }, context);
      setClipId(imported.id);
    } catch (error) {
      editor.setError((error as Error).message);
    }
  };
  return (
    <Section title="对白口型" defaultOpen={clips.length > 0}>
      <fieldset disabled={object.locked || busy}>
        <Field label="对白音频">
          <select
            aria-label="口型对白音频"
            value={selectedAudio?.id ?? ''}
            onChange={(event) => setAudioId(event.target.value)}
          >
            {!audio.length && <option value="">无对白音频</option>}
            {audio.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="识别器">
          <select
            aria-label="口型识别器"
            value={recognizer}
            onChange={(event) => setRecognizer(event.target.value as typeof recognizer)}
          >
            <option value="phonetic">跨语言音素</option>
            <option value="pocketsphinx">英语 PocketSphinx</option>
          </select>
        </Field>
        {recognizer === 'pocketsphinx' && (
          <Field label="英语台词">
            <textarea
              aria-label="英语口型台词"
              value={dialogue}
              onChange={(event) => setDialogue(event.target.value)}
              rows={2}
            />
          </Field>
        )}
        <label className="check-field">
          <input type="checkbox" checked={link} onChange={(event) => setLink(event.target.checked)} />
          联动对白时间
        </label>
        <button className="face-command" disabled={!selectedAudio} onClick={() => void analyze()}>
          <AudioLines size={15} />
          分析口型
        </button>
        <div className="face-toolbar">
          <Field label="口型轨道">
            <select
              aria-label="口型轨道"
              value={clip?.id ?? ''}
              onChange={(event) => setClipId(event.target.value)}
            >
              {!clips.length && <option value="">无口型轨道</option>}
              {clips.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <IconButton
            icon={Plus}
            label="添加口型轨道"
            onClick={() => {
              const id = crypto.randomUUID();
              editor.run('actor.face.clip.set', {
                id: object.id,
                clip: { id, name: '口型', start: time, end: time + 2, cues: [] },
              });
              setClipId(id);
            }}
          />
          <label className="icon-button face-import" title="导入口型轨道">
            <Upload size={16} />
            <input
              aria-label="导入口型轨道"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                void importCues(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
        </div>
        {clip && (
          <>
            <Field label="名称">
              <TextInput label="口型轨道名称" value={clip.name} onChange={(name) => update({ name })} />
            </Field>
            <div className="face-channel-grid">
              <Field label="开始">
                <NumberInput
                  label="口型开始"
                  value={clip.start}
                  min={0}
                  onChange={(start) => update({ start, end: clip.end + start - clip.start })}
                />
              </Field>
              <Field label="结束">
                <NumberInput
                  label="口型结束"
                  value={clip.end}
                  min={clip.start + 1 / project.settings.fps}
                  onChange={(end) => update({ end })}
                />
              </Field>
              <Field label="权重">
                <NumberInput
                  label="口型权重"
                  value={clip.weight}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(weight) => update({ weight })}
                />
              </Field>
              <Field label="过渡">
                <NumberInput
                  label="口型过渡"
                  value={clip.transition}
                  min={0}
                  max={0.2}
                  step={0.01}
                  onChange={(transition) => update({ transition })}
                />
              </Field>
              <Field label="淡入">
                <NumberInput
                  label="口型淡入"
                  value={clip.fadeIn}
                  min={0}
                  step={0.01}
                  onChange={(fadeIn) => update({ fadeIn })}
                />
              </Field>
              <Field label="淡出">
                <NumberInput
                  label="口型淡出"
                  value={clip.fadeOut}
                  min={0}
                  step={0.01}
                  onChange={(fadeOut) => update({ fadeOut })}
                />
              </Field>
            </div>
            <Field label="音频关联">
              <select
                aria-label="口型音频关联"
                value={clip.audioId ?? ''}
                onChange={(event) => update({ audioId: event.target.value || null })}
              >
                <option value="">无</option>
                {audio.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="口型片段">
              <select
                aria-label="口型片段"
                value={cue?.id ?? ''}
                onChange={(event) => {
                  setCueId(event.target.value);
                  const selected = clip.cues.find((item) => item.id === event.target.value);
                  if (selected) onSeek(clip.start + selected.start);
                }}
              >
                {!clip.cues.length && <option value="">无口型片段</option>}
                {clip.cues.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.start.toFixed(2)} - {item.end.toFixed(2)} / {item.viseme}
                  </option>
                ))}
              </select>
            </Field>
            {cue && (
              <div className="face-cue-row">
                <NumberInput
                  label="口型片段开始"
                  value={cue.start}
                  min={0}
                  step={0.01}
                  onChange={(start) =>
                    editor.run('actor.face.cue.set', {
                      id: object.id,
                      clipId: clip.id,
                      cue: { ...cue, start },
                    })
                  }
                />
                <NumberInput
                  label="口型片段结束"
                  value={cue.end}
                  min={cue.start + 0.001}
                  step={0.01}
                  onChange={(end) =>
                    editor.run('actor.face.cue.set', { id: object.id, clipId: clip.id, cue: { ...cue, end } })
                  }
                />
                <select
                  aria-label="口型形状"
                  value={cue.viseme}
                  onChange={(event) =>
                    editor.run('actor.face.cue.set', {
                      id: object.id,
                      clipId: clip.id,
                      cue: { ...cue, viseme: event.target.value },
                    })
                  }
                >
                  {visemeSchema.options.map((shape) => (
                    <option key={shape}>{shape}</option>
                  ))}
                </select>
                <IconButton
                  icon={Trash2}
                  label="删除口型片段"
                  onClick={() =>
                    editor.run('actor.face.cue.delete', { id: object.id, clipId: clip.id, itemId: cue.id })
                  }
                />
              </div>
            )}
            <div className="face-toolbar">
              <IconButton
                icon={Plus}
                label="添加口型片段"
                onClick={() => {
                  const sorted = [...clip.cues].sort((a, b) => a.start - b.start);
                  let start = 0;
                  for (const item of sorted) {
                    if (item.start - start >= 0.04) break;
                    start = item.end;
                  }
                  const end = Math.min(
                    start + 0.2,
                    sorted.find((item) => item.start > start)?.start ?? clip.end - clip.start,
                  );
                  if (end <= start) {
                    editor.setError('口型轨道没有空余区间');
                    return;
                  }
                  const id = crypto.randomUUID();
                  editor.run('actor.face.cue.set', {
                    id: object.id,
                    clipId: clip.id,
                    cue: { id, start, end, viseme: 'X' },
                  });
                  setCueId(id);
                }}
              />
              <IconButton
                icon={Download}
                label="导出口型轨道"
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(clip, null, 2)], { type: 'application/json' }),
                  );
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = 'face-clip.json';
                  anchor.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              />
              <IconButton
                icon={Trash2}
                label="删除口型轨道"
                onClick={() => editor.run('actor.face.clip.delete', { id: object.id, itemId: clip.id })}
              />
            </div>
          </>
        )}
      </fieldset>
      {status && <output className="face-status">{status}</output>}
    </Section>
  );
}

function MorphPanel({
  object,
  project,
  editor,
}: {
  object: SceneObject;
  project: Project;
  editor: EditorActions;
}) {
  const [catalog, setCatalog] = useState<MorphCatalog | null>(null);
  const [channel, setChannel] = useState<MorphBinding['channel']>('jawOpen');
  const [target, setTarget] = useState('');
  useEffect(() => {
    let cancelled = false;
    void api<MorphCatalog>('/face/morph-catalog', {
      method: 'POST',
      body: JSON.stringify({ objectId: object.id, projectId: project.id }),
    })
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch((error: Error) => {
        if (!cancelled) editor.setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [object.id, object.assetUrl, project.id, editor.setError]);
  const bindings = object.morph?.bindings ?? [];
  const targets = [...new Set(catalog?.meshes.flatMap((mesh) => mesh.targets) ?? [])];
  const chosen = targets.includes(target) ? target : targets[0];
  const change = (next: MorphBinding[]) =>
    editor.run('model.morph.bindings.set', { id: object.id, bindings: next });
  return (
    <Section title="模型形变映射" defaultOpen={bindings.length > 0}>
      <fieldset disabled={object.locked}>
        <Field label="面部通道">
          <select
            aria-label="形变面部通道"
            value={channel}
            onChange={(event) => setChannel(morphChannelSchema.parse(event.target.value))}
          >
            {faceChannels.map((name) => (
              <option key={name} value={name}>
                {labels[name]}
              </option>
            ))}
            {visemeSchema.options.map((shape) => (
              <option key={shape} value={`viseme:${shape}`}>
                口型 {shape}
              </option>
            ))}
          </select>
        </Field>
        <div className="face-toolbar">
          <Field label="模型目标">
            <select
              aria-label="模型形变目标"
              value={chosen ?? ''}
              onChange={(event) => setTarget(event.target.value)}
            >
              {!targets.length && <option value="">无形变目标</option>}
              {targets.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </Field>
          <IconButton
            icon={Plus}
            label="添加形变映射"
            disabled={!chosen}
            onClick={() => change([...bindings, { channel, target: chosen!, scale: 1, offset: 0 }])}
          />
        </div>
        {bindings.map((binding, index) => (
          <div className="face-binding" key={index}>
            <span title={`${binding.channel} / ${binding.target}`}>
              {binding.channel} / {binding.target}
            </span>
            <Field label="网格范围">
              <select
                aria-label={`映射 ${index + 1} 网格`}
                value={binding.mesh ?? ''}
                onChange={(event) =>
                  change(
                    bindings.map((item, i) => {
                      if (i !== index) return item;
                      const { mesh: _mesh, ...rest } = item;
                      return event.target.value ? { ...rest, mesh: event.target.value } : rest;
                    }),
                  )
                }
              >
                <option value="">全部网格</option>
                {catalog?.meshes.map((mesh) => (
                  <option key={mesh.mesh} value={mesh.mesh}>
                    {mesh.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="face-toolbar">
              <NumberInput
                label={`映射 ${index + 1} 倍率`}
                value={binding.scale}
                min={-2}
                max={2}
                step={0.05}
                onChange={(scale) =>
                  change(bindings.map((item, i) => (i === index ? { ...item, scale } : item)))
                }
              />
              <NumberInput
                label={`映射 ${index + 1} 偏移`}
                value={binding.offset}
                min={-1}
                max={1}
                step={0.05}
                onChange={(offset) =>
                  change(bindings.map((item, i) => (i === index ? { ...item, offset } : item)))
                }
              />
              <IconButton
                icon={Trash2}
                label={`删除形变映射 ${index + 1}`}
                onClick={() => change(bindings.filter((_, i) => i !== index))}
              />
            </div>
          </div>
        ))}
      </fieldset>
    </Section>
  );
}
