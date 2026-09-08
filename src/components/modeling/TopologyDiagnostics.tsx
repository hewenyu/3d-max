import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Project } from '../../../shared/types';
import type { ComponentKind } from '../../../shared/topology/types';
import type { MeshDiagnostics } from '../../../shared/topology/diagnostics';
import { api } from '../../api';
import { Field, IconButton } from '../Controls';
import { ModelingNumberInput } from './ModelingNumberInput';

type Report = { diagnostics: MeshDiagnostics; revision: number; projectId: string; objectId: string };
export function TopologyDiagnostics({
  project,
  objectId,
  select,
  error,
}: {
  project: Project;
  objectId: string;
  select(kind: ComponentKind, ids: string[]): void;
  error(message: string): void;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [tolerance, setTolerance] = useState(0.000001);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
  }, [project.id, project.revision, objectId]);
  const stale =
    report &&
    (report.revision !== project.revision || report.projectId !== project.id || report.objectId !== objectId);
  const inspect = async () => {
    const expected = generation.current;
    setBusy(true);
    try {
      const next = await api<Report>('/modeling/inspect', {
        method: 'POST',
        body: JSON.stringify({
          projectId: project.id,
          expectedRevision: project.revision,
          expectedContext: {
            sceneId: project.production?.activeSceneId ?? null,
            performanceId: project.production?.activePerformanceId ?? null,
          },
          objectId,
          stage: 'source',
          kind: 'face',
          offset: 0,
          limit: 1,
          tolerance,
        }),
      });
      if (generation.current === expected) setReport(next);
    } catch (caught) {
      if (generation.current === expected) error((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const diagnostic = report?.diagnostics;
  const rows: { label: string; kind: ComponentKind; ids: string[]; count?: number }[] = diagnostic
    ? [
        { label: '边界边', kind: 'edge', ids: diagnostic.boundaryEdges },
        { label: '非流形边', kind: 'edge', ids: diagnostic.nonManifoldEdges },
        { label: '非流形顶点', kind: 'vertex', ids: diagnostic.nonManifoldVertices },
        { label: '法线不一致边', kind: 'edge', ids: diagnostic.inconsistentEdges },
        { label: '孤立顶点', kind: 'vertex', ids: diagnostic.looseVertices },
        { label: '退化面', kind: 'face', ids: diagnostic.degenerateFaces },
        { label: '非平面面片', kind: 'face', ids: diagnostic.nonPlanarFaces },
        { label: '自交面', kind: 'face', ids: diagnostic.selfIntersectingFaces },
        {
          label: '重复顶点组',
          kind: 'vertex',
          ids: diagnostic.duplicateVertices.flat(),
          count: diagnostic.duplicateVertices.length,
        },
        {
          label: '重复面组',
          kind: 'face',
          ids: diagnostic.duplicateFaces.flat(),
          count: diagnostic.duplicateFaces.length,
        },
      ]
    : [];
  return (
    <details className="topology-details">
      <summary>网格诊断</summary>
      <div className="topology-command-row">
        <Field label="检测容差">
          <ModelingNumberInput
            label="网格诊断容差"
            value={tolerance}
            min={0.0000001}
            suffix="m"
            onChange={setTolerance}
          />
        </Field>
        <IconButton icon={RefreshCw} label="运行网格诊断" disabled={busy} onClick={() => void inspect()} />
      </div>
      {diagnostic && (
        <>
          <div className="topology-status" role="status">
            {stale
              ? '网格已更新，诊断待刷新'
              : `${diagnostic.closed ? '封闭' : '开放'} · ${diagnostic.consistentlyOriented ? '法线一致' : '法线异常'} · ${diagnostic.counts.connectedComponents} 个连通体`}
          </div>
          <div className="topology-diagnostics">
            {rows.map((row) => (
              <button
                key={row.label}
                type="button"
                disabled={!!stale || !row.ids.length}
                aria-label={`选择${row.label}`}
                onClick={() => select(row.kind, [...new Set(row.ids)])}
              >
                <span>{row.label}</span>
                <output>{row.count ?? row.ids.length}</output>
              </button>
            ))}
          </div>
        </>
      )}
    </details>
  );
}
