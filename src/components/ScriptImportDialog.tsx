import { useRef, useState } from 'react';
import { ArrowLeft, FileInput, LoaderCircle, Plus, Trash2, Upload } from 'lucide-react';
import { api } from '../api';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, Modal, NumberInput } from './Controls';
import {
  refreshScriptBreakdown,
  scriptApplySchema,
  type ScriptBreakdown,
  type ScriptItem,
  type ScriptScene,
} from '../../shared/script-schema';
import { scriptSceneCommandCount } from '../../shared/script-plan';
import './script-import.css';

export function ScriptImportDialog({
  editor,
  onClose,
  onApplied,
}: {
  editor: EditorActions;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const [format, setFormat] = useState<'fountain' | 'json'>('fountain');
  const [source, setSource] = useState('');
  const [breakdown, setBreakdown] = useState<ScriptBreakdown | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [coverage, setCoverage] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const targetProjectId = useRef(editor.project?.id);
  const targetContext = useRef({
    sceneId: editor.project?.production?.activeSceneId ?? null,
    performanceId: editor.project?.production?.activePerformanceId ?? null,
  });
  const close = () => {
    if (!busy) onClose();
  };
  const parse = async () => {
    setError('');
    setBusy(true);
    try {
      const result = await api<ScriptBreakdown>('/script/parse', {
        method: 'POST',
        body: JSON.stringify({ format, source }),
      });
      setBreakdown(result);
      setSelected(result.scenes.filter((scene) => scene.items.length).map((scene) => scene.id));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const load = async (file?: File) => {
    if (!file) return;
    if (file.size > 600000) {
      setError('剧本文件超过 600 KB');
      return;
    }
    try {
      const text = await file.text();
      if (text.length > 200000) throw new Error('剧本超过 200000 字符');
      setSource(text);
      setFormat(file.name.toLowerCase().endsWith('.json') ? 'json' : 'fountain');
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  const updateScene = (id: string, update: (scene: ScriptScene) => ScriptScene) => {
    if (!breakdown) return;
    const scenes = breakdown.scenes.map((scene) => (scene.id === id ? update(scene) : scene));
    const previousCast = new Set(breakdown.scenes.flatMap((scene) => scene.characters));
    const declaredCast = breakdown.characters.filter((name) => !previousCast.has(name));
    setBreakdown(refreshScriptBreakdown({ ...breakdown, characters: declaredCast, scenes }));
    setSelected((previous) =>
      previous.filter((id) => scenes.some((scene) => scene.id === id && scene.items.length)),
    );
  };
  const updateItem = (sceneId: string, itemId: string, patch: Partial<ScriptItem>) =>
    updateScene(sceneId, (scene) => ({
      ...scene,
      items: scene.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    }));
  const chosen = breakdown?.scenes.filter((scene) => selected.includes(scene.id)) ?? [];
  const commandCount = chosen.reduce((sum, scene) => sum + scriptSceneCommandCount(scene, coverage), 0) + 4;
  const blocking =
    breakdown?.diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === 'error' && (!diagnostic.sceneId || selected.includes(diagnostic.sceneId)),
    ) ?? false;
  const valid = breakdown
    ? scriptApplySchema.safeParse({ breakdown, options: { createCoverage: coverage, sceneIds: selected } })
        .success
    : false;
  const apply = async () => {
    if (!breakdown) return;
    setBusy(true);
    setError('');
    try {
      await editor.command(
        'script.apply',
        { breakdown, options: { createCoverage: coverage, sceneIds: selected } },
        { projectId: targetProjectId.current, expectedContext: targetContext.current },
      );
      onApplied?.();
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="剧本拆解" onClose={close} wide>
      <div className="modal-content script-import">
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <fieldset disabled={busy}>
          {!breakdown ? (
            <>
              <div className="script-import-toolbar">
                <div className="segmented" role="group" aria-label="剧本格式">
                  <button
                    type="button"
                    className={format === 'fountain' ? 'active' : ''}
                    onClick={() => setFormat('fountain')}
                  >
                    Fountain
                  </button>
                  <button
                    type="button"
                    className={format === 'json' ? 'active' : ''}
                    onClick={() => setFormat('json')}
                  >
                    JSON
                  </button>
                </div>
                <button className="text-button" onClick={() => fileInput.current?.click()}>
                  <Upload size={15} />
                  导入文件
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".fountain,.txt,.json,text/plain,application/json"
                  hidden
                  aria-label="剧本文件"
                  onChange={(event) => {
                    void load(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </div>
              <textarea
                className="script-source"
                aria-label="剧本文本"
                spellCheck={false}
                value={source}
                maxLength={200000}
                onChange={(event) => setSource(event.target.value)}
              />
              <div className="script-import-footer">
                <span className="muted small">{source.length.toLocaleString()} / 200,000</span>
                <button className="primary-button" disabled={!source.trim()} onClick={() => void parse()}>
                  {busy ? <LoaderCircle size={15} className="spin" /> : <FileInput size={15} />}拆解剧本
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="script-import-toolbar">
                <IconButton icon={ArrowLeft} label="返回剧本文本" onClick={() => setBreakdown(null)} />
                <input
                  aria-label="剧本名称"
                  value={breakdown.title}
                  maxLength={200}
                  onChange={(event) => setBreakdown({ ...breakdown, title: event.target.value })}
                />
                <span className="small muted">
                  {breakdown.scenes.length} 场 / {breakdown.characters.length} 人
                </span>
              </div>
              {breakdown.diagnostics.length > 0 && (
                <ul className="script-diagnostics" aria-label="解析诊断">
                  {breakdown.diagnostics.map((diagnostic, index) => (
                    <li key={`${diagnostic.code}-${index}`} className={`diagnostic-${diagnostic.severity}`}>
                      {diagnostic.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="script-import-toolbar">
                <label className="script-check">
                  <input
                    type="checkbox"
                    checked={coverage}
                    onChange={(event) => setCoverage(event.target.checked)}
                  />
                  对白覆盖镜头
                </label>
                <label className="script-check">
                  <input
                    type="checkbox"
                    aria-label="选择全部场次"
                    checked={
                      selected.length > 0 &&
                      selected.length === breakdown.scenes.filter((scene) => scene.items.length).length
                    }
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? breakdown.scenes.filter((scene) => scene.items.length).map((scene) => scene.id)
                          : [],
                      )
                    }
                  />
                  全部场次
                </label>
              </div>
              {breakdown.scenes.map((scene, index) => (
                <section key={scene.id} className="script-scene">
                  <div className="script-scene-heading">
                    <input
                      type="checkbox"
                      aria-label={`选择场次 ${index + 1}`}
                      checked={selected.includes(scene.id)}
                      disabled={!scene.items.length}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [...selected, scene.id]
                            : selected.filter((id) => id !== scene.id),
                        )
                      }
                    />
                    <input
                      aria-label={`场次 ${index + 1} 标题`}
                      value={scene.heading}
                      maxLength={200}
                      onChange={(event) =>
                        updateScene(scene.id, (current) => ({ ...current, heading: event.target.value }))
                      }
                    />
                    <span className="small muted">{scene.durationSeconds.toFixed(1)} 秒</span>
                  </div>
                  <div className="two-fields">
                    <Field label="地点">
                      <input
                        aria-label={`场次 ${index + 1} 地点`}
                        value={scene.location}
                        maxLength={300}
                        onChange={(event) =>
                          updateScene(scene.id, (current) => ({ ...current, location: event.target.value }))
                        }
                      />
                    </Field>
                    <Field label="时段">
                      <input
                        aria-label={`场次 ${index + 1} 时段`}
                        value={scene.timeOfDay}
                        maxLength={100}
                        onChange={(event) =>
                          updateScene(scene.id, (current) => ({ ...current, timeOfDay: event.target.value }))
                        }
                      />
                    </Field>
                  </div>
                  <div className="script-cast">
                    {scene.characters.map((character) => (
                      <span key={character}>{character}</span>
                    ))}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        updateScene(scene.id, (current) => ({
                          ...current,
                          characters: [...current.characters, `人物 ${current.characters.length + 1}`],
                        }))
                      }
                    >
                      <Plus size={13} />
                      人物
                    </button>
                  </div>
                  {scene.characters.map((character, characterIndex) => (
                    <div className="script-cast-edit" key={`${scene.id}-character-${characterIndex}`}>
                      <input
                        aria-label={`场次 ${index + 1} 人物 ${characterIndex + 1}`}
                        value={character}
                        maxLength={200}
                        onChange={(event) => {
                          const next = event.target.value;
                          updateScene(scene.id, (current) => ({
                            ...current,
                            characters: current.characters.map((name, i) =>
                              i === characterIndex ? next : name,
                            ),
                            items: current.items.map((item) =>
                              item.character === character ? { ...item, character: next } : item,
                            ),
                          }));
                        }}
                      />
                      <IconButton
                        icon={Trash2}
                        label={`移除人物 ${character}`}
                        disabled={scene.items.some((item) => item.character === character)}
                        onClick={() =>
                          updateScene(scene.id, (current) => ({
                            ...current,
                            characters: current.characters.filter((_, i) => i !== characterIndex),
                          }))
                        }
                      />
                    </div>
                  ))}
                  <div className="script-items">
                    {scene.items.map((item, itemIndex) => (
                      <div className="script-item" key={item.id}>
                        <span className="script-item-kind">
                          {item.kind === 'dialogue' ? item.character : '动作'}
                          {item.parallelGroup ? ' / 同时' : ''}
                        </span>
                        <div className="script-item-text">
                          <textarea
                            aria-label={`场次 ${index + 1} 条目 ${itemIndex + 1}`}
                            value={item.text}
                            maxLength={10000}
                            rows={2}
                            onChange={(event) => updateItem(scene.id, item.id, { text: event.target.value })}
                          />
                          {item.direction && <small className="muted">{item.direction}</small>}
                        </div>
                        <NumberInput
                          label={`场次 ${index + 1} 条目 ${itemIndex + 1} 时长`}
                          value={item.durationSeconds}
                          min={0.1}
                          max={600}
                          step={0.1}
                          suffix="秒"
                          onChange={(value) =>
                            updateItem(scene.id, item.id, {
                              durationSeconds: value,
                              durationEstimated: false,
                            })
                          }
                        />
                        <IconButton
                          icon={Trash2}
                          label={`移除场次 ${index + 1} 条目 ${itemIndex + 1}`}
                          onClick={() =>
                            updateScene(scene.id, (current) => ({
                              ...current,
                              items: current.items.filter((entry) => entry.id !== item.id),
                            }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              {commandCount > 500 && (
                <p className="inline-error" role="alert">
                  所选场次约 {commandCount} 条命令，单次上限 500；请选择部分场次。
                </p>
              )}
              <div className="script-import-footer">
                <span className="small muted">
                  已选 {chosen.length} 场 /{' '}
                  {chosen.reduce((sum, scene) => sum + scene.durationSeconds, 0).toFixed(1)} 秒
                </span>
                <button
                  className="primary-button"
                  disabled={blocking || !valid || !selected.length || commandCount > 500}
                  onClick={() => void apply()}
                >
                  {busy ? <LoaderCircle size={15} className="spin" /> : <FileInput size={15} />}创建预演
                </button>
              </div>
            </>
          )}
        </fieldset>
      </div>
    </Modal>
  );
}
