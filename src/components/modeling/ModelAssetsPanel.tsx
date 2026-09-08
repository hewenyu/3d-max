import { useEffect, useRef, useState } from 'react';
import { Box, Check, Download, FileSearch, RefreshCw, ScanLine, X } from 'lucide-react';
import type { Project, SceneObject } from '../../../shared/types';
import type { EditorActions } from '../../useEditor';
import type { ModelingJob } from '../../../shared/modeling-jobs';
import { Field, IconButton, TextInput } from '../Controls';
import { ModelingNumberInput } from './ModelingNumberInput';
import { TopologyCheck, TopologySelect } from './TopologyFields';
import {
  ModelAssetError,
  cancelModelAsset,
  modelAssetGuard,
  modelDiagnosticMessage,
  requestModelAsset,
  type ModelConversion,
  type ModelDiagnostic,
  type ModelExport,
} from './model-assets-client';
import './model-assets.css';

function Diagnostics({ items, project }: { items: ModelDiagnostic[]; project: Project }) {
  return (
    <ul className="model-asset-diagnostics">
      {items.map((item, index) => (
        <li key={`${item.code}-${index}`}>
          <span>{modelDiagnosticMessage(item)}</span>
          {(item.node !== undefined || item.primitive !== undefined || item.attributes?.length) && (
            <small>
              {[
                item.node !== undefined && `节点 ${item.node + 1}`,
                item.primitive !== undefined && `图元 ${item.primitive + 1}`,
                item.attributes?.join(', '),
              ]
                .filter(Boolean)
                .join(' · ')}
            </small>
          )}
          {item.objectId && (
            <small>
              {project.objects.find((object) => object.id === item.objectId)?.name ?? item.objectId}
            </small>
          )}
        </li>
      ))}
    </ul>
  );
}
const sizeLabel = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;

export function ModelAssetsPanel({
  project,
  editor,
  object,
  objectIds,
  sourceTime = 0,
}: {
  project: Project;
  editor: EditorActions;
  object?: SceneObject;
  objectIds?: string[];
  sourceTime?: number;
}) {
  const [plan, setPlan] = useState<ModelConversion | null>(null);
  const [exported, setExported] = useState<ModelExport | null>(null);
  const [failure, setFailure] = useState<ModelAssetError | null>(null);
  const [busy, setBusy] = useState<'conversion' | 'export' | null>(null);
  const [job, setJob] = useState<ModelingJob | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const ids = objectIds ?? (object ? [object.id] : []);
  const sourceUrl = object?.assetUrl ?? object?.sourceAssetUrl;
  const selectionKey = JSON.stringify(ids);
  const [scope, setScope] = useState<'selection' | 'scene'>(ids.length ? 'selection' : 'scene');
  const [time, setTime] = useState(sourceTime);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [name, setName] = useState(object?.name ?? project.sceneName ?? project.name);
  const targetKey = JSON.stringify([
    project.id,
    project.production?.activeSceneId,
    project.production?.activePerformanceId,
    object?.id,
    sourceUrl,
    selectionKey,
  ]);
  const target = useRef(targetKey);
  target.current = targetKey;
  useEffect(() => {
    setPlan(null);
    setExported(null);
    setFailure(null);
    setBusy(null);
    setJob(null);
    setCancelling(false);
    setScope(ids.length ? 'selection' : 'scene');
    setTime(sourceTime);
    setName(object?.name ?? project.sceneName ?? project.name);
  }, [targetKey]); // A different target never receives the previous target's asynchronous result.
  const context = modelAssetGuard(project).expectedContext;
  const stalePlan =
    !!plan &&
    (plan.projectId !== project.id ||
      plan.revision !== project.revision ||
      plan.objectId !== object?.id ||
      plan.asset.url !== object?.assetUrl ||
      plan.context.sceneId !== context.sceneId ||
      plan.context.performanceId !== context.performanceId);
  const editableModel = object?.type === 'model' && !object.modeling;
  const report = (error: unknown) => {
    const next = error instanceof ModelAssetError ? error : new ModelAssetError((error as Error).message);
    if (next.code !== 'MODELING_CANCELLED') setFailure(next);
  };
  const preview = async () => {
    if (!object) return;
    const expectedTarget = targetKey;
    setBusy('conversion');
    setJob(null);
    setFailure(null);
    try {
      const result = await requestModelAsset<ModelConversion>(
        'conversion',
        {
          ...modelAssetGuard(project),
          objectId: object.id,
        },
        (value) => {
          if (target.current === expectedTarget) setJob(value);
        },
      );
      if (target.current === expectedTarget) setPlan(result);
    } catch (error) {
      if (target.current === expectedTarget) report(error);
    } finally {
      if (target.current === expectedTarget) setBusy(null);
    }
  };
  const convert = async () => {
    if (!plan || stalePlan || !object) return;
    try {
      await editor.command((latest) => {
        const current = latest.objects.find((item) => item.id === plan.objectId);
        const latestContext = modelAssetGuard(latest).expectedContext;
        if (
          latest.id !== plan.projectId ||
          latest.revision !== plan.revision ||
          current?.assetUrl !== plan.asset.url ||
          latestContext.sceneId !== plan.context.sceneId ||
          latestContext.performanceId !== plan.context.performanceId
        )
          throw new Error('模型或项目已更新，请重新预览转换结果');
        return [{ type: 'mesh.set', payload: { id: plan.objectId, mesh: plan.mesh } }];
      });
      if (target.current === targetKey) {
        setPlan(null);
        setFailure(null);
      }
    } catch (error) {
      if (target.current === targetKey) report(error);
    }
  };
  const exportGlb = async () => {
    const expectedTarget = targetKey;
    setBusy('export');
    setJob(null);
    setFailure(null);
    try {
      const result = await requestModelAsset<ModelExport>(
        'export',
        {
          ...modelAssetGuard(project),
          scope,
          ...(scope === 'selection' ? { objectIds: ids } : {}),
          sourceTime: time,
          includeHidden,
          ...(name.trim() ? { name: name.trim() } : {}),
        },
        (value) => {
          if (target.current === expectedTarget) setJob(value);
        },
      );
      if (target.current === expectedTarget) setExported(result);
    } catch (error) {
      if (target.current === expectedTarget) report(error);
    } finally {
      if (target.current === expectedTarget) setBusy(null);
    }
  };
  const cancel = async () => {
    if (!job) return;
    const expectedTarget = targetKey;
    setCancelling(true);
    try {
      const value = await cancelModelAsset(job.id);
      if (target.current === expectedTarget) setJob(value);
    } catch (error) {
      if (target.current === expectedTarget) report(error);
    } finally {
      if (target.current === expectedTarget) setCancelling(false);
    }
  };
  const progress = job?.progress.asset;
  const stageLabel = progress
    ? { reading: '读取模型', geometry: '构建几何', encoding: '编码 GLB', storing: '保存文件' }[progress.stage]
    : job?.status === 'queued'
      ? '排队中'
      : '启动模型处理';
  return (
    <div className="model-assets-panel" data-testid="model-assets-panel">
      <div className="model-assets-heading">
        <strong>模型文件</strong>
        <Box size={14} />
      </div>
      {sourceUrl && (
        <a className="model-source-link" href={sourceUrl} download>
          <Download size={13} />
          原始模型
        </a>
      )}
      {editableModel && (
        <div className="model-conversion">
          <button
            className="text-button full-width"
            disabled={!!busy || editor.busy || object.locked}
            onClick={() => void preview()}
          >
            <FileSearch size={14} />
            预览网格转换
          </button>
          {plan && (
            <>
              <div className="model-asset-stats">
                <span>
                  顶点 <b>{plan.mesh.vertices.length.toLocaleString()}</b>
                </span>
                <span>
                  三角面 <b>{plan.mesh.faces.length.toLocaleString()}</b>
                </span>
              </div>
              <details open className="model-asset-review">
                <summary>转换变化 · {plan.diagnostics.length}</summary>
                <Diagnostics items={plan.diagnostics} project={project} />
              </details>
              {stalePlan && <p role="status">项目已更新，转换预览已过期</p>}
              <button
                className="text-button full-width"
                disabled={stalePlan || !!busy || editor.busy || object.locked}
                onClick={() => void convert()}
              >
                <Check size={14} />
                应用网格转换
              </button>
            </>
          )}
        </div>
      )}
      <div className="model-export-fields">
        <TopologySelect
          label="GLB 导出范围"
          value={scope}
          options={
            ids.length
              ? [
                  ['selection', `所选对象 (${ids.length})`],
                  ['scene', '当前场景'],
                ]
              : [['scene', '当前场景']]
          }
          onChange={(value) => setScope(value as typeof scope)}
        />
        <Field label="文件名称">
          <TextInput label="GLB 文件名称" value={name} onChange={setName} />
        </Field>
        <div className="model-export-time">
          <Field label="源时间">
            <ModelingNumberInput
              label="GLB 导出源时间"
              value={time}
              min={0}
              max={100000}
              suffix="s"
              onChange={setTime}
            />
          </Field>
          <IconButton icon={ScanLine} label="使用当前时间导出 GLB" onClick={() => setTime(sourceTime)} />
        </div>
        <TopologyCheck label="GLB 包含隐藏对象" checked={includeHidden} onChange={setIncludeHidden} />
        <button
          className="text-button full-width"
          disabled={!!busy || editor.busy || (scope === 'selection' && !ids.length)}
          onClick={() => void exportGlb()}
        >
          <Download size={14} />
          导出 GLB
        </button>
      </div>
      {busy && (
        <div className="model-asset-pending" role="status">
          <RefreshCw size={14} />
          <span>
            {stageLabel}
            {progress?.stage === 'geometry' ? ` ${progress.completed} / ${progress.total}` : ''}
          </span>
          <IconButton
            icon={X}
            label="取消模型处理"
            disabled={!job || cancelling || !['queued', 'running'].includes(job.status)}
            onClick={() => void cancel()}
          />
          <progress
            aria-label="模型处理进度"
            {...(progress?.stage === 'geometry' ? { max: progress.total, value: progress.completed } : {})}
          />
        </div>
      )}
      {!busy && job?.status === 'cancelled' && <p role="status">模型处理已取消</p>}
      {failure && (
        <div className="model-asset-error" role="alert">
          <p>{failure.diagnostics.length ? '模型处理未完成' : failure.message}</p>
          {failure.diagnostics.length > 0 && <Diagnostics items={failure.diagnostics} project={project} />}
        </div>
      )}
      {exported && (
        <div className="model-export-result" data-testid="model-export-result">
          <a className="text-button full-width" href={exported.url} download={exported.name}>
            <Download size={14} />
            下载 {exported.name}
          </a>
          <div className="model-asset-stats">
            <span>{exported.objectIds.length} 个对象</span>
            <span>{sizeLabel(exported.bytes)}</span>
            <span>{exported.triangles.toLocaleString()} 三角面</span>
            <span>{exported.sourceTime} s</span>
          </div>
          {!!exported.hiddenObjectIds.length && <p>已略过 {exported.hiddenObjectIds.length} 个隐藏对象</p>}
          {!!exported.diagnostics.length && (
            <details className="model-asset-review">
              <summary>导出明细 · {exported.diagnostics.length}</summary>
              <Diagnostics items={exported.diagnostics} project={project} />
            </details>
          )}
        </div>
      )}
    </div>
  );
}
