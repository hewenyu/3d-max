import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronFirst, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { sampleTimeline, sequenceDuration } from '../../shared/timeline';
import type { Project } from '../../shared/types';
import { SceneEngine } from '../engine/SceneEngine';
import { IconButton, Modal } from './Controls';
import './sequence-compare.css';
import { useWorkspaceSurface, settleWorkspace, waitWorkspaceReady } from '../workspace/Surfaces';

export function SequenceCompareDialog({
  project,
  onClose,
  initialTime = 0,
}: {
  project: Project;
  onClose: () => void;
  initialTime?: number;
}) {
  const [left, setLeft] = useState(project.activeSequenceId);
  const [right, setRight] = useState(
    project.sequences.find((sequence) => sequence.id !== project.activeSequenceId)?.id ??
      project.activeSequenceId,
  );
  const [time, setTime] = useState(Math.max(0, initialTime));
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState({ left: false, right: false });
  const cursor = useRef(time);
  cursor.current = time;
  const duration = Math.max(sequenceDuration(project, left), sequenceDuration(project, right));
  const fps = project.settings.fps;
  useEffect(() => {
    if (time > duration) setTime(duration);
    if (!project.sequences.some((sequence) => sequence.id === left)) setLeft(project.activeSequenceId);
    if (!project.sequences.some((sequence) => sequence.id === right)) setRight(project.activeSequenceId);
  }, [project, left, right, time, duration]);
  useEffect(() => {
    if (!playing || !ready.left || !ready.right) return;
    const start = performance.now();
    const offset = cursor.current;
    let animation = 0;
    let lastFrame = -1;
    const tick = (now: number) => {
      const next = Math.min(duration, offset + (now - start) / 1000);
      const frame = Math.floor(next * fps);
      if (frame !== lastFrame || next === duration) {
        setTime(next);
        lastFrame = frame;
      }
      if (next >= duration) setPlaying(false);
      else animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, ready.left, ready.right, duration, fps]);
  const seek = (value: number) => {
    setPlaying(false);
    setTime(Math.max(0, Math.min(duration, value)));
  };
  const readyState = useRef(ready);
  readyState.current = ready;
  useWorkspaceSurface('comparison', {
    read: () => ({ leftSequenceId: left, rightSequenceId: right, time, playing, ready }),
    apply: async (command) => {
      if (command.type !== 'comparison') return;
      let nextLeft = command.leftSequenceId ?? left;
      let nextRight = command.rightSequenceId ?? right;
      if (command.swap) [nextLeft, nextRight] = [nextRight, nextLeft];
      setLeft(nextLeft);
      setRight(nextRight);
      const nextDuration = Math.max(
        sequenceDuration(project, nextLeft),
        sequenceDuration(project, nextRight),
      );
      if (command.time !== undefined || command.stepFrames !== undefined)
        seek(Math.min(nextDuration, command.time ?? time + (command.stepFrames ?? 0) / fps));
      if (command.action === 'start') seek(0);
      if (command.action === 'pause') setPlaying(false);
      if (command.action === 'play') {
        await settleWorkspace();
        await waitWorkspaceReady(() => readyState.current.left && readyState.current.right);
        if (time >= nextDuration && command.time === undefined) setTime(0);
        setPlaying(true);
      }
    },
  });
  return (
    <Modal title="剪辑方案对比" onClose={onClose} wide>
      <div className="modal-content sequence-compare">
        <div className="compare-selectors">
          <label>
            <span>A</span>
            <select
              aria-label="对比方案 A"
              value={left}
              onChange={(event) => {
                setPlaying(false);
                setLeft(event.target.value);
              }}
            >
              {project.sequences.map((sequence) => (
                <option key={sequence.id} value={sequence.id}>
                  {sequence.name}
                </option>
              ))}
            </select>
          </label>
          <IconButton
            icon={ArrowLeftRight}
            label="交换对比方案"
            onClick={() => {
              setLeft(right);
              setRight(left);
            }}
          />
          <label>
            <span>B</span>
            <select
              aria-label="对比方案 B"
              value={right}
              onChange={(event) => {
                setPlaying(false);
                setRight(event.target.value);
              }}
            >
              {project.sequences.map((sequence) => (
                <option key={sequence.id} value={sequence.id}>
                  {sequence.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="compare-viewports">
          <CompareViewport
            project={project}
            time={time}
            sequenceId={left}
            name="A"
            onReady={(value) =>
              setReady((previous) => (previous.left === value ? previous : { ...previous, left: value }))
            }
          />
          <CompareViewport
            project={project}
            time={time}
            sequenceId={right}
            name="B"
            onReady={(value) =>
              setReady((previous) => (previous.right === value ? previous : { ...previous, right: value }))
            }
          />
        </div>
        <div className="compare-transport">
          <IconButton icon={ChevronFirst} label="对比回到开头" onClick={() => seek(0)} />
          <IconButton icon={SkipBack} label="对比上一帧" onClick={() => seek(time - 1 / fps)} />
          <IconButton
            icon={playing ? Pause : Play}
            label={playing ? '暂停对比' : '播放对比'}
            disabled={!ready.left || !ready.right || !duration}
            onClick={() => {
              if (!playing && time >= duration) setTime(0);
              setPlaying(!playing);
            }}
          />
          <IconButton icon={SkipForward} label="对比下一帧" onClick={() => seek(time + 1 / fps)} />
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={1 / fps}
            value={Math.min(time, duration)}
            aria-label="对比成片时间"
            onChange={(event) => seek(Number(event.target.value))}
          />
          <span className="mono compare-clock">
            {time.toFixed(2)} / {duration.toFixed(2)}s
          </span>
        </div>
      </div>
    </Modal>
  );
}

function CompareViewport({
  project,
  sequenceId,
  time,
  name,
  onReady,
}: {
  project: Project;
  sequenceId: string;
  time: number;
  name: string;
  onReady: (value: boolean) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const engine = useRef<SceneEngine | null>(null);
  const state = useRef({ time, sequenceId, onReady });
  state.current = { time, sequenceId, onReady };
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const duration = sequenceDuration(project, sequenceId);
  const visibleTime = Math.min(time, Math.max(0, duration - 1 / project.settings.fps));
  const sample = sampleTimeline(project, visibleTime, sequenceId);
  useEffect(() => {
    const renderer = new SceneEngine(element.current!, { interactive: false });
    engine.current = renderer;
    renderer.setHelpers(false);
    renderer.setView('camera');
    return () => {
      renderer.dispose();
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    state.current.onReady(false);
    const renderer = engine.current!;
    void renderer
      .setProject(project)
      .then(() => {
        if (!current) return;
        const last = Math.max(
          0,
          sequenceDuration(project, state.current.sequenceId) - 1 / project.settings.fps,
        );
        renderer.setTime(Math.min(state.current.time, last), { sequenceId: state.current.sequenceId });
        setLoading(false);
        state.current.onReady(true);
      })
      .catch((error) => {
        if (current) {
          setError(error.message);
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [project]);
  useEffect(() => {
    engine.current?.setTime(visibleTime, { sequenceId });
  }, [visibleTime, sequenceId]);
  return (
    <div className="compare-column" data-testid={`compare-${name}`}>
      <div
        className="compare-viewport"
        ref={element}
        style={{ aspectRatio: project.settings.aspect.replace(':', ' / ') }}
      />
      {loading && (
        <div className="compare-loading" role="status">
          载入中...
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="compare-frame-meta">
        <strong>{sample.shot?.name ?? '空方案'}</strong>
        <span className="mono">源 {sample.sourceTime.toFixed(3)}s</span>
        {time >= duration && duration > 0 && <span className="muted small">末帧</span>}
      </div>
    </div>
  );
}
