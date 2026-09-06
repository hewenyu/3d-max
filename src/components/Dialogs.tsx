import { useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  Film,
  LoaderCircle,
  Plug,
  RotateCcw,
  Square,
} from 'lucide-react';
import type { Project, RenderJob, RenderOptions, Shot } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { api, startRender } from '../api';
import { Field, IconButton, Modal, TextInput } from './Controls';
import { sampleTimeline, sequenceDuration } from '../../shared/timeline';

const jobLabels: Record<RenderJob['status'], string> = {
  queued: '等待中',
  rendering: '逐帧渲染',
  encoding: '编码中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function ExportDialog({
  project,
  shot,
  editor,
  onClose,
}: {
  project: Project;
  shot: Shot | null;
  editor: EditorActions;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<RenderOptions>({
    aspect: project.settings.aspect,
    fps: project.settings.fps,
    resolution: project.settings.resolution,
    includeAudio: false,
    burnIn: false,
  });
  const [scope, setScope] = useState('sequence');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const duration = scope === 'shot' && shot ? shot.sourceOut - shot.sourceIn : sequenceDuration(project);
  const start = async () => {
    setStarting(true);
    setError('');
    try {
      const job = await startRender({
        ...options,
        projectId: project.id,
        expectedRevision: project.revision,
        ...(scope === 'shot' && shot ? { shotId: shot.id } : { sequenceId: project.activeSequenceId }),
      });
      editor.setJobs((previous) => [job, ...previous.filter((j) => j.id !== job.id)]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const cancel = async (job: RenderJob) => {
    try {
      const next = await api<RenderJob>(`/renders/${job.id}/cancel`, { method: 'POST' });
      editor.setJobs((previous) => previous.map((j) => (j.id === job.id ? next : j)));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="导出白模视频" onClose={onClose}>
      <div className="modal-content">
        <div className="export-summary">
          <Film size={25} />
          <div>
            <strong>{project.name}</strong>
            <span>MP4 · H.264 · {duration.toFixed(2)} s</span>
          </div>
          <span className="format-badge">白模</span>
        </div>
        <Field label="导出范围">
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="sequence">完整镜头序列</option>
            <option value="shot" disabled={!shot}>
              当前镜头
            </option>
          </select>
        </Field>
        <div className="two-fields">
          <Field label="画幅">
            <select
              aria-label="导出画幅"
              value={options.aspect}
              onChange={(e) => setOptions({ ...options, aspect: e.target.value as RenderOptions['aspect'] })}
            >
              <option value="16:9">16:9 横屏</option>
              <option value="9:16">9:16 竖屏</option>
              <option value="1:1">1:1 方形</option>
            </select>
          </Field>
          <Field label="分辨率">
            <select
              value={options.resolution}
              onChange={(e) => setOptions({ ...options, resolution: Number(e.target.value) as 720 | 1080 })}
            >
              <option value={720}>720p</option>
              <option value={1080}>1080p</option>
            </select>
          </Field>
        </div>
        <Field label="帧率">
          <select
            value={options.fps}
            onChange={(e) => setOptions({ ...options, fps: Number(e.target.value) })}
          >
            <option value={24}>24 fps</option>
            <option value={25}>25 fps</option>
            <option value={30}>30 fps</option>
          </select>
        </Field>
        <Field label="临时对白">
          <input
            type="checkbox"
            checked={options.includeAudio}
            disabled={!project.audio.length}
            onChange={(e) => setOptions({ ...options, includeAudio: e.target.checked })}
          />
        </Field>
        <Field label="审片时间码">
          <input
            type="checkbox"
            checked={options.burnIn}
            onChange={(e) => setOptions({ ...options, burnIn: e.target.checked })}
          />
        </Field>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <button
          className="primary-button full-width"
          onClick={() => void start()}
          disabled={starting || !duration}
        >
          {starting ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}开始导出
          <span>{Math.ceil(duration * (options.fps ?? 24) - 1e-8)} 帧</span>
        </button>
        {editor.jobs.length > 0 && (
          <div className="render-jobs">
            <h3>导出记录</h3>
            {editor.jobs.slice(0, 8).map((job) => (
              <article className="render-job" key={job.id}>
                <div className="row">
                  {job.status === 'completed' ? (
                    <CheckCircle2 size={15} className="success" />
                  ) : ['queued', 'rendering', 'encoding'].includes(job.status) ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Film size={15} />
                  )}
                  <strong>{jobLabels[job.status]}</strong>
                  <span className="muted small">r{job.projectRevision}</span>
                  <span className="flex-spacer" />
                  {job.url && (
                    <a className="icon-button" href={job.url} download aria-label="下载 MP4" title="下载 MP4">
                      <Download size={16} />
                    </a>
                  )}
                  {['queued', 'rendering', 'encoding'].includes(job.status) && (
                    <IconButton icon={Square} label="取消导出" onClick={() => void cancel(job)} />
                  )}
                  {job.status === 'failed' && (
                    <IconButton
                      icon={RotateCcw}
                      label="用当前项目版本重试导出"
                      disabled={!!job.options.projectId && job.options.projectId !== project.id}
                      onClick={() => {
                        setOptions(job.options);
                        void startRender({
                          ...job.options,
                          projectId: project.id,
                          expectedRevision: project.revision,
                        })
                          .then((next) => editor.setJobs((previous) => [next, ...previous]))
                          .catch((e) => setError(e.message));
                      }}
                    />
                  )}
                </div>
                <progress
                  max={1}
                  value={
                    job.status === 'completed' ? 1 : job.progress > 1 ? job.progress / 100 : job.progress
                  }
                />
                <div className="row small muted">
                  <span>
                    {job.frame} / {job.totalFrames} 帧
                  </span>
                  <span className="flex-spacer" />
                  <span>{new Date(job.createdAt).toLocaleTimeString('zh-CN')}</span>
                </div>
                {job.error && <p className="inline-error">{job.error}</p>}
              </article>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

interface Connection {
  url: string;
  token: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  connected: boolean;
  lastSeenAt: string | null;
}
export function ConnectionDialog({ onClose }: { onClose: () => void }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<'http' | 'stdio'>('http');
  useEffect(() => {
    void api<Connection>('/connection')
      .then(setConnection)
      .catch((e) => setError(e.message));
  }, []);
  const config = connection
    ? JSON.stringify(
        {
          mcpServers: {
            whiteframe:
              mode === 'http'
                ? { url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } }
                : {
                    command: connection.command,
                    args: connection.args,
                    cwd: connection.cwd,
                    env: connection.env,
                  },
          },
        },
        null,
        2,
      )
    : '';
  return (
    <Modal title="MCP 连接" onClose={onClose}>
      <div className="modal-content">
        {error && <div className="inline-error">{error}</div>}
        {connection ? (
          <>
            <div className="connection-heading">
              <Plug size={24} />
              <div>
                <strong>白场 Whiteframe</strong>
                <span className={connection.connected ? 'success' : 'muted'}>
                  {connection.connected ? '客户端已连接' : '服务就绪'}
                </span>
              </div>
            </div>
            <div className="segmented">
              <button className={mode === 'http' ? 'active' : ''} onClick={() => setMode('http')}>
                HTTP
              </button>
              <button className={mode === 'stdio' ? 'active' : ''} onClick={() => setMode('stdio')}>
                stdio
              </button>
            </div>
            <Field label="服务地址">
              <input value={connection.url} readOnly />
            </Field>
            <div className="code-config">
              <pre>{config}</pre>
              <IconButton
                icon={copied ? Check : Copy}
                label="复制 MCP 配置"
                onClick={() => {
                  void navigator.clipboard.writeText(config).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  });
                }}
              />
            </div>
          </>
        ) : (
          !error && <LoaderCircle className="spin" />
        )}
      </div>
    </Modal>
  );
}

export function NewProjectDialog({ editor, onClose }: { editor: EditorActions; onClose: () => void }) {
  const [name, setName] = useState('未命名项目');
  const [template, setTemplate] = useState('empty');
  return (
    <Modal title="新建项目" onClose={onClose}>
      <div className="modal-content">
        <Field label="项目名称">
          <TextInput value={name} onChange={setName} />
        </Field>
        <Field label="场景模板">
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="empty">空白场景</option>
            <option value="demo">客厅 · 双人对白</option>
          </select>
        </Field>
        <button
          className="primary-button full-width"
          onClick={() => {
            void editor.replace('/project/new', { name, template }).then((success) => {
              if (success) onClose();
            });
          }}
        >
          <PlusIcon />
          创建项目
        </button>
      </div>
    </Modal>
  );
}

function PlusIcon() {
  return <Film size={15} />;
}

export function CutReviewDialog({
  project,
  time,
  onClose,
}: {
  project: Project;
  time: number;
  onClose: () => void;
}) {
  const [frames, setFrames] = useState<string[]>([]);
  const [error, setError] = useState('');
  const sequence = project.sequences.find((s) => s.id === project.activeSequenceId);
  let running = 0;
  const cuts =
    sequence?.clips.slice(0, -1).map((clip) => {
      running += clip.sourceOut - clip.sourceIn;
      return running;
    }) ?? [];
  const nearest = cuts.reduce(
    (best, cut) => (Math.abs(cut - time) < Math.abs(best - time) ? cut : best),
    cuts[0] ?? 0,
  );
  const before = Math.max(0, nearest - 1 / project.settings.fps);
  const after = nearest;
  useEffect(() => {
    let alive = true;
    void Promise.all(
      [before, after].map((t) =>
        api<{ dataUrl: string }>('/preview', {
          method: 'POST',
          body: JSON.stringify({ time: t, sequenceId: project.activeSequenceId, width: 480, height: 480 }),
        }),
      ),
    )
      .then((results) => {
        if (alive) setFrames(results.map((r) => r.dataUrl));
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [project.activeSequenceId, project.revision, before, after]);
  return (
    <Modal title="切点连续性" onClose={onClose} wide>
      <div className="modal-content">
        {error && <div className="inline-error">{error}</div>}
        <div className="cut-comparison">
          {[before, after].map((t, i) => (
            <figure key={i}>
              {frames[i] ? (
                <img src={frames[i]} alt={i === 0 ? '切点前一帧' : '切点后一帧'} />
              ) : (
                <div className="cut-loading">
                  <LoaderCircle className="spin" />
                </div>
              )}
              <figcaption>
                <span>{i === 0 ? '前一帧' : '后一帧'}</span>
                <strong>{sampleTimeline(project, t).shot?.name}</strong>
                <span className="mono">{t.toFixed(3)}s</span>
              </figcaption>
            </figure>
          ))}
        </div>
        <div className="review-checks">
          {['人物左右关系', '注视方向', '动作阶段', '道具状态'].map((label) => (
            <label key={label}>
              <input type="checkbox" />
              {label}
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
