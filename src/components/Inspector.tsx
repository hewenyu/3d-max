import { Camera, CircleUserRound, Clapperboard, SlidersHorizontal, Sun, X } from 'lucide-react';
import type { Project, SequenceClip, Shot, Vec3 } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { ObjectInspector } from './ObjectInspector';
import { SelectionInspector } from './SelectionInspector';
import { CameraInspector } from './CameraInspector';
import { DirectorPanel } from './DirectorPanel';
import { Empty, Field, IconButton, Section } from './Controls';
import { LightingPlansPanel } from './LightingPlansPanel';
import type { ActorConstraintResult } from '../../shared/actor-animation';

export type InspectorTab = 'shot' | 'object' | 'director' | 'settings';
export function Inspector({
  project,
  selected,
  shot,
  clip,
  sourceTime,
  cameraTime,
  onCameraSeek,
  time,
  editor,
  tab,
  setTab,
  onSeek,
  getView,
  getTarget,
  getConstraints,
  onClose,
  onSelect,
}: {
  project: Project;
  selected: string[];
  shot: Shot | null;
  clip?: SequenceClip | null;
  sourceTime: number;
  cameraTime: number;
  onCameraSeek: (cameraTime: number) => void;
  time: number;
  editor: EditorActions;
  tab: InspectorTab;
  setTab: (tab: InspectorTab) => void;
  onSeek: (sourceTime: number) => void;
  getView: () => { position: Vec3; target: Vec3; fov: number } | undefined;
  getTarget: (id: string) => Vec3 | undefined;
  getConstraints: (id: string) => ActorConstraintResult[];
  onClose: () => void;
  onSelect: (ids: string[]) => void;
}) {
  const object = project.objects.find((o) => o.id === selected[0]);
  const objects = project.objects.filter((item) => selected.includes(item.id));
  const camera =
    tab === 'shot'
      ? project.cameras.find((c) => c.id === shot?.cameraId)
      : project.cameras.find((c) => c.id === selected[0]);
  const settings = project.settings;
  return (
    <aside className="inspector">
      <div className="panel-heading">
        <SlidersHorizontal size={15} />
        <strong>属性</strong>
        <span className="flex-spacer" />
        <IconButton icon={X} label="收起属性面板" className="mobile-only" onClick={onClose} />
      </div>
      <div className="inspector-tabs">
        {(
          [
            { id: 'shot', label: '镜头', icon: Camera },
            { id: 'object', label: '对象', icon: CircleUserRound },
            { id: 'director', label: '导演', icon: Clapperboard },
            { id: 'settings', label: '环境', icon: Sun },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            title={item.label}
            className={tab === item.id ? 'selected' : ''}
            onClick={() => setTab(item.id)}
          >
            <item.icon size={15} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div className="inspector-content">
        {tab === 'object' &&
          (objects.length > 1 ? (
            <SelectionInspector objects={objects} editor={editor} onSelect={onSelect} />
          ) : object ? (
            <ObjectInspector
              key={object.id}
              project={project}
              object={object}
              editor={editor}
              sourceTime={sourceTime}
              onSeek={onSeek}
              getConstraints={getConstraints}
            />
          ) : camera && project.cameras.some((c) => c.id === selected[0]) ? (
            <CameraInspector
              project={project}
              camera={camera}
              clip={shot?.cameraId === camera.id ? clip : null}
              editor={editor}
              sourceTime={cameraTime}
              subjectTime={sourceTime}
              onSeek={onCameraSeek}
              getView={getView}
              getTarget={getTarget}
            />
          ) : (
            <Empty>未选择对象</Empty>
          ))}
        {tab === 'shot' &&
          (camera ? (
            <CameraInspector
              key={camera.id}
              project={project}
              camera={camera}
              shot={shot}
              clip={clip}
              editor={editor}
              sourceTime={cameraTime}
              subjectTime={sourceTime}
              onSeek={onCameraSeek}
              getView={getView}
              getTarget={getTarget}
            />
          ) : (
            <Empty>暂无摄影机</Empty>
          ))}
        {tab === 'director' && (
          <DirectorPanel
            project={project}
            editor={editor}
            sourceTime={sourceTime}
            time={time}
            shot={shot}
            onSeek={onSeek}
          />
        )}
        {tab === 'settings' && (
          <>
            <Section title="输出画幅">
              <Field label="比例">
                <select
                  value={settings.aspect}
                  onChange={(e) => editor.run('project.settings', { aspect: e.target.value })}
                >
                  <option value="16:9">16:9 横屏</option>
                  <option value="9:16">9:16 竖屏</option>
                  <option value="1:1">1:1 方形</option>
                </select>
              </Field>
              <Field label="帧率">
                <select
                  value={settings.fps}
                  onChange={(e) => editor.run('project.settings', { fps: Number(e.target.value) })}
                >
                  {[24, 25, 30].map((fps) => (
                    <option key={fps} value={fps}>
                      {fps} fps
                    </option>
                  ))}
                </select>
              </Field>
            </Section>
            <Section title="基础灯光">
              <Field label="无限地面">
                <input
                  type="checkbox"
                  aria-label="显示地面"
                  checked={settings.environment?.ground ?? true}
                  onChange={(event) =>
                    editor.run((latest) => [
                      {
                        type: 'project.settings',
                        payload: {
                          environment: {
                            background: '#cfd6d3',
                            groundTone: '#d1d7d3',
                            ...latest.settings.environment,
                            ground: event.target.checked,
                          },
                        },
                      },
                    ])
                  }
                />
              </Field>
              {(
                [
                  ['background', '背景颜色', '#cfd6d3'],
                  ['groundTone', '地面颜色', '#d1d7d3'],
                ] as const
              ).map(([key, label, fallback]) => (
                <Field key={key} label={label}>
                  <input
                    type="color"
                    aria-label={label}
                    value={settings.environment?.[key] ?? fallback}
                    onChange={(event) =>
                      editor.run((latest) => [
                        {
                          type: 'project.settings',
                          payload: {
                            environment: {
                              ground: true,
                              background: '#cfd6d3',
                              groundTone: '#d1d7d3',
                              ...latest.settings.environment,
                              [key]: event.target.value,
                            },
                          },
                        },
                      ])
                    }
                  />
                </Field>
              ))}
            </Section>
            <LightingPlansPanel
              key={`${project.id}:${project.production?.activeSceneId ?? ''}`}
              project={project}
              editor={editor}
            />
            <Section title="交流轴线">
              {[0, 1].map((index) => (
                <Field key={index} label={`角色 ${index + 1}`}>
                  <select
                    value={settings.axisActorIds[index] ?? ''}
                    onChange={(e) => {
                      const ids = [...settings.axisActorIds];
                      ids[index] = e.target.value;
                      editor.run('project.settings', { axisActorIds: ids.filter(Boolean) });
                    }}
                  >
                    <option value="">未指定</option>
                    {project.objects
                      .filter((o) => o.type === 'actor')
                      .map((o) => (
                        <option value={o.id} key={o.id}>
                          {o.name}
                        </option>
                      ))}
                  </select>
                </Field>
              ))}
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}
