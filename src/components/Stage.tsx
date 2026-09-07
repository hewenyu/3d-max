import { useEffect, useRef, useState } from 'react';
import type { Project, Shot } from '../../shared/types';
import { SceneEngine } from '../engine/SceneEngine';
import { sampleTimeline } from '../../shared/timeline';
import type { EditorActions } from '../useEditor';
import { requestShotThumbnail } from '../engine/ThumbnailRenderer';

export type ViewMode = 'edit' | 'camera' | 'top';
export function Stage({
  project,
  time,
  mode,
  selected,
  tool,
  snap,
  helpers,
  safeFrame,
  onSelect,
  editor,
  engineRef,
}: {
  project: Project;
  time: number;
  mode: ViewMode;
  selected: string[];
  tool: 'translate' | 'rotate' | 'scale';
  snap: boolean;
  helpers: boolean;
  safeFrame: boolean;
  onSelect: (ids: string[]) => void;
  editor: EditorActions;
  engineRef: React.RefObject<SceneEngine | null>;
}) {
  const element = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSelect, editor });
  callbacks.current = { onSelect, editor };
  const state = useRef({ time, mode, project, selected });
  state.current = { time, mode, project, selected };
  useEffect(() => {
    if (!element.current) return;
    const engine = new SceneEngine(element.current, {
      interactive: true,
      onSelect: (id, additive) => {
        const selected = state.current.selected;
        callbacks.current.onSelect(
          id
            ? additive
              ? selected.includes(id)
                ? selected.filter((item) => item !== id)
                : [...selected, id]
              : [id]
            : additive
              ? selected
              : [],
        );
      },
      onTransform: (id, patch) => {
        const project = state.current.project;
        const object = project.objects.find((item) => item.id === id);
        if (!object || object.locked) return;
        if (!object.keyframes.length) {
          callbacks.current.editor.run('object.update', { id, patch });
          return;
        }
        const sourceTime = sampleTimeline(project, state.current.time).sourceTime;
        const frameTime = Math.round(sourceTime * project.settings.fps) / project.settings.fps;
        const existing = object.keyframes.find(
          (frame) => Math.abs(frame.time - frameTime) < 0.5 / project.settings.fps,
        );
        callbacks.current.editor.run('object.keyframe.set', {
          id,
          keyframe: {
            ...existing,
            id: existing?.id ?? crypto.randomUUID(),
            time: frameTime,
            ...patch,
            easing: existing?.easing ?? 'linear',
          },
        });
      },
    });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [engineRef]);
  useEffect(() => {
    const engine = engineRef.current;
    let current = true;
    if (engine)
      void engine
        .setProject(project)
        .then(() => {
          if (!current || engineRef.current !== engine) return;
          engine.setView(state.current.mode);
          engine.setTime(state.current.time);
        })
        .catch((e) => {
          if (current) callbacks.current.editor.setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [project, engineRef]);
  useEffect(() => {
    engineRef.current?.setTime(time);
  }, [time, engineRef]);
  useEffect(() => {
    engineRef.current?.setView(mode);
  }, [mode, engineRef]);
  useEffect(() => {
    engineRef.current?.setSelection(selected);
  }, [selected, engineRef]);
  useEffect(() => {
    engineRef.current?.setTransformMode(tool);
  }, [tool, engineRef]);
  useEffect(() => {
    engineRef.current?.setSnap(snap);
  }, [snap, engineRef]);
  useEffect(() => {
    engineRef.current?.setHelpers(helpers);
  }, [helpers, engineRef]);
  useEffect(() => {
    engineRef.current?.setSafeFrame(safeFrame);
  }, [safeFrame, engineRef]);
  return <div ref={element} className="stage-canvas" data-testid="stage" />;
}

export function ShotThumbnail({ project, shot }: { project: Project; shot: Shot }) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    if (!element.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '160px',
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void requestShotThumbnail(project, shot)
      .then((result) => {
        if (!cancelled && result) setSource(result);
      })
      .catch(() => {
        if (!cancelled) setSource(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project, shot, visible]);
  return (
    <div className="shot-thumbnail" ref={element} aria-hidden="true" style={{ background: '#1c2623' }}>
      {source && (
        <img
          src={source}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
        />
      )}
    </div>
  );
}
