import { useState } from 'react';
import { Clapperboard } from 'lucide-react';
import type { Project, Shot, ShotCamera } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { Field, NumberInput, Section } from './Controls';

export function CameraMotionPanel({
  project,
  camera,
  shot,
  sourceTime,
  locked,
  editor,
}: {
  project: Project;
  camera: ShotCamera;
  shot?: Shot | null;
  sourceTime: number;
  locked: boolean;
  editor: EditorActions;
}) {
  const [motion, setMotion] = useState('dolly_in');
  const [distance, setDistance] = useState(0.8);
  const [angle, setAngle] = useState(35);
  const [easing, setEasing] = useState('smooth');
  const [subjectId, setSubjectId] = useState(shot?.subjectIds[0] ?? '');
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
              {project.objects
                .filter((o) => !o.attachment)
                .map((o) => (
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
        <button
          className="text-button full-width"
          disabled={motion === 'follow' && !subjectId}
          onClick={() =>
            editor.run('camera.motion', {
              id: camera.id,
              motion,
              start: shot?.sourceIn ?? sourceTime,
              end: shot?.sourceOut ?? sourceTime + 3,
              distance,
              angle,
              easing,
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
