import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronFirst,
  ChevronLast,
  Copy,
  Film,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  Repeat2,
  Scissors,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { Project, SequenceClip, Vec3 } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import type { Playback } from '../usePlayback';
import { IconButton, NumberInput, timecode } from './Controls';
import { ShotThumbnail } from './Stage';

export function Timeline({
  project,
  editor,
  playback,
  activeClipId,
  onClipSelect,
  getView,
}: {
  project: Project;
  editor: EditorActions;
  playback: Playback;
  activeClipId: string | null;
  onClipSelect: (clip: SequenceClip, start: number) => void;
  getView: () => { position: Vec3; target: Vec3; fov: number } | undefined;
}) {
  const sequence = project.sequences.find((s) => s.id === project.activeSequenceId) ?? project.sequences[0];
  const clips = sequence?.clips ?? [];
  let position = 0;
  const placements = clips.map((clip) => {
    const start = position;
    position += clip.sourceOut - clip.sourceIn;
    return { clip, start, shot: project.shots.find((s) => s.id === clip.shotId) };
  });
  const current = clips.find((c) => c.id === activeClipId);
  const currentShot = project.shots.find((s) => s.id === current?.shotId);
  const saveClips = (next: SequenceClip[]) =>
    editor.run('sequence.update', { id: sequence.id, patch: { clips: next } });
  const move = (direction: number) => {
    const index = clips.findIndex((c) => c.id === activeClipId);
    const next = [...clips];
    if (index < 0 || index + direction < 0 || index + direction >= next.length) return;
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    saveClips(next);
  };
  const add = async () => {
    const cameraId = crypto.randomUUID();
    const shotId = crypto.randomUUID();
    const view = getView() ?? { position: [4, 2.5, 6] as Vec3, target: [0, 1, 0] as Vec3, fov: 45 };
    const number = project.shots.length + 1;
    const clip: SequenceClip = {
      id: crypto.randomUUID(),
      shotId,
      sourceIn: position,
      sourceOut: position + 3,
    };
    try {
      await editor.command([
        { type: 'camera.create', payload: { id: cameraId, name: `机位 ${number}`, ...view } },
        {
          type: 'shot.create',
          payload: {
            id: shotId,
            name: `镜头 ${String(number).padStart(2, '0')}`,
            cameraId,
            sourceIn: clip.sourceIn,
            sourceOut: clip.sourceOut,
            intent: '',
          },
        },
        { type: 'sequence.update', payload: { id: sequence.id, patch: { clips: [...clips, clip] } } },
      ]);
      onClipSelect(clip, position);
    } catch {
      /* Shared error surface reports rejected edits. */
    }
  };
  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    playback.seek(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * playback.duration);
  };
  return (
    <section className="timeline">
      <div className="timeline-toolbar">
        <div className="timeline-title">
          <Film size={15} />
          <strong>镜头序列</strong>
          <select
            aria-label="剪辑方案"
            value={sequence?.id ?? ''}
            onChange={(e) => {
              playback.setPlaying(false);
              playback.seek(0);
              editor.run('project.update', { activeSequenceId: e.target.value });
            }}
          >
            {project.sequences.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <IconButton
            icon={Copy}
            label="复制剪辑方案"
            onClick={() =>
              editor.run('sequence.duplicate', { id: sequence.id, name: `${sequence.name} · 副本` })
            }
          />
          <IconButton
            icon={LockKeyhole}
            label="锁定剪辑方案"
            active={sequence?.locked}
            onClick={() =>
              editor.run('sequence.update', { id: sequence.id, patch: { locked: !sequence.locked } })
            }
          />
        </div>
        <div className="transport">
          <IconButton icon={ChevronFirst} label="回到开始" onClick={() => playback.seek(0)} />
          <IconButton
            icon={ArrowLeft}
            label="上一帧"
            onClick={() => {
              playback.setPlaying(false);
              playback.seek(playback.time - 1 / project.settings.fps);
            }}
          />
          <IconButton
            icon={playback.playing ? Pause : Play}
            label={playback.playing ? '暂停' : '播放'}
            className="play-button"
            onClick={playback.toggle}
          />
          <IconButton
            icon={ArrowRight}
            label="下一帧"
            onClick={() => {
              playback.setPlaying(false);
              playback.seek(playback.time + 1 / project.settings.fps);
            }}
          />
          <IconButton
            icon={ChevronLast}
            label="跳到结尾"
            onClick={() => playback.seek(Math.max(0, playback.duration - 1 / project.settings.fps))}
          />
          <span className="transport-time mono">
            {timecode(playback.time, project.settings.fps)}
            <span> / {timecode(playback.duration, project.settings.fps)}</span>
          </span>
          <IconButton
            icon={Repeat2}
            label="循环播放"
            active={playback.loop}
            onClick={() => playback.setLoop(!playback.loop)}
          />
          <IconButton
            icon={playback.muted ? VolumeX : Volume2}
            label={playback.muted ? '取消静音' : '静音预览'}
            onClick={() => playback.setMuted(!playback.muted)}
          />
        </div>
        <button className="text-button add-shot" onClick={() => void add()} disabled={sequence?.locked}>
          <Plus size={14} />
          新镜头
        </button>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-inner">
          <div className="track-labels">
            <div className="ruler-label">{project.settings.fps} FPS</div>
            <div className="shot-track-label">
              <Camera size={14} />
              画面<span>{clips.length}</span>
            </div>
            <div className="track-label">表演节拍</div>
            <div className="track-label">动作 / 运镜</div>
          </div>
          <div className="tracks">
            <div
              className="timeline-ruler"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                scrub(e);
              }}
              onPointerMove={(e) => {
                if (e.buttons === 1) scrub(e);
              }}
            >
              {Array.from({ length: Math.ceil(playback.duration) + 1 }, (_, index) => (
                <span key={index} style={{ left: `${(index / (playback.duration || 1)) * 100}%` }}>
                  {index}s
                </span>
              ))}
            </div>
            <div className="shot-track">
              {placements.map(
                ({ clip, start, shot }, index) =>
                  shot && (
                    <button
                      key={clip.id}
                      className={`shot-card ${clip.id === activeClipId ? 'selected' : ''}`}
                      style={{
                        width: `${((clip.sourceOut - clip.sourceIn) / (playback.duration || 1)) * 100}%`,
                      }}
                      onClick={() => onClipSelect(clip, start)}
                    >
                      <ShotThumbnail project={project} shot={shot} />
                      <div className="shot-card-label">
                        <b>{String(index + 1).padStart(2, '0')}</b>
                        <span>{shot.name}</span>
                        <small>{(clip.sourceOut - clip.sourceIn).toFixed(1)}s</small>
                        {shot.locked && <LockKeyhole size={11} />}
                      </div>
                    </button>
                  ),
              )}
            </div>
            <div className="beat-track">
              {placements.flatMap(({ clip, start }) =>
                project.beats
                  .filter((b) => b.time >= clip.sourceIn && b.time < clip.sourceOut)
                  .map((b) => (
                    <button
                      key={`${clip.id}-${b.id}`}
                      className={`beat-marker marker-${b.kind}`}
                      title={`${b.label} · ${b.text}`}
                      style={{
                        left: `${((start + b.time - clip.sourceIn) / (playback.duration || 1)) * 100}%`,
                        maxWidth: `${(Math.max(6, Math.min(b.endTime, clip.sourceOut) - b.time) / (playback.duration || 1)) * 100}%`,
                      }}
                      onClick={() => playback.seek(start + b.time - clip.sourceIn)}
                    >
                      {b.label}
                    </button>
                  )),
              )}
            </div>
            <div className="animation-track">
              {placements.flatMap(({ clip, start, shot }) =>
                [
                  ...project.objects.flatMap((o) => o.keyframes),
                  ...(project.cameras.find((c) => c.id === shot?.cameraId)?.keyframes ?? []),
                ]
                  .filter((k) => k.time >= clip.sourceIn && k.time < clip.sourceOut)
                  .map((k, index) => (
                    <button
                      key={`${clip.id}-${k.id}-${index}`}
                      className="timeline-diamond"
                      title={timecode(k.time, project.settings.fps)}
                      style={{
                        left: `${((start + k.time - clip.sourceIn) / (playback.duration || 1)) * 100}%`,
                      }}
                      onClick={() => playback.seek(start + k.time - clip.sourceIn)}
                    />
                  )),
              )}
            </div>
            <div
              className="playhead"
              style={{ left: `${(playback.time / (playback.duration || 1)) * 100}%` }}
            >
              <span />
            </div>
          </div>
        </div>
      </div>
      <div className="clip-editor">
        {current ? (
          <>
            <Scissors size={13} />
            <span>源时间</span>
            <NumberInput
              label="片段入点"
              value={current.sourceIn}
              min={currentShot?.sourceIn ?? 0}
              max={current.sourceOut - 1 / project.settings.fps}
              step={1 / project.settings.fps}
              onChange={(sourceIn) =>
                saveClips(clips.map((c) => (c.id === current.id ? { ...c, sourceIn } : c)))
              }
            />
            <span>至</span>
            <NumberInput
              label="片段出点"
              value={current.sourceOut}
              min={current.sourceIn + 1 / project.settings.fps}
              max={currentShot?.sourceOut}
              step={1 / project.settings.fps}
              onChange={(sourceOut) =>
                saveClips(clips.map((c) => (c.id === current.id ? { ...c, sourceOut } : c)))
              }
            />
            <span className="clip-source-label">
              {project.shots.find((s) => s.id === current.shotId)?.name}
            </span>
            <span className="flex-spacer" />
            <IconButton
              icon={ArrowLeft}
              label="镜头前移"
              disabled={sequence.locked}
              onClick={() => move(-1)}
            />
            <IconButton
              icon={ArrowRight}
              label="镜头后移"
              disabled={sequence.locked}
              onClick={() => move(1)}
            />
            <IconButton
              icon={Copy}
              label="重复镜头片段"
              disabled={sequence.locked}
              onClick={() => {
                const index = clips.findIndex((c) => c.id === current.id);
                const next = [...clips];
                next.splice(index + 1, 0, { ...current, id: crypto.randomUUID() });
                saveClips(next);
              }}
            />
            <IconButton
              icon={Trash2}
              label="移除镜头片段"
              disabled={sequence.locked}
              onClick={() => saveClips(clips.filter((c) => c.id !== current.id))}
            />
          </>
        ) : (
          <span className="muted">{project.sceneName}</span>
        )}
      </div>
    </section>
  );
}
