import { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  CircleMinus,
  CirclePlus,
  FlipHorizontal2,
  Link,
  ListFilter,
  ScanLine,
  X,
} from 'lucide-react';
import type { ComponentSelection, MeshTopology } from '../../../shared/topology/types';
import type { ComponentWorkspaceCommand } from '../../../shared/topology-workspace';
import { IconButton } from '../Controls';

type SelectRequest = NonNullable<ComponentWorkspaceCommand['selection']>;
export function TopologySelection({
  topology,
  selection,
  update,
}: {
  topology: MeshTopology;
  selection: ComponentSelection;
  update(selection: SelectRequest, combine?: ComponentWorkspaceCommand['combine']): void;
}) {
  const [page, setPage] = useState(0);
  const [onlySelected, setOnlySelected] = useState(false);
  const ids =
    selection.kind === 'vertex'
      ? topology.mesh.identity.vertexIds
      : selection.kind === 'face'
        ? topology.mesh.identity.faceIds
        : topology.edges.map((edge) => edge.id);
  const selected = new Set(selection.ids);
  const all = ids
    .map((id, index) => ({ id, index }))
    .filter((item) => !onlySelected || selected.has(item.id));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(all.length / 30) - 1));
  const shown = all.slice(currentPage * 30, currentPage * 30 + 30);
  const select = (operation: SelectRequest['operation'], selectedIds = selection.ids) =>
    update({ ...selection, ids: selectedIds, operation });
  const kindLabel = { vertex: '顶点', edge: '边', face: '面' }[selection.kind];
  return (
    <>
      <div className="topology-command-row">
        <output aria-label="已选组件数量">
          {selection.ids.length} / {ids.length} {kindLabel}
        </output>
        <IconButton icon={CheckCheck} label="选择全部组件" onClick={() => select('replace', ids)} />
        <IconButton icon={X} label="清空组件选择" onClick={() => select('replace', [])} />
        <IconButton icon={FlipHorizontal2} label="反选组件" onClick={() => select('invert')} />
      </div>
      <div className="topology-selection-tools">
        <IconButton
          icon={Link}
          label="选择相连组件"
          disabled={!selection.ids.length}
          onClick={() => select('connected')}
        />
        <IconButton
          icon={ScanLine}
          label="选择边循环"
          disabled={selection.kind !== 'edge' || !selection.ids.length}
          onClick={() => select('loop')}
        />
        <IconButton
          icon={ListFilter}
          label="选择边环"
          disabled={selection.kind !== 'edge' || !selection.ids.length}
          onClick={() => select('ring')}
        />
        <IconButton
          icon={CirclePlus}
          label="扩展组件选择"
          disabled={!selection.ids.length}
          onClick={() => select('grow')}
        />
        <IconButton
          icon={CircleMinus}
          label="收缩组件选择"
          disabled={!selection.ids.length}
          onClick={() => select('shrink')}
        />
      </div>
      <details className="topology-details">
        <summary>组件列表</summary>
        <label className="topology-check">
          <input
            type="checkbox"
            checked={onlySelected}
            onChange={(event) => {
              setOnlySelected(event.target.checked);
              setPage(0);
            }}
          />
          仅显示已选组件
        </label>
        <div className="topology-component-list">
          {shown.map(({ id, index }) => (
            <label key={id} title={id}>
              <input
                type="checkbox"
                aria-label={`选择${kindLabel} ${index + 1}`}
                checked={selected.has(id)}
                onChange={(event) =>
                  update(
                    { ...selection, ids: [id], operation: 'replace' },
                    event.target.checked ? 'add' : 'remove',
                  )
                }
              />
              <span>
                {kindLabel} {index + 1}
              </span>
              <code>{id}</code>
            </label>
          ))}
        </div>
        <div className="topology-command-row">
          <IconButton
            icon={ArrowLeft}
            label="上一页组件"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          />
          <output>
            {all.length ? currentPage + 1 : 0} / {Math.ceil(all.length / 30)}
          </output>
          <IconButton
            icon={ArrowRight}
            label="下一页组件"
            disabled={(currentPage + 1) * 30 >= all.length}
            onClick={() => setPage(currentPage + 1)}
          />
        </div>
      </details>
    </>
  );
}
