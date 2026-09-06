import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Camera,
  Check,
  ChevronDown,
  Columns2,
  Download,
  FilePlus2,
  FolderOpen,
  Focus,
  Grid2X2,
  Layers,
  LoaderCircle,
  Magnet,
  Maximize,
  Move,
  PanelLeftClose,
  PanelRightClose,
  Plug,
  Redo2,
  Rotate3D,
  Save,
  Scan,
  Scaling,
  Undo2,
  X,
} from 'lucide-react';
import type { Project, SequenceClip } from '../shared/types';
import { sampleTimeline } from '../shared/timeline';
import { useEditor } from './useEditor';
import { usePlayback } from './usePlayback';
import { Stage, type ViewMode } from './components/Stage';
import { ScenePanel } from './components/ScenePanel';
import { Inspector, type InspectorTab } from './components/Inspector';
import { Timeline } from './components/Timeline';
import { IconButton, timecode } from './components/Controls';
import { ConnectionDialog, CutReviewDialog, ExportDialog, NewProjectDialog } from './components/Dialogs';
import { ProjectsDialog } from './components/ProjectsDialog';
import type { SceneEngine } from './engine/SceneEngine';

export default function App() {
  const editor = useEditor();
  const { project } = editor;
  const playback = usePlayback(project);
  const engine = useRef<SceneEngine | null>(null);
  const importFile = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<ViewMode>('edit');
  const [tool, setTool] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [snap, setSnap] = useState(false);
  const [helpers, setHelpers] = useState(true);
  const [safeFrame, setSafeFrame] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('shot');
  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(true);
  const [mobilePanel, setMobilePanel] = useState<'left' | 'right' | null>(null);
  const [dialog, setDialog] = useState<'export' | 'mcp' | 'new' | 'projects' | 'cuts' | null>(null);
  const [projectMenu, setProjectMenu] = useState(false);
  const [saved, setSaved] = useState(false);
  const sample = project ? sampleTimeline(project, playback.time) : null;
  const shot = sample?.shot ?? null;
  const activeJob = editor.jobs.find((j) => ['queued', 'rendering', 'encoding'].includes(j.status));
  const chooseObject = (ids: string[]) => {
    setSelected(ids);
    if (ids.length) {
      setInspectorTab('object');
      setRightVisible(true);
    }
  };
  const chooseClip = (clip: SequenceClip, start: number) => {
    playback.setPlaying(false);
    playback.seek(start);
    setMode('camera');
    setInspectorTab('shot');
    const selectedShot = project?.shots.find((s) => s.id === clip.shotId);
    if (selectedShot) setSelected([selectedShot.cameraId]);
  };
  const seekSource = (source: number) => {
    playback.setPlaying(false);
    if (!project) return;
    if (sample?.clip && source >= sample.clip.sourceIn && source < sample.clip.sourceOut) {
      playback.seek(sample.clipStart + source - sample.clip.sourceIn);
      return;
    }
    let offset = 0;
    const sequence = project.sequences.find((s) => s.id === project.activeSequenceId);
    for (const clip of sequence?.clips ?? []) {
      if (source >= clip.sourceIn && source <= clip.sourceOut) {
        playback.seek(offset + source - clip.sourceIn);
        return;
      }
      offset += clip.sourceOut - clip.sourceIn;
    }
    playback.seek(source);
  };
  const saveProject = () => {
    const link = document.createElement('a');
    link.href = '/api/project/download';
    link.download = `${project?.name ?? 'project'}.whiteframe.json`;
    link.click();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const loadProject = async (file?: File) => {
    if (!file) return;
    try {
      const data: Project = JSON.parse(await file.text());
      playback.setPlaying(false);
      if (await editor.replace('/project/import', data)) {
        playback.seek(0);
        setSelected([]);
        setDialog(null);
      }
    } catch (e) {
      editor.setError((e as Error).message);
    }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable)
      )
        return;
      if (dialog) return;
      if (event.code === 'Space') {
        event.preventDefault();
        playback.toggle();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        editor.undo(event.shiftKey);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveProject();
      }
      if (event.key.toLowerCase() === 'f') engine.current?.focus(selected[0]);
      if (event.key === 'Escape') {
        setSelected([]);
        setMobilePanel(null);
      }
      if (event.key.toLowerCase() === 'w') setTool('translate');
      if (event.key.toLowerCase() === 'e') setTool('rotate');
      if (event.key.toLowerCase() === 'r') setTool('scale');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  useEffect(() => {
    if (!editor.error) return;
    const timer = setTimeout(() => editor.setError(''), 10000);
    return () => clearTimeout(timer);
  }, [editor.error]);

  if (!project)
    return (
      <main className="startup">
        <div className="brand-mark">
          <Box size={32} />
        </div>
        <h1>白场</h1>
        <p>WHITEFRAME</p>
        {editor.error ? (
          <>
            <div className="inline-error">{editor.error}</div>
            <button className="text-button" onClick={() => location.reload()}>
              重新连接
            </button>
          </>
        ) : (
          <LoaderCircle size={20} className="spin" />
        )}
      </main>
    );

  return (
    <main
      className={`app ${leftVisible ? '' : 'left-hidden'} ${rightVisible ? '' : 'right-hidden'} ${mobilePanel ? `mobile-${mobilePanel}` : ''}`}
    >
      <header className="app-header">
        <div className="brand">
          <Box size={24} strokeWidth={1.5} />
          <strong>白场</strong>
          <span>WHITEFRAME</span>
        </div>
        <div className="header-divider" />
        <div className="project-menu-wrap">
          <button className="project-name" onClick={() => setProjectMenu(!projectMenu)}>
            <span>{project.name}</span>
            <ChevronDown size={13} />
          </button>
          {projectMenu && (
            <div className="project-menu">
              <button
                onClick={() => {
                  setDialog('new');
                  setProjectMenu(false);
                }}
              >
                <FilePlus2 size={15} />
                新建项目
              </button>
              <button
                onClick={() => {
                  setDialog('projects');
                  setProjectMenu(false);
                }}
              >
                <FolderOpen size={15} />
                打开项目
              </button>
              <button
                onClick={() => {
                  saveProject();
                  setProjectMenu(false);
                }}
              >
                <Download size={15} />
                下载项目
              </button>
            </div>
          )}
        </div>
        <span className="save-state">
          {editor.busy ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}
          {editor.busy ? '保存中' : '已保存'}
        </span>
        <span className="flex-spacer" />
        <button
          className={`connection-button ${editor.connected ? 'connected' : ''}`}
          onClick={() => setDialog('mcp')}
        >
          <span className="status-dot" />
          <Plug size={14} />
          <span>MCP</span>
        </button>
        <IconButton icon={saved ? Check : Save} label="下载项目文件" onClick={saveProject} />
        <button className="primary-button export-button" onClick={() => setDialog('export')}>
          <Download size={14} />
          <span>导出视频</span>
          {activeJob && (
            <span className="export-progress">
              {Math.round(activeJob.progress > 1 ? activeJob.progress : activeJob.progress * 100)}%
            </span>
          )}
        </button>
      </header>
      <div className="workspace-toolbar">
        <div className="tools-group">
          <IconButton
            icon={Undo2}
            label="撤销"
            disabled={!editor.history.canUndo}
            onClick={() => editor.undo()}
          />
          <IconButton
            icon={Redo2}
            label="重做"
            disabled={!editor.history.canRedo}
            onClick={() => editor.undo(true)}
          />
          <span className="tool-divider" />
          <IconButton
            icon={Move}
            label="移动"
            active={tool === 'translate'}
            onClick={() => setTool('translate')}
          />
          <IconButton
            icon={Rotate3D}
            label="旋转"
            active={tool === 'rotate'}
            onClick={() => setTool('rotate')}
          />
          <IconButton
            icon={Scaling}
            label="缩放"
            active={tool === 'scale'}
            onClick={() => setTool('scale')}
          />
          <span className="tool-divider" />
          <IconButton icon={Magnet} label="网格吸附" active={snap} onClick={() => setSnap(!snap)} />
          <IconButton icon={Focus} label="聚焦选中对象" onClick={() => engine.current?.focus(selected[0])} />
        </div>
        <div className="view-modes segmented">
          {(
            [
              { key: 'edit', label: '自由视角', icon: Box },
              { key: 'camera', label: '摄影机', icon: Camera },
              { key: 'top', label: '俯视调度', icon: Layers },
            ] as const
          ).map((view) => (
            <button
              key={view.key}
              className={mode === view.key ? 'active' : ''}
              onClick={() => setMode(view.key)}
            >
              <view.icon size={14} />
              <span>{view.label}</span>
            </button>
          ))}
        </div>
        <div className="tools-group right-tools">
          <IconButton
            icon={Columns2}
            label="切点连续性"
            disabled={
              (project.sequences.find((s) => s.id === project.activeSequenceId)?.clips.length ?? 0) < 2
            }
            onClick={() => setDialog('cuts')}
          />
          <IconButton
            icon={Grid2X2}
            label="网格与辅助线"
            active={helpers}
            onClick={() => setHelpers(!helpers)}
          />
          <IconButton
            icon={Scan}
            label="构图安全区"
            active={safeFrame}
            onClick={() => setSafeFrame(!safeFrame)}
          />
          <span className="tool-divider" />
          <IconButton
            icon={PanelLeftClose}
            label="场景资源面板"
            active={leftVisible}
            onClick={() => {
              setLeftVisible(!leftVisible);
              setMobilePanel(mobilePanel === 'left' ? null : 'left');
            }}
          />
          <IconButton
            icon={PanelRightClose}
            label="属性面板"
            active={rightVisible}
            onClick={() => {
              setRightVisible(!rightVisible);
              setMobilePanel(mobilePanel === 'right' ? null : 'right');
            }}
          />
        </div>
      </div>
      <div className="workspace">
        <ScenePanel
          project={project}
          selected={selected}
          onSelect={chooseObject}
          editor={editor}
          onClose={() => setMobilePanel(null)}
        />
        <section className="viewport">
          <Stage
            project={project}
            time={playback.time}
            mode={mode}
            selected={selected}
            tool={tool}
            snap={snap}
            helpers={helpers}
            safeFrame={safeFrame}
            onSelect={chooseObject}
            editor={editor}
            engineRef={engine}
          />
          <div className="viewport-title">
            <span className="viewport-mode">
              {mode === 'camera' ? 'CAM' : mode === 'top' ? 'TOP' : 'PERSPECTIVE'}
            </span>
            <span>{mode === 'camera' ? (shot?.name ?? '摄影机') : project.sceneName}</span>
          </div>
          <div className="viewport-format">
            <select
              aria-label="画幅比例"
              value={project.settings.aspect}
              onChange={(e) => editor.run('project.settings', { aspect: e.target.value })}
            >
              <option>16:9</option>
              <option>9:16</option>
              <option>1:1</option>
            </select>
            <span>{project.settings.fps} FPS</span>
          </div>
          <div className="viewport-bottom">
            <span>
              <span className={`status-dot ${playback.playing ? 'recording' : ''}`} />
              {playback.playing ? 'PLAY' : 'PREVIEW'}
            </span>
            <span className="mono">{timecode(sample?.sourceTime ?? 0, project.settings.fps)}</span>
            <span className="flex-spacer" />
            <IconButton
              icon={Maximize}
              label="全屏视口"
              onClick={() => {
                const viewport = document.querySelector('.viewport');
                if (document.fullscreenElement) void document.exitFullscreen();
                else void viewport?.requestFullscreen();
              }}
            />
          </div>
        </section>
        <Inspector
          project={project}
          selected={selected}
          shot={shot}
          sourceTime={sample?.sourceTime ?? 0}
          time={playback.time}
          editor={editor}
          tab={inspectorTab}
          setTab={setInspectorTab}
          onSeek={seekSource}
          getView={() => engine.current?.getEditorCamera()}
          getTarget={(id) => engine.current?.getObjectTarget(id)}
          onClose={() => setMobilePanel(null)}
        />
      </div>
      <Timeline
        project={project}
        editor={editor}
        playback={playback}
        activeClipId={sample?.clip?.id ?? null}
        onClipSelect={chooseClip}
        getView={() => engine.current?.getEditorCamera()}
      />
      <footer className="statusbar">
        <span className={`status-dot ${editor.connected ? 'success-dot' : ''}`} />
        <span>{editor.connected ? '本地已连接' : '正在重连'}</span>
        <span className="status-separator" />
        <span>{project.objects.length} 对象</span>
        <span>{project.cameras.length} 摄影机</span>
        <span className="flex-spacer" />
        <span>
          {project.settings.aspect} · {project.settings.resolution}p
        </span>
        <span className="status-separator" />
        <span className="mono">r{project.revision}</span>
      </footer>
      <input
        type="file"
        ref={importFile}
        accept=".json"
        hidden
        onChange={(e) => {
          void loadProject(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {editor.error && (
        <div className="toast error-toast" role="alert">
          <span>{editor.error}</span>
          <IconButton icon={X} label="关闭错误" onClick={() => editor.setError('')} />
        </div>
      )}
      {dialog === 'export' && (
        <ExportDialog project={project} shot={shot} editor={editor} onClose={() => setDialog(null)} />
      )}
      {dialog === 'mcp' && <ConnectionDialog onClose={() => setDialog(null)} />}
      {dialog === 'new' && <NewProjectDialog editor={editor} onClose={() => setDialog(null)} />}
      {dialog === 'projects' && (
        <ProjectsDialog
          editor={editor}
          onClose={() => setDialog(null)}
          onImport={() => importFile.current?.click()}
        />
      )}
      {dialog === 'cuts' && (
        <CutReviewDialog project={project} time={playback.time} onClose={() => setDialog(null)} />
      )}
    </main>
  );
}
