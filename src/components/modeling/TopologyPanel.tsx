import { useEffect, useState } from 'react';
import { Box, CircleDot, LassoSelect, MousePointer2, Pentagon, RefreshCw, Scan, Spline } from 'lucide-react';
import type { MeshData } from '../../../shared/modeling';
import type { Project, SceneObject } from '../../../shared/types';
import type { ComponentKind, MeshTopology } from '../../../shared/topology/types';
import {
  defaultComponentWorkspace,
  type ComponentWorkspaceCommand,
} from '../../../shared/topology-workspace';
import type { topologySchemas } from '../../../shared/topology-schema';
import type { EditorActions } from '../../useEditor';
import { useTopologyWorkspace } from '../../workspace/TopologyWorkspace';
import { IconButton } from '../Controls';
import { TopologyCheck, TopologySelect } from './TopologyFields';
import { TopologyDiagnostics } from './TopologyDiagnostics';
import { TopologyOperations } from './TopologyOperations';
import { TopologySelection } from './TopologySelection';
import { TopologyTransform } from './TopologyTransform';
import './topology.css';

export function TopologyPanel({
  object,
  mesh,
  project,
  editor,
}: {
  object: SceneObject;
  mesh: MeshData;
  project: Project;
  editor: EditorActions;
}) {
  const workspace = useTopologyWorkspace();
  const state =
    workspace.state?.objectId === object.id
      ? workspace.state
      : { ...defaultComponentWorkspace, objectId: object.id };
  const [prepared, setPrepared] = useState<{ mesh: MeshData; value?: MeshTopology; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const topology = prepared?.mesh === mesh ? prepared : undefined;
  useEffect(() => {
    let current = true;
    void workspace
      .prepare(mesh)
      .then((source) => {
        if (current) setPrepared({ mesh, value: source.topology });
      })
      .catch((error: Error) => {
        if (current) setPrepared({ mesh, error: error.message });
      });
    return () => {
      current = false;
    };
  }, [mesh, workspace.prepare, state.mode, attempt]);
  const update = (command: Omit<ComponentWorkspaceCommand, 'type'>) => {
    void workspace.apply({ type: 'components', objectId: object.id, ...command }).catch((error: Error) => {
      editor.setError((error as Error).message);
    });
  };
  if (!topology?.value)
    return (
      <div role={topology?.error ? 'alert' : 'status'} className="topology-status">
        {topology?.error ?? '正在准备组件'}
        {topology?.error && (
          <IconButton
            icon={RefreshCw}
            label="重新准备组件"
            onClick={() => {
              setPrepared(undefined);
              setAttempt((value) => value + 1);
            }}
          />
        )}
      </div>
    );
  const selection =
    state.selection && state.selection.namespace === topology.value.mesh.identity.namespace
      ? state.selection
      : null;
  const select = (kind: ComponentKind, ids: string[]) =>
    update({
      mode: kind,
      selection: { namespace: topology.value!.mesh.identity.namespace, kind, ids, operation: 'replace' },
    });
  const execute = (
    type: keyof typeof topologySchemas,
    payload: Record<string, unknown>,
    useSelection = true,
  ) => {
    if (useSelection && !selection?.ids.length) {
      editor.setError('未选择可编辑组件');
      return;
    }
    void editor
      .command(type, { id: object.id, ...(useSelection ? { selection } : {}), ...payload })
      .catch(() => undefined);
  };
  return (
    <div className="topology-panel" data-testid="topology-panel">
      <div className="topology-title">
        <strong>组件建模</strong>
        <span>
          {mesh.vertices.length} 顶点 · {mesh.faces.length} 面
        </span>
      </div>
      <div className="topology-modes" role="group" aria-label="组件选择模式">
        {(
          [
            { mode: 'object', label: '物体', icon: Box },
            { mode: 'vertex', label: '顶点', icon: CircleDot },
            { mode: 'edge', label: '边', icon: Spline },
            { mode: 'face', label: '面', icon: Pentagon },
          ] as const
        ).map(({ mode, label, icon: Icon }) => (
          <button
            key={mode}
            type="button"
            aria-label={`${label}选择模式`}
            aria-pressed={state.mode === mode}
            onClick={() => update({ mode })}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>
      <div className="topology-command-row">
        <div role="group" aria-label="组件选择工具">
          {(
            [
              { tool: 'pick', label: '点选组件', icon: MousePointer2 },
              { tool: 'box', label: '框选组件', icon: Scan },
              { tool: 'lasso', label: '套索选择组件', icon: LassoSelect },
            ] as const
          ).map(({ tool, label, icon }) => (
            <IconButton
              key={tool}
              icon={icon}
              label={label}
              active={state.tool === tool}
              onClick={() => update({ tool })}
            />
          ))}
        </div>
        <TopologyCheck label="透视选择" checked={state.xray} onChange={(xray) => update({ xray })} />
      </div>
      <TopologySelect
        label="组件视图显示"
        value={state.display}
        options={[
          ['solid', '实体'],
          ['wireframe', '线框'],
          ['solid-wire', '实体与线框'],
        ]}
        onChange={(display) => update({ display: display as 'solid' | 'wireframe' | 'solid-wire' })}
      />
      <div className="topology-checks">
        <TopologyCheck
          label="显示组件法线"
          checked={state.normals}
          onChange={(normals) => update({ normals })}
        />
        <TopologyCheck
          label="显示边界边"
          checked={state.boundaries}
          onChange={(boundaries) => update({ boundaries })}
        />
      </div>
      {state.invalidatedIds.length > 0 && (
        <div className="topology-status" role="status">
          {state.invalidatedIds.length} 个组件已失效
        </div>
      )}
      {state.mode !== 'object' && (
        <TopologySelection
          key={`${object.id}-${state.mode}`}
          topology={topology.value}
          selection={
            selection ?? { namespace: topology.value.mesh.identity.namespace, kind: state.mode, ids: [] }
          }
          update={(request, combine) => update({ selection: request, combine })}
        />
      )}
      <TopologyTransform
        state={state}
        update={update}
        execute={(payload) => execute('topology.transform', payload)}
        disabled={editor.busy || !selection?.ids.length}
      />
      <TopologyOperations
        kind={selection?.kind ?? null}
        hasSelection={!!selection?.ids.length}
        busy={editor.busy}
        execute={execute}
      />
      <TopologyDiagnostics project={project} objectId={object.id} select={select} error={editor.setError} />
    </div>
  );
}
