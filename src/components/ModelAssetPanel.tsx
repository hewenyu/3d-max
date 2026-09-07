import { useEffect, useState } from 'react';
import type { ModelCatalog } from '../../shared/model-catalog';
import type { Project, SceneObject } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { api } from '../api';
import { Field, Section } from './Controls';

export function ModelAssetPanel({
  object,
  project,
  editor,
}: {
  object: SceneObject;
  project: Project;
  editor: EditorActions;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setCatalog(undefined);
    setError('');
    api<ModelCatalog>('/models/catalog', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, objectId: object.id }),
    })
      .then((value) => {
        if (!cancelled) setCatalog(value);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [object.id, object.assetUrl, project.id]);
  const selected =
    object.animationIndex === null
      ? 'static'
      : String(
          object.animationIndex ??
            (object.animationName
              ? (catalog?.animations.find((item) => item.name === object.animationName)?.index ?? 0)
              : 0),
        );
  return (
    <Section title="导入模型">
      {error && <p role="alert">{error}</p>}
      {!error && !catalog && <p role="status">正在读取模型目录</p>}
      {catalog && (
        <>
          <Field label="内嵌动画">
            <select
              aria-label="内嵌动画"
              value={catalog.animations.length ? selected : 'static'}
              disabled={object.locked || !catalog.animations.length}
              onChange={(event) =>
                editor.run('model.animation.set', {
                  id: object.id,
                  animationIndex: event.target.value === 'static' ? null : Number(event.target.value),
                })
              }
            >
              <option value="static">静态姿态</option>
              {catalog.animations.map((animation) => (
                <option value={animation.index} key={animation.index}>
                  {animation.name} · {animation.duration.toFixed(2)} s
                </option>
              ))}
            </select>
          </Field>
          <div className="lens-readout">
            <span>骨架</span>
            <b>{catalog.skins.length ? `${catalog.skins.length} 组` : '无蒙皮骨架'}</b>
          </div>
          <div className="lens-readout">
            <span>内置人物动作重定向</span>
            <b>不兼容</b>
          </div>
          {catalog.skins.map((skin) => (
            <details key={skin.index}>
              <summary>
                {skin.name} · {skin.joints.length} 关节
              </summary>
              <ul>
                {skin.joints.map((index) => (
                  <li key={index}>{catalog.nodes[index]?.name ?? index}</li>
                ))}
              </ul>
            </details>
          ))}
          <details>
            <summary>模型层级 · {catalog.nodes.length} 节点</summary>
            <ul>
              {catalog.nodes.map((node) => (
                <li key={node.index}>
                  {node.name}
                  {node.parent !== null ? ` / ${catalog.nodes[node.parent]?.name ?? node.parent}` : ''}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </Section>
  );
}
