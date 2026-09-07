import { useState } from 'react';
import { Check } from 'lucide-react';
import type { Project, Sequence, SequenceClip } from '../../shared/types';
import { clipDuration, sampleClipTime } from '../../shared/time-map';
import { transitionIssues } from '../../shared/transitions';
import type { EditorActions } from '../useEditor';
import { Field, Modal, NumberInput } from './Controls';
import './transitions.css';

export function TransitionPanel({
  project,
  sequence,
  clip,
  editor,
  onClose,
}: {
  project: Project;
  sequence: Sequence;
  clip: SequenceClip;
  editor: EditorActions;
  onClose: () => void;
}) {
  const [fadeIn, setFadeIn] = useState(clip.fadeIn ?? 0);
  const [fadeOut, setFadeOut] = useState(clip.fadeOut ?? 0);
  const [dissolve, setDissolve] = useState(Boolean(clip.transitionIn));
  const [duration, setDuration] = useState(clip.transitionIn?.duration ?? 0.5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const index = sequence.clips.findIndex((item) => item.id === clip.id);
  const previous = sequence.clips[index - 1];
  const next = sequence.clips[index + 1];
  const shot = project.shots.find((item) => item.id === clip.shotId)!;
  const previousShot = project.shots.find((item) => item.id === previous?.shotId);
  const incomingHandle = (clip.sourceIn - shot.sourceIn) / sampleClipTime(clip, 0).playbackRate;
  const outgoingHandle =
    previous && previousShot
      ? (previousShot.sourceOut - previous.sourceOut) /
        sampleClipTime(previous, clipDuration(previous)).playbackRate
      : 0;
  const candidate: SequenceClip = {
    ...clip,
    fadeIn: fadeIn || undefined,
    fadeOut: fadeOut || undefined,
    transitionIn: dissolve ? { type: 'dissolve', duration } : undefined,
  };
  const issues = transitionIssues(
    { ...sequence, clips: sequence.clips.map((item) => (item.id === clip.id ? candidate : item)) },
    new Map(project.shots.map((item) => [item.id, item])),
  );
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await editor.command('clip.transition', {
        sequenceId: sequence.id,
        clipId: clip.id,
        fadeIn: fadeIn || null,
        fadeOut: fadeOut || null,
        transitionIn: candidate.transitionIn ?? null,
      });
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="画面转场" onClose={onClose}>
      <div className="transition-panel">
        <strong>{shot.name}</strong>
        <div className="transition-fields">
          <Field label="淡入 / 秒">
            <NumberInput
              label="画面淡入时长"
              value={fadeIn}
              min={0}
              max={clipDuration(clip)}
              step={1 / project.settings.fps}
              onChange={setFadeIn}
            />
          </Field>
          <Field label="淡出 / 秒">
            <NumberInput
              label="画面淡出时长"
              value={fadeOut}
              min={0}
              max={clipDuration(clip)}
              step={1 / project.settings.fps}
              onChange={setFadeOut}
            />
          </Field>
          <Field label="前镜头转场">
            <select
              aria-label="前镜头转场"
              value={dissolve ? 'dissolve' : 'cut'}
              disabled={!previous}
              onChange={(event) => {
                setDissolve(event.target.value === 'dissolve');
                if (event.target.value === 'dissolve') setFadeIn(0);
              }}
            >
              <option value="cut">硬切</option>
              <option value="dissolve">交叉溶解</option>
            </select>
          </Field>
          {dissolve && (
            <Field label="溶解 / 秒">
              <NumberInput
                label="交叉溶解时长"
                value={duration}
                min={1 / project.settings.fps}
                max={clipDuration(clip) * 2}
                step={1 / project.settings.fps}
                onChange={setDuration}
              />
            </Field>
          )}
        </div>
        {previous && (
          <dl className="transition-metadata">
            <dt>前镜头尾部余量</dt>
            <dd>{outgoingHandle.toFixed(3)} s</dd>
            <dt>本镜头头部余量</dt>
            <dd>{incomingHandle.toFixed(3)} s</dd>
            <dt>切点前后溶解</dt>
            <dd>{dissolve ? (duration / 2).toFixed(3) : '0.000'} s</dd>
          </dl>
        )}
        {next?.transitionIn && (
          <div className="muted">后镜头溶解 {next.transitionIn.duration.toFixed(3)} s</div>
        )}
        {(error || issues.length > 0) && (
          <p className="inline-error" role="alert">
            {error || issues.join('\n')}
          </p>
        )}
        <div className="dialog-actions">
          <button className="primary-button" disabled={busy || issues.length > 0} onClick={() => void save()}>
            <Check size={14} />
            应用
          </button>
        </div>
      </div>
    </Modal>
  );
}
