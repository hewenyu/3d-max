import { Copy, Layers, LockKeyhole, Plus, Trash2, UnlockKeyhole } from 'lucide-react';
import type { Command, Project } from '../../shared/types';
import {
  affectedShots,
  comparePerformances,
  productionPerformance,
  productionScene,
} from '../../shared/production';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, Section, TextInput } from './Controls';

export function ProductionPanel({
  project,
  editor,
  onContextChange,
}: {
  project: Project;
  editor: EditorActions;
  onContextChange: () => void;
}) {
  const state = project.production;
  const scene = productionScene(project);
  const take = productionPerformance(project);
  const run = async (build: (latest: Project) => Command[]) => {
    onContextChange();
    try {
      if (!state) await editor.command('production.initialize', {}, { projectId: project.id });
      await editor.command(build, undefined, { projectId: project.id });
    } catch {
      /* The shared editor displays validated command errors. */
    }
  };
  const scenePatch = (patch: Record<string, unknown>) =>
    void run((latest) => [
      { type: 'scene.update', payload: { id: latest.production!.activeSceneId, patch } },
    ]);
  const takePatch = (patch: Record<string, unknown>) =>
    void run((latest) => [
      {
        type: 'performance.update',
        payload: {
          sceneId: latest.production!.activeSceneId,
          id: latest.production!.activePerformanceId,
          patch,
        },
      },
    ]);
  return (
    <div className="production-panel">
      <Section
        title="布景"
        extra={
          <IconButton
            icon={Plus}
            label="新增场景"
            onClick={() =>
              void run((latest) => [
                { type: 'scene.create', payload: { name: `场景 ${latest.production!.scenes.length + 1}` } },
              ])
            }
          />
        }
      >
        <Field label="当前场景">
          <select
            aria-label="当前场景"
            value={scene?.id ?? ''}
            onChange={(event) => {
              const sceneId = event.currentTarget.value;
              void run(() => [{ type: 'scene.select', payload: { sceneId } }]);
            }}
          >
            {state ? (
              state.scenes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))
            ) : (
              <option value="">{project.sceneName}</option>
            )}
          </select>
        </Field>
        <Field label="场景名称">
          <TextInput
            label="场景名称"
            value={scene?.name ?? project.sceneName}
            onChange={(name) => scenePatch({ name })}
          />
        </Field>
        <div className="row">
          <IconButton
            icon={Copy}
            label="复用当前布景"
            onClick={() =>
              void run((latest) => [
                {
                  type: 'scene.create',
                  payload: {
                    name: `${latest.sceneName} 副本`,
                    sourceSceneId: latest.production!.activeSceneId,
                  },
                },
              ])
            }
          />
          <IconButton
            icon={scene?.locked ? LockKeyhole : UnlockKeyhole}
            label={scene?.locked ? '解锁布景' : '锁定布景'}
            onClick={() => scenePatch({ locked: !scene?.locked })}
          />
          <span className="flex-spacer" />
          <IconButton
            icon={Trash2}
            label="删除当前场景"
            disabled={
              !scene ||
              state!.scenes.length < 2 ||
              affectedShots(project, scene.id).length > 0 ||
              state!.storyScenes.some((item) => item.sceneId === scene.id)
            }
            onClick={() => scene && void run(() => [{ type: 'scene.delete', payload: { id: scene.id } }])}
          />
        </div>
      </Section>
      <Section
        title="表演版本"
        extra={
          <IconButton
            icon={Copy}
            label="复制表演版本"
            onClick={() =>
              void run((latest) => [
                {
                  type: 'performance.duplicate',
                  payload: {
                    sceneId: latest.production!.activeSceneId,
                    id: latest.production!.activePerformanceId,
                    name: `表演 ${productionScene(latest)!.performances.length + 1}`,
                  },
                },
              ])
            }
          />
        }
      >
        <Field label="当前表演">
          <select
            aria-label="当前表演"
            value={take?.id ?? ''}
            onChange={(event) => {
              const id = event.currentTarget.value;
              void run((latest) => [
                {
                  type: 'performance.select',
                  payload: { sceneId: latest.production!.activeSceneId, id },
                },
              ]);
            }}
          >
            {scene ? (
              scene.performances.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))
            ) : (
              <option value="">表演 A</option>
            )}
          </select>
        </Field>
        <Field label="版本名称">
          <TextInput
            label="表演版本名称"
            value={take?.name ?? '表演 A'}
            onChange={(name) => takePatch({ name })}
          />
        </Field>
        <div className="row">
          <IconButton
            icon={take?.locked ? LockKeyhole : UnlockKeyhole}
            label={take?.locked ? '解锁表演' : '锁定表演'}
            onClick={() => takePatch({ locked: !take?.locked })}
          />
          <span className="flex-spacer" />
          <IconButton
            icon={Trash2}
            label="删除表演版本"
            disabled={
              !take ||
              !scene ||
              scene.performances.length < 2 ||
              affectedShots(project, scene.id, take.id).length > 0 ||
              state!.storyScenes.some((item) => item.performanceId === take.id)
            }
            onClick={() =>
              scene &&
              take &&
              void run(() => [{ type: 'performance.delete', payload: { sceneId: scene.id, id: take.id } }])
            }
          />
        </div>
        {scene && take && scene.performances.length > 1 && (
          <details className="performance-differences">
            <summary>版本差异</summary>
            {scene.performances
              .filter((item) => item.id !== take.id)
              .map((item) => {
                const difference = comparePerformances(project, scene.id, item.id, take.id);
                return (
                  <div className="production-difference" key={item.id}>
                    <strong>{item.name}</strong>
                    <span>{difference.changedObjectIds.length} 个对象差异</span>
                    {difference.beatsChanged && <span>节拍不同</span>}
                    {difference.audioChanged && <span>音轨不同</span>}
                    {difference.synchronizationChanged && <span>同步关联不同</span>}
                  </div>
                );
              })}
          </details>
        )}
      </Section>
      <Section title="关联镜头">
        {(scene ? affectedShots(project, scene.id, take?.id) : project.shots).map((shot) => (
          <div className="production-shot" key={shot.id}>
            <Layers size={13} />
            <span>{shot.name}</span>
            <span className="muted small">{shot.locked ? '已锁定' : ''}</span>
          </div>
        ))}
        <div className="small muted">
          {scene ? affectedShots(project, scene.id).length : project.shots.length} 个镜头共享布景
        </div>
      </Section>
      <Section
        title="剧情场次"
        extra={
          <IconButton
            icon={Plus}
            label="新增剧情场次"
            onClick={() =>
              void run((latest) => [
                {
                  type: 'storyScene.create',
                  payload: {
                    name: `场次 ${latest.production!.storyScenes.length + 1}`,
                    sceneId: latest.production!.activeSceneId,
                    performanceId: latest.production!.activePerformanceId,
                    location: latest.sceneName,
                    timeOfDay: '日',
                    description: '',
                  },
                },
              ])
            }
          />
        }
      >
        {state?.storyScenes.map((story) => (
          <div className="story-scene-entry" key={story.id}>
            <Field label="场次">
              <TextInput
                label={`场次名称 ${story.name}`}
                value={story.name}
                onChange={(name) => editor.run('storyScene.update', { id: story.id, patch: { name } })}
              />
            </Field>
            <Field label="地点">
              <TextInput
                value={story.location}
                onChange={(location) =>
                  editor.run('storyScene.update', { id: story.id, patch: { location } })
                }
              />
            </Field>
            <Field label="时段">
              <TextInput
                value={story.timeOfDay}
                onChange={(timeOfDay) =>
                  editor.run('storyScene.update', { id: story.id, patch: { timeOfDay } })
                }
              />
            </Field>
            <Field label="剧情">
              <TextInput
                multiline
                value={story.description}
                onChange={(description) =>
                  editor.run('storyScene.update', { id: story.id, patch: { description } })
                }
              />
            </Field>
            <div className="row">
              <button
                className="secondary-button"
                onClick={() =>
                  void run(() => [
                    {
                      type: 'scene.select',
                      payload: { sceneId: story.sceneId, performanceId: story.performanceId },
                    },
                  ])
                }
              >
                <Layers size={13} />
                打开场次
              </button>
              <span className="flex-spacer" />
              <IconButton
                icon={Trash2}
                label={`删除场次 ${story.name}`}
                disabled={project.shots.some((shot) => shot.storySceneId === story.id)}
                onClick={() => editor.run('storyScene.delete', { id: story.id })}
              />
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}
