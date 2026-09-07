import { useState } from 'react';
import { Clapperboard } from 'lucide-react';
import type { Project, SequenceClip, Shot, ShotCamera } from '../../shared/types';
import { clipDuration, sampleClipTime } from '../../shared/time-map';
import { resolveShotProject } from '../../shared/production';
import type { EditorActions } from '../useEditor';
import { Field, NumberInput, Section } from './Controls';

export function CameraMotionPanel({
  project,
  camera,
  shot,
  clip,
  sourceTime,
  locked,
  editor,
}: {
  project: Project;
  camera: ShotCamera;
  shot?: Shot | null;
  clip?: SequenceClip | null;
  sourceTime: number;
  locked: boolean;
  editor: EditorActions;
}) {
  const motionShot = shot ?? project.shots.find((item) => item.id === clip?.shotId);
  const subjects = resolveShotProject(project, motionShot ?? null).objects;
  const startTime = clip ? sampleClipTime(clip, 0).cameraTime : (motionShot?.sourceIn ?? sourceTime);
  const endTime = clip
    ? sampleClipTime(clip, clipDuration(clip)).cameraTime
    : (motionShot?.sourceOut ?? sourceTime + 3);
  const frozen = Math.abs(endTime - startTime) < 1e-9;
  const [motion, setMotion] = useState('dolly_in');
  const [distance, setDistance] = useState(0.8);
  const [angle, setAngle] = useState(35);
  const [easing, setEasing] = useState('smooth');
  const [subjectId, setSubjectId] = useState(motionShot?.subjectIds[0] ?? '');
  const [rotateWithSubject, setRotateWithSubject] = useState(false);
  return (
    <Section title="运镜">
      <fieldset disabled={locked}>
        <Field label="运动方式">
          <select aria-label="运动方式" value={motion} onChange={(e) => setMotion(e.target.value)}>
            <option value="hold">固定</option>
            <option value="dolly_in">推进</option>
            <option value="dolly_out">拉远</option>
            <option value="pan">摇镜</option>
            <option value="truck">横移</option>
            <option value="pedestal">升降</option>
            <option value="orbit">环绕</option>
            <option value="follow">跟随</option>
          </select>
        </Field>
        {['pan', 'orbit'].includes(motion) ? (
          <Field label="角度">
            <NumberInput value={angle} min={-360} max={360} step={5} suffix="°" onChange={setAngle} />
          </Field>
        ) : (
          !['hold', 'follow'].includes(motion) && (
            <Field label="距离">
              <NumberInput value={distance} min={-100} max={100} suffix="m" onChange={setDistance} />
            </Field>
          )
        )}
        {['follow', 'orbit'].includes(motion) && (
          <Field label="主体">
            <select aria-label="运镜主体" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              <option value="">当前朝向目标</option>
              {subjects.map((o) => (
                <option value={o.id} key={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="速度曲线">
          <select value={easing} onChange={(e) => setEasing(e.target.value)}>
            <option value="smooth">缓入缓出</option>
            <option value="linear">匀速</option>
          </select>
        </Field>
        {motion === 'follow' && (
          <Field label="随主体转向">
            <input
              type="checkbox"
              aria-label="摄影机随主体转向"
              checked={rotateWithSubject}
              onChange={(event) => setRotateWithSubject(event.target.checked)}
            />
          </Field>
        )}
        <button
          className="text-button full-width"
          disabled={frozen || (motion === 'follow' && !subjectId)}
          title={frozen ? '机位时间已冻结，请先设置非零机位速度' : undefined}
          onClick={() =>
            editor.run('camera.motion', {
              id: camera.id,
              ...(camera.compositions?.[project.settings.aspect] ? { aspect: project.settings.aspect } : {}),
              motion,
              ...(motionShot ? { shotId: motionShot.id } : {}),
              ...(clip ? { sequenceId: project.activeSequenceId, clipId: clip.id } : {}),
              start: Math.min(startTime, endTime),
              end: Math.max(startTime, endTime),
              distance,
              angle,
              easing,
              rotateWithSubject,
              ...(['follow', 'orbit'].includes(motion) && subjectId ? { subjectId } : {}),
            })
          }
        >
          <Clapperboard size={14} />
          生成运镜关键帧
        </button>
      </fieldset>
    </Section>
  );
}
