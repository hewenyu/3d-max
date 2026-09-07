import { useRef, useState } from 'react';
import {
  Box,
  Camera,
  Circle,
  CircleUserRound,
  Columns3,
  Copy,
  DoorOpen,
  Eye,
  EyeOff,
  Folder,
  Group,
  Layers,
  ListChecks,
  LockKeyhole,
  Search,
  Sofa,
  Square,
  Table2,
  Trash2,
  UnlockKeyhole,
  Upload,
  X,
} from 'lucide-react';
import type { ObjectType, Project, SceneObject } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { uploadAsset } from '../api';
import { IconButton } from './Controls';
import { ProductionPanel } from './ProductionPanel';
import { TemplateLibrary } from './TemplateLibrary';

const objectIcons: Partial<Record<ObjectType, typeof Box>> = {
  actor: CircleUserRound,
  sofa: Sofa,
  table: Table2,
  door: DoorOpen,
  group: Folder,
  sphere: Circle,
  plane: Square,
  wall: Columns3,
};
const assets: { type: ObjectType; label: string; icon: typeof Box }[] = [
  { type: 'actor', label: '人物', icon: CircleUserRound },
  { type: 'box', label: '立方体', icon: Box },
  { type: 'sphere', label: '球体', icon: Circle },
  { type: 'cylinder', label: '圆柱', icon: Columns3 },
  { type: 'wall', label: '墙体', icon: Square },
  { type: 'door', label: '门', icon: DoorOpen },
  { type: 'sofa', label: '沙发', icon: Sofa },
  { type: 'table', label: '茶几', icon: Table2 },
  { type: 'chair', label: '椅子', icon: Sofa },
  { type: 'phone', label: '手机', icon: Square },
  { type: 'plane', label: '地板', icon: Layers },
  { type: 'window', label: '窗', icon: Columns3 },
];

export function ScenePanel({
  project,
  selected,
  onSelect,
  editor,
  onClose,
  onContextChange,
}: {
  project: Project;
  selected: string[];
  onSelect: (ids: string[]) => void;
  editor: EditorActions;
  onClose: () => void;
  onContextChange: () => void;
}) {
  const [tab, setTab] = useState<'scene' | 'assets' | 'production' | 'templates'>('scene');
  const [query, setQuery] = useState('');
  const [multipleSelection, setMultipleSelection] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const select = (id: string, multiple: boolean) =>
    onSelect(
      multiple ? (selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]) : [id],
    );
  const add = async (type: ObjectType, label: string) => {
    try {
      const result = await editor.command('object.create', { type, name: label });
      const created = result?.results[0] as SceneObject | undefined;
      if (created?.id) onSelect([created.id]);
      setTab('scene');
    } catch {
      /* Errors are displayed by the editor. */
    }
  };
  const importModel = async (file?: File) => {
    if (!file) return;
    const projectId = project.id;
    const expectedContext = {
      sceneId: project.production?.activeSceneId ?? null,
      performanceId: project.production?.activePerformanceId ?? null,
    };
    try {
      const asset = await uploadAsset(file);
      const objectId = crypto.randomUUID();
      await editor.command(
        'object.create',
        {
          id: objectId,
          type: 'model',
          name: file.name.replace(/\.(glb|gltf)$/i, ''),
          assetUrl: asset.url,
        },
        { projectId, expectedContext, staleMessage: '项目已切换，未导入上一项目的模型' },
      );
      onSelect([objectId]);
    } catch (e) {
      editor.setError((e as Error).message);
    }
  };
  const depth = (object: SceneObject) => {
    let count = 0;
    let parent = object.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      count++;
      parent = project.objects.find((x) => x.id === parent)?.parentId ?? null;
    }
    return Math.min(count, 5);
  };
  return (
    <aside className="scene-panel">
      <div className="panel-heading">
        <Layers size={15} />
        <strong>场景资源</strong>
        <span className="count">{project.objects.length}</span>
        <IconButton icon={X} label="收起资源面板" className="mobile-only" onClick={onClose} />
      </div>
      <div className="panel-tabs">
        <button className={tab === 'scene' ? 'selected' : ''} onClick={() => setTab('scene')}>
          层级
        </button>
        <button className={tab === 'assets' ? 'selected' : ''} onClick={() => setTab('assets')}>
          资产
        </button>
        <button className={tab === 'production' ? 'selected' : ''} onClick={() => setTab('production')}>
          场次
        </button>
        <button className={tab === 'templates' ? 'selected' : ''} onClick={() => setTab('templates')}>
          模板
        </button>
      </div>
      {tab === 'templates' ? (
        <TemplateLibrary
          project={project}
          selected={selected}
          editor={editor}
          onInserted={(ids, scene) => {
            if (scene) onContextChange();
            onSelect(ids);
            setTab('scene');
          }}
        />
      ) : tab === 'production' ? (
        <ProductionPanel project={project} editor={editor} onContextChange={onContextChange} />
      ) : tab === 'scene' ? (
        <>
          <div className="search-field">
            <Search size={14} />
            <input
              placeholder="搜索对象"
              aria-label="搜索对象"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="tree-heading">
            <Folder size={13} />
            <span>{project.sceneName}</span>
          </div>
          <div className="scene-tree">
            {project.objects
              .filter((o) => o.name.toLowerCase().includes(query.toLowerCase()))
              .map((object) => {
                const Icon = objectIcons[object.type] ?? Box;
                return (
                  <div
                    key={object.id}
                    className={`tree-row ${selected.includes(object.id) ? 'selected' : ''} ${object.visible ? '' : 'muted'}`}
                    style={{ paddingLeft: 14 + depth(object) * 12 }}
                  >
                    <button
                      className="tree-select"
                      onClick={(e) =>
                        select(object.id, multipleSelection || e.shiftKey || e.metaKey || e.ctrlKey)
                      }
                    >
                      <Icon size={14} />
                      <span>{object.name}</span>
                    </button>
                    <IconButton
                      icon={object.visible ? Eye : EyeOff}
                      label={`${object.visible ? '隐藏' : '显示'} ${object.name}`}
                      onClick={() =>
                        editor.run('object.update', { id: object.id, patch: { visible: !object.visible } })
                      }
                    />
                    <IconButton
                      icon={object.locked ? LockKeyhole : UnlockKeyhole}
                      label={`${object.locked ? '解锁' : '锁定'} ${object.name}`}
                      onClick={() =>
                        editor.run('object.update', { id: object.id, patch: { locked: !object.locked } })
                      }
                    />
                  </div>
                );
              })}
            <div className="tree-heading">
              <Camera size={13} />
              <span>摄影机</span>
              <span className="count">{project.cameras.length}</span>
            </div>
            {project.cameras.map((camera) => (
              <button
                key={camera.id}
                className={`camera-tree-row ${selected.includes(camera.id) ? 'selected' : ''}`}
                onClick={() => onSelect([camera.id])}
              >
                <Camera size={14} />
                <span>{camera.name}</span>
                {camera.locked && <LockKeyhole size={12} />}
              </button>
            ))}
          </div>
          <div className="panel-bottom-tools">
            <IconButton
              icon={ListChecks}
              label="多选对象"
              active={multipleSelection}
              onClick={() => setMultipleSelection(!multipleSelection)}
            />
            <IconButton
              icon={Copy}
              label="复制选中对象"
              disabled={!selected.some((id) => project.objects.some((o) => o.id === id))}
              onClick={() =>
                editor.run(
                  selected
                    .filter((id) => project.objects.some((o) => o.id === id))
                    .map((id) => ({ type: 'object.duplicate', payload: { id } })),
                )
              }
            />
            <IconButton
              icon={Group}
              label="编组"
              disabled={selected.length < 2}
              onClick={async () => {
                try {
                  const response = await editor.command('object.group', { ids: selected, name: '新编组' });
                  const created = response?.results[0] as SceneObject | undefined;
                  if (created) {
                    onSelect([created.id]);
                    setMultipleSelection(false);
                  }
                } catch {
                  /* Editor reports validated command failures. */
                }
              }}
            />
            <span className="flex-spacer" />
            <IconButton
              icon={Trash2}
              label="删除选中对象"
              disabled={!selected.length}
              onClick={() => {
                editor.run(
                  selected.map((id) => ({
                    type: project.objects.some((o) => o.id === id) ? 'object.delete' : 'camera.delete',
                    payload: { id },
                  })),
                );
                onSelect([]);
              }}
            />
          </div>
        </>
      ) : (
        <>
          <div className="asset-grid">
            {assets.map((asset) => (
              <button
                className="asset-item"
                key={asset.type}
                onClick={() => void add(asset.type, asset.label)}
              >
                <asset.icon size={28} strokeWidth={1.3} />
                <span>{asset.label}</span>
              </button>
            ))}
          </div>
          <div className="panel-section import-section">
            <button className="text-button" onClick={() => upload.current?.click()}>
              <Upload size={15} />
              导入模型
            </button>
            <input
              ref={upload}
              type="file"
              accept=".glb,.gltf"
              hidden
              onChange={(e) => {
                void importModel(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
        </>
      )}
    </aside>
  );
}
