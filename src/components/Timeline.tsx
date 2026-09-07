import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronFirst,
  ChevronLast,
  Copy,
  Film,
  Blend,
  Gauge,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  Repeat2,
  Scissors,
  Trash2,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Project, SequenceClip, Vec3 } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import type { Playback } from '../usePlayback';
import { IconButton, NumberInput, timecode } from './Controls';
import { ShotThumbnail } from './Stage';
import { RetimingPanel } from './RetimingPanel';
import { TransitionPanel } from './TransitionPanel';
import { cameraToClipTime, clipDuration, sampleClipTime, sourceToClipTime } from '../../shared/time-map';
import { resolveShotProject } from '../../shared/production';

export function Timeline({
  project,
  editor,
  playback,
  activeClipId,
  onClipSelect,
  getView,
  onObjectSelect,
}: {
  project: Project;
  editor: EditorActions;
  playback: Playback;
  activeClipId: string | null;
  onClipSelect: (clip: SequenceClip, start: number) => void;
  getView: () => { position: Vec3; target: Vec3; fov: number } | undefined;
  onObjectSelect?: (id: string) => void;
}) {
  const sequence = project.sequences.find((s) => s.id === project.activeSequenceId) ?? project.sequences[0];
  const clips = sequence?.clips ?? [];
  const [retimingOpen, setRetimingOpen] = useState(false);
  const [transitionOpen, setTransitionOpen] = useState(false);
  const { placements, position } = useMemo(() => {
    let position = 0;
    const placements = clips.map((clip) => {
      const start = position;
      position += clipDuration(clip);
      const shot = project.shots.find((s) => s.id === clip.shotId);
      return { clip, start, shot, scene: resolveShotProject(project, shot ?? null) };
    });
    return { placements, position };
  }, [clips, project]);
  const current = clips.find((c) => c.id === activeClipId);
  const hasEvents = placements.some(({ scene }) =>
    scene.objects.some((object) => object.motionEvents?.length),
  );
  const eventNames = { collision: '碰撞', impact: '命中', projectile: '弹道', explosion: '爆炸' };
  const currentShot = project.shots.find((s) => s.id === current?.shotId);
  const saveClips = (next: SequenceClip[]) =>
    editor.run('sequence.update', { id: sequence.id, patch: { clips: next } });
  const trim = (sourceIn: number, sourceOut: number) => {
    if (!current) return;
    if (current.retiming)
      editor.run('clip.trim', { sequenceId: sequence.id, clipId: current.id, sourceIn, sourceOut });
    else saveClips(clips.map((clip) => (clip.id === current.id ? { ...clip, sourceIn, sourceOut } : clip)));
  };
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
    <section className={`timeline${hasEvents ? ' has-events' : ''}`}>
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
            {hasEvents && <div className="track-label">运动事件</div>}
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
                        width: `${(clipDuration(clip) / (playback.duration || 1)) * 100}%`,
                      }}
                      onClick={() => onClipSelect(clip, start)}
                    >
                      <ShotThumbnail project={project} shot={shot} />
                      <div className="shot-card-label">
                        <b>{String(index + 1).padStart(2, '0')}</b>
                        <span>{shot.name}</span>
                        <small>
                          {clipDuration(clip).toFixed(1)}s{clip.retiming && ' · R'}
                        </small>
                        {shot.locked && <LockKeyhole size={11} />}
                        {(clip.fadeIn || clip.fadeOut || clip.transitionIn) && (
                          <Blend size={11} aria-label="含画面转场" />
                        )}
                      </div>
                    </button>
                  ),
              )}
            </div>
            <div className="beat-track">
              {placements.flatMap(({ clip, start, scene }) =>
                scene.beats
                  .filter((b) => b.time >= clip.sourceIn && b.time < clip.sourceOut)
                  .map((b) => (
                    <button
                      key={`${clip.id}-${b.id}`}
                      className={`beat-marker marker-${b.kind}`}
                      data-clip-id={clip.id}
                      title={`${b.label} · ${b.text}`}
                      style={{
                        left: `${((start + sourceToClipTime(clip, b.time)) / (playback.duration || 1)) * 100}%`,
                        maxWidth: `${(Math.max(0.1, sourceToClipTime(clip, Math.min(b.endTime, clip.sourceOut)) - sourceToClipTime(clip, b.time)) / (playback.duration || 1)) * 100}%`,
                      }}
                      onClick={() => onClipSelect(clip, start + sourceToClipTime(clip, b.time))}
                    >
                      {b.label}
                    </button>
                  )),
              )}
            </div>
            <div className="animation-track">
              {placements.flatMap(({ clip, start, shot, scene }) =>
                [
                  ...scene.objects
                    .flatMap((o) => o.keyframes.map((key) => ({ ...key, label: o.name })))
                    .map((key) => ({
                      ...key,
                      edit: sourceToClipTime(clip, key.time),
                      inRange: key.time >= clip.sourceIn && key.time < clip.sourceOut,
                    })),
                  ...(project.cameras.find((c) => c.id === shot?.cameraId)?.keyframes ?? []).map((key) => {
                    const edit = cameraToClipTime(clip, key.time);
                    return {
                      ...key,
                      label: project.cameras.find((c) => c.id === shot?.cameraId)!.name,
                      edit,
                      inRange:
                        edit < clipDuration(clip) &&
                        Math.abs(sampleClipTime(clip, edit).cameraTime - key.time) < 1e-8,
                    };
                  }),
                ]
                  .filter((k) => k.inRange)
                  .map((k, index) => (
                    <button
                      key={`${clip.id}-${k.id}-${index}`}
                      className="timeline-diamond"
                      data-clip-id={clip.id}
                      data-keyframe-id={k.id}
                      aria-label={`${k.label} / ${timecode(k.time, project.settings.fps)}`}
                      title={timecode(k.time, project.settings.fps)}
                      style={{
                        left: `${((start + k.edit) / (playback.duration || 1)) * 100}%`,
                      }}
                      onClick={() => onClipSelect(clip, start + k.edit)}
                    />
                  )),
              )}
            </div>
            {hasEvents && (
              <div className="event-track">
                {placements.flatMap(({ clip, start, scene }) =>
                  scene.objects.flatMap((object) =>
                    (object.motionEvents ?? [])
                      .filter((event) => event.time >= clip.sourceIn && event.time < clip.sourceOut)
                      .map((event) => {
                        const label = `${object.name} / ${eventNames[event.kind]} / ${timecode(event.time, project.settings.fps)}`;
                        return (
                          <button
                            key={`${clip.id}-${object.id}-${event.id}`}
                            className="timeline-event"
                            data-clip-id={clip.id}
                            data-event-id={event.id}
                            aria-label={label}
                            title={label}
                            style={{
                              left: `${((start + sourceToClipTime(clip, event.time)) / (playback.duration || 1)) * 100}%`,
                            }}
                            onClick={() => {
                              onClipSelect(clip, start + sourceToClipTime(clip, event.time));
                              onObjectSelect?.(object.id);
                            }}
                          >
                            <Zap size={12} />
                          </button>
                        );
                      }),
                  ),
                )}
              </div>
            )}
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
              min={current.retiming ? current.sourceIn : (currentShot?.sourceIn ?? 0)}
              max={current.sourceOut - 1 / project.settings.fps}
              step={1 / project.settings.fps}
              onChange={(sourceIn) => trim(sourceIn, current.sourceOut)}
            />
            <span>至</span>
            <NumberInput
              label="片段出点"
              value={current.sourceOut}
              min={current.sourceIn + 1 / project.settings.fps}
              max={current.retiming ? current.sourceOut : currentShot?.sourceOut}
              step={1 / project.settings.fps}
              onChange={(sourceOut) => trim(current.sourceIn, sourceOut)}
            />
            <span className="clip-source-label">
              {project.shots.find((s) => s.id === current.shotId)?.name}
            </span>
            <span className="flex-spacer" />
            <IconButton
              icon={Blend}
              label="画面转场"
              disabled={sequence.locked || currentShot?.locked}
              onClick={() => {
                playback.setPlaying(false);
                setTransitionOpen(true);
              }}
            />
            <IconButton
              icon={Gauge}
              label="片段速度与时间"
              disabled={sequence.locked || currentShot?.locked}
              onClick={() => {
                playback.setPlaying(false);
                setRetimingOpen(true);
              }}
            />
            <IconButton
              icon={Scissors}
              label="在播放头分割片段"
              disabled={
                sequence.locked ||
                currentShot?.locked ||
                playback.time <=
                  (placements.find((item) => item.clip.id === current.id)?.start ?? 0) + 0.0001 ||
                playback.time >=
                  (placements.find((item) => item.clip.id === current.id)?.start ?? 0) +
                    clipDuration(current) -
                    0.0001
              }
              onClick={() =>
                editor.run('clip.split', {
                  sequenceId: sequence.id,
                  clipId: current.id,
                  time: playback.time - (placements.find((item) => item.clip.id === current.id)?.start ?? 0),
                })
              }
            />
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
      {retimingOpen && current && (
        <RetimingPanel
          key={current.id}
          clip={current}
          sequenceId={sequence.id}
          editor={editor}
          onClose={() => setRetimingOpen(false)}
        />
      )}
      {transitionOpen && current && (
        <TransitionPanel
          key={current.id}
          project={project}
          sequence={sequence}
          clip={current}
          editor={editor}
          onClose={() => setTransitionOpen(false)}
        />
      )}
    </section>
  );
}
