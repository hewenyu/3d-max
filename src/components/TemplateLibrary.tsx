import { useCallback, useEffect, useState } from 'react';
import { Box, Check, Download, Layers, LoaderCircle, Pencil, RefreshCw, Save, Trash2, X } from 'lucide-react';
import type { Project } from '../../shared/types';
import type { TemplateContent, TemplateSummary } from '../../shared/templates';
import type { EditorActions } from '../useEditor';
import { api } from '../api';
import { Field, IconButton, Section } from './Controls';
import './templates.css';

export function TemplateLibrary({
  project,
  selected,
  editor,
  onInserted,
}: {
  project: Project;
  selected: string[];
  editor: EditorActions;
  onInserted: (ids: string[], scene: boolean) => void;
}) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [kind, setKind] = useState<TemplateContent['kind']>('objects');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<TemplateSummary | null>(null);
  const reload = useCallback(async () => setTemplates(await api<TemplateSummary[]>('/templates')), []);
  const perform = async (run: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void reload().catch((failure: Error) => setError(failure.message));
  }, [reload]);
  const objectIds = selected.filter((id) => project.objects.some((object) => object.id === id));
  const save = () =>
    perform(async () => {
      await api('/templates', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description,
          kind,
          objectIds: kind === 'objects' ? objectIds : undefined,
          projectId: project.id,
          expectedRevision: project.revision,
          requestId: crypto.randomUUID(),
        }),
      });
      setName('');
      setDescription('');
      await reload();
    });
  const insert = (template: TemplateSummary) =>
    perform(async () => {
      const context = {
        projectId: project.id,
        expectedContext: {
          sceneId: project.production?.activeSceneId ?? null,
          performanceId: project.production?.activePerformanceId ?? null,
        },
      };
      const saved = await api<{ content: TemplateContent }>(`/templates/${template.id}`);
      const response = await editor.command('template.instantiate', { template: saved.content }, context);
      const result = response?.results[0] as
        { objectIds: string[]; groupId?: string; sceneId?: string } | undefined;
      if (result) onInserted(result.groupId ? [result.groupId] : result.objectIds, !!result.sceneId);
    });
  const update = () =>
    perform(async () => {
      if (!editing) return;
      await api(`/templates/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editing.name,
          description: editing.description,
          expectedRevision: editing.revision,
        }),
      });
      setEditing(null);
      await reload();
    });
  return (
    <div className="template-library">
      <Section title="保存模板">
        <fieldset disabled={busy || editor.busy}>
          <Field label="内容">
            <select
              aria-label="模板内容"
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              <option value="objects">选中对象组合</option>
              <option value="scene">当前场景与表演</option>
            </select>
          </Field>
          <Field label="名称">
            <input
              aria-label="新模板名称"
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="备注">
            <input
              aria-label="新模板备注"
              value={description}
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <button
            className="text-button full-width"
            disabled={!name.trim() || (kind === 'objects' && !objectIds.length)}
            onClick={() => void save()}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存模板
          </button>
        </fieldset>
      </Section>
      <div className="template-filter">
        <input
          aria-label="搜索模板"
          placeholder="搜索模板"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <IconButton
          icon={RefreshCw}
          label="刷新模板库"
          disabled={busy}
          onClick={() => void perform(reload)}
        />
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="template-list">
        {templates
          .filter((template) =>
            `${template.name} ${template.description}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((template) => (
            <div className="template-row" key={template.id}>
              <div className="template-row-title">
                {template.kind === 'scene' ? <Layers size={17} /> : <Box size={17} />}
                <strong>{template.name}</strong>
              </div>
              <span className="small muted">
                {template.objectCount} 对象 · {template.shotCount} 镜头
              </span>
              {template.description && <p className="small muted">{template.description}</p>}
              <div className="template-row-actions">
                <button
                  className="text-button"
                  disabled={busy || editor.busy}
                  onClick={() => void insert(template)}
                >
                  <Download size={14} />
                  置入
                </button>
                <IconButton
                  icon={Pencil}
                  label={`编辑模板 ${template.name}`}
                  disabled={busy}
                  onClick={() => setEditing(template)}
                />
                <IconButton
                  icon={Trash2}
                  label={`删除模板 ${template.name}`}
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await api(`/templates/${template.id}`, { method: 'DELETE' });
                      await reload();
                    })
                  }
                />
              </div>
              {editing?.id === template.id && (
                <div className="template-edit">
                  <input
                    aria-label="模板名称"
                    value={editing.name}
                    maxLength={200}
                    onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                  />
                  <input
                    aria-label="模板备注"
                    value={editing.description}
                    maxLength={2000}
                    onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                  />
                  <div className="row">
                    <IconButton
                      icon={Check}
                      label="保存模板信息"
                      disabled={busy || !editing.name.trim()}
                      onClick={() => void update()}
                    />
                    <IconButton icon={X} label="取消模板编辑" onClick={() => setEditing(null)} />
                  </div>
                </div>
              )}
            </div>
          ))}
        {!templates.length && <div className="empty-state">暂无模板</div>}
      </div>
    </div>
  );
}
