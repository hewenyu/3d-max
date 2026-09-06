import { useRef, useState } from 'react';
import {
  AudioLines,
  LockKeyhole,
  MessageSquarePlus,
  Plus,
  Trash2,
  UnlockKeyhole,
  Upload,
} from 'lucide-react';
import type { AudioClip, Beat, Project, Shot } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { uploadAsset } from '../api';
import { Field, IconButton, NumberInput, Section, TextInput, timecode } from './Controls';

const beatNames: Record<Beat['kind'], string> = {
  dialogue: '对白',
  pause: '停顿',
  reaction: '反应',
  reveal: '揭示',
  action: '动作',
};
export function DirectorPanel({
  project,
  editor,
  sourceTime,
  time,
  shot,
  onSeek,
}: {
  project: Project;
  editor: EditorActions;
  sourceTime: number;
  time: number;
  shot: Shot | null;
  onSeek: (time: number) => void;
}) {
  const [note, setNote] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const updateBeat = (id: string, patch: Partial<Beat>) => editor.run('beat.update', { id, patch });
  const updateAudio = (id: string, patch: Partial<AudioClip>) => editor.run('audio.update', { id, patch });
  const importAudio = async (file?: File) => {
    if (!file) return;
    const projectId = project.id;
    try {
      const asset = await uploadAsset(file);
      let duration = asset.duration;
      if (!duration) {
        const audio = new Audio(asset.url);
        duration = await new Promise<number>((resolve, reject) => {
          audio.onloadedmetadata = () => resolve(audio.duration);
          audio.onerror = () => reject(new Error('无法读取音频时长'));
        });
      }
      await editor.command(
        'audio.create',
        {
          name: file.name,
          url: asset.url,
          duration,
          start: sourceTime,
          sourceIn: 0,
          sync: 'source',
          volume: 1,
          muted: false,
          locked: false,
        },
        { projectId, staleMessage: '项目已切换，未导入上一项目的音频' },
      );
    } catch (error) {
      editor.setError((error as Error).message);
    }
  };
  return (
    <>
      <Section title="场次">
        <Field label="场景">
          <TextInput
            value={project.sceneName}
            onChange={(sceneName) => editor.run('project.update', { sceneName })}
          />
        </Field>
      </Section>
      <Section
        title="剧情节拍"
        extra={
          <IconButton
            icon={Plus}
            label="添加剧情节拍"
            onClick={() =>
              editor.run('beat.create', {
                label: '新节拍',
                time: sourceTime,
                endTime: sourceTime + 1,
                kind: 'action',
                text: '',
                notes: '',
                actorId: null,
                locked: false,
              })
            }
          />
        }
      >
        <div className="beats-list">
          {project.beats.map((beat) => (
            <article className={'beat-item beat-' + beat.kind} key={beat.id}>
              <div className="beat-header">
                <button className="beat-time" onClick={() => onSeek(beat.time)}>
                  {timecode(beat.time, project.settings.fps)}
                </button>
                <select
                  value={beat.kind}
                  disabled={beat.locked}
                  onChange={(event) => updateBeat(beat.id, { kind: event.target.value as Beat['kind'] })}
                >
                  {Object.entries(beatNames).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <IconButton
                  icon={beat.locked ? LockKeyhole : UnlockKeyhole}
                  label={beat.locked ? '解锁节拍' : '锁定节拍'}
                  active={beat.locked}
                  onClick={() => updateBeat(beat.id, { locked: !beat.locked })}
                />
                <IconButton
                  icon={Trash2}
                  label="删除节拍"
                  disabled={beat.locked}
                  onClick={() => editor.run('beat.delete', { id: beat.id })}
                />
              </div>
              <fieldset disabled={beat.locked}>
                <TextInput
                  value={beat.label}
                  label="节拍名称"
                  onChange={(label) => updateBeat(beat.id, { label })}
                />
                <TextInput
                  multiline
                  value={beat.text}
                  label="台词或表演"
                  placeholder="台词 / 表演"
                  onChange={(text) => updateBeat(beat.id, { text })}
                />
                <div className="two-fields">
                  <Field label="开始">
                    <NumberInput
                      value={beat.time}
                      onChange={(start) => updateBeat(beat.id, { time: start })}
                      min={0}
                      max={beat.endTime}
                      step={1 / project.settings.fps}
                    />
                  </Field>
                  <Field label="结束">
                    <NumberInput
                      value={beat.endTime}
                      onChange={(endTime) => updateBeat(beat.id, { endTime })}
                      min={beat.time}
                      step={1 / project.settings.fps}
                    />
                  </Field>
                </div>
                <Field label="角色">
                  <select
                    value={beat.actorId ?? ''}
                    onChange={(event) => updateBeat(beat.id, { actorId: event.target.value || null })}
                  >
                    <option value="">未指定</option>
                    {project.objects
                      .filter((object) => object.type === 'actor')
                      .map((object) => (
                        <option value={object.id} key={object.id}>
                          {object.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <TextInput
                  multiline
                  label="表演备注"
                  value={beat.notes}
                  placeholder="表演备注"
                  onChange={(notes) => updateBeat(beat.id, { notes })}
                />
              </fieldset>
            </article>
          ))}
        </div>
      </Section>
      <Section
        title="临时对白"
        extra={<IconButton icon={Upload} label="导入对白音频" onClick={() => fileInput.current?.click()} />}
      >
        <input
          ref={fileInput}
          type="file"
          accept="audio/*"
          hidden
          onChange={(event) => {
            void importAudio(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        {!project.audio.length && (
          <button className="text-button full-width" onClick={() => fileInput.current?.click()}>
            <AudioLines size={15} />
            导入音频
          </button>
        )}
        {project.audio.map((clip) => (
          <div className="audio-editor" key={clip.id}>
            <div className="row">
              <AudioLines size={14} />
              <span className="truncate">{clip.name}</span>
              <IconButton
                icon={clip.locked ? LockKeyhole : UnlockKeyhole}
                label={clip.locked ? '解锁音频' : '锁定音频'}
                onClick={() => updateAudio(clip.id, { locked: !clip.locked })}
              />
              <IconButton
                icon={Trash2}
                label="删除音频"
                disabled={clip.locked}
                onClick={() => editor.run('audio.delete', { id: clip.id })}
              />
            </div>
            <fieldset disabled={clip.locked}>
              <Field label="时间基准">
                <select
                  value={clip.sync}
                  onChange={(event) =>
                    updateAudio(clip.id, { sync: event.target.value as AudioClip['sync'] })
                  }
                >
                  <option value="source">表演源时间</option>
                  <option value="sequence">成片时间</option>
                </select>
              </Field>
              <Field label="起始时间">
                <NumberInput
                  value={clip.start}
                  min={0}
                  onChange={(start) => updateAudio(clip.id, { start })}
                />
              </Field>
              <Field label="音量">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={clip.volume}
                  onChange={(event) => updateAudio(clip.id, { volume: Number(event.target.value) })}
                />
              </Field>
              <Field label="静音">
                <input
                  type="checkbox"
                  checked={clip.muted}
                  onChange={(event) => updateAudio(clip.id, { muted: event.target.checked })}
                />
              </Field>
            </fieldset>
          </div>
        ))}
      </Section>
      <Section title="镜头意见">
        <div className="note-composer">
          <textarea
            value={note}
            aria-label="镜头意见"
            rows={3}
            onChange={(event) => setNote(event.target.value)}
            placeholder="修改意见"
          />
          <button
            className="text-button"
            disabled={!note.trim()}
            onClick={() => {
              editor.run('note.create', {
                shotId: shot?.id ?? null,
                time: shot ? sourceTime : time,
                text: note.trim(),
              });
              setNote('');
            }}
          >
            <MessageSquarePlus size={14} />
            记录
          </button>
        </div>
        {project.notes
          .filter((item) => !item.shotId || item.shotId === shot?.id)
          .map((item) => (
            <div className="director-note" key={item.id}>
              <div className="row">
                <span className="mono muted">{timecode(item.time, project.settings.fps)}</span>
                <IconButton
                  icon={Trash2}
                  label="删除意见"
                  onClick={() => editor.run('note.delete', { id: item.id })}
                />
              </div>
              <p>{item.text}</p>
            </div>
          ))}
      </Section>
    </>
  );
}
