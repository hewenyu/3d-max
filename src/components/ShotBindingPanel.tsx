import type { Project, Shot } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { productionScene } from '../../shared/production';
import { Field, Section } from './Controls';

export function ShotBindingPanel({
  project,
  shot,
  editor,
}: {
  project: Project;
  shot: Shot;
  editor: EditorActions;
}) {
  if (!project.production) return null;
  const scene = productionScene(project, shot.sceneId);
  const bind = (sceneId: string, performanceId?: string, storySceneId?: string) => {
    editor.run((latest) => {
      const target = productionScene(latest, sceneId);
      const take = target?.performances.find(
        (item) => item.id === (performanceId ?? target.performances[0]?.id),
      );
      const current = latest.shots.find((item) => item.id === shot.id);
      if (!target || !take || !current) throw new Error('场景、表演或镜头已变更');
      const objectIds = new Set(target.objects.map((object) => object.id));
      return [
        {
          type: 'shot.update',
          payload: {
            id: shot.id,
            patch: {
              subjectIds: current.subjectIds.filter((id) => objectIds.has(id)),
              hiddenIds: current.hiddenIds.filter((id) => objectIds.has(id)),
              beatId: take.beats.some((beat) => beat.id === current.beatId) ? current.beatId : null,
            },
          },
        },
        {
          type: 'shot.binding',
          payload: {
            id: shot.id,
            sceneId,
            performanceId: take.id,
            ...(storySceneId ? { storySceneId } : {}),
          },
        },
        { type: 'scene.select', payload: { sceneId, performanceId: take.id } },
      ];
    });
  };
  return (
    <Section title="拍摄场次与表演">
      <fieldset disabled={shot.locked}>
        <Field label="布景">
          <select
            aria-label="镜头绑定布景"
            value={scene?.id ?? ''}
            onChange={(event) => bind(event.currentTarget.value)}
          >
            {project.production.scenes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="表演版本">
          <select
            aria-label="镜头绑定表演"
            value={shot.performanceId ?? ''}
            onChange={(event) => scene && bind(scene.id, event.currentTarget.value)}
          >
            {scene?.performances.map((take) => (
              <option key={take.id} value={take.id}>
                {take.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="剧情场次">
          <select
            aria-label="镜头剧情场次"
            value={shot.storySceneId ?? ''}
            onChange={(event) => {
              const story = project.production!.storyScenes.find(
                (item) => item.id === event.currentTarget.value,
              );
              if (story) bind(story.sceneId, story.performanceId, story.id);
              else if (scene) bind(scene.id, shot.performanceId);
            }}
          >
            <option value="">未关联</option>
            {project.production.storyScenes.map((story) => (
              <option key={story.id} value={story.id}>
                {story.name}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>
    </Section>
  );
}
