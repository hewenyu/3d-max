import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, Speech } from 'lucide-react';
import type { SpeechCatalog, SpeechEngine, SpeechRequest, SpeechResult } from '../../shared/speech';
import { speechCatalogSchema } from '../../shared/speech';
import type { Project } from '../../shared/types';
import { api, ApiError } from '../api';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, NumberInput } from './Controls';
import './speech.css';

export function SpeechPanel({
  project,
  editor,
  sourceTime,
}: {
  project: Project;
  editor: EditorActions;
  sourceTime: number;
}) {
  const [catalog, setCatalog] = useState<SpeechCatalog | null>(null);
  const [engine, setEngine] = useState<SpeechEngine>('say');
  const [voice, setVoice] = useState('');
  const [text, setText] = useState('');
  const [rate, setRate] = useState(180);
  const [start, setStart] = useState(sourceTime);
  const [beatId, setBeatId] = useState('');
  const [actorId, setActorId] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SpeechResult['speech'] | null>(null);
  const pending = useRef<{ signature: string; request: SpeechRequest } | null>(null);
  const mounted = useRef(true);
  const load = async () => {
    setLoading(true);
    try {
      const parsed = speechCatalogSchema.safeParse(await api<unknown>('/speech/catalog'));
      if (!mounted.current) return;
      if (!parsed.success) throw new Error('语音目录响应无效，请刷新重试');
      const next = parsed.data;
      setCatalog(next);
      const preferred =
        next.engines.find(
          (item) => item.available && item.voices.some((item) => item.language === 'zh-CN'),
        ) ?? next.engines.find((item) => item.available && item.voices.length > 0);
      if (preferred) {
        setEngine(preferred.id);
        setVoice(preferred.voices.find((item) => item.language === 'zh-CN')?.id ?? preferred.voices[0].id);
      } else setVoice('');
      setError('');
    } catch (failure) {
      if (mounted.current) {
        setCatalog(null);
        setError((failure as Error).message);
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, []);
  const selectedEngine = catalog?.engines.find((item) => item.id === engine);
  const selectedBeat = project.beats.find((beat) => beat.id === beatId);
  const take = project.production?.scenes
    .find((scene) => scene.id === project.production?.activeSceneId)
    ?.performances.find((item) => item.id === project.production?.activePerformanceId);
  const locked = Boolean(selectedBeat?.locked || take?.locked);
  const synthesize = async () => {
    const options = {
      engine,
      voice,
      text,
      rate,
      start,
      actorId: actorId || null,
      ...(beatId ? { beatId } : {}),
      name: selectedBeat?.label ?? '临时对白',
      projectId: project.id,
      expectedContext: {
        sceneId: project.production?.activeSceneId ?? null,
        performanceId: project.production?.activePerformanceId ?? null,
      },
    };
    const signature = JSON.stringify(options);
    if (pending.current?.signature !== signature)
      pending.current = {
        signature,
        request: { ...options, expectedRevision: project.revision, requestId: crypto.randomUUID() },
      };
    setBusy(true);
    setError('');
    try {
      const next = await api<SpeechResult>('/speech/synthesize', {
        method: 'POST',
        body: JSON.stringify(pending.current.request),
      });
      editor.acceptCurrent(next.project);
      pending.current = null;
      if (mounted.current) setResult(next.speech);
    } catch (failure) {
      if (failure instanceof ApiError) pending.current = null;
      if (mounted.current) setError((failure as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="speech-panel">
      <div className="row">
        <Speech size={15} />
        <strong>合成对白</strong>
        <IconButton
          icon={RefreshCw}
          label="刷新可用语音"
          disabled={loading || busy}
          onClick={() => void load()}
        />
      </div>
      {loading && <div role="status">读取语音中</div>}
      {catalog && !catalog.available && (
        <div className="speech-diagnostic" role="status">
          {catalog.encoding.diagnostic ??
            catalog.engines
              .map((item) => item.diagnostic)
              .filter(Boolean)
              .join('\n')}
        </div>
      )}
      <fieldset disabled={busy || editor.busy || !catalog?.available}>
        <Field label="对白节拍">
          <select
            aria-label="合成对白节拍"
            value={beatId}
            onChange={(event) => {
              const id = event.target.value;
              setBeatId(id);
              const beat = project.beats.find((item) => item.id === id);
              if (beat) {
                setText(beat.text);
                setActorId(beat.actorId ?? '');
                setStart(beat.time);
              }
            }}
          >
            <option value="">新建对白</option>
            {project.beats
              .filter((beat) => beat.kind === 'dialogue')
              .map((beat) => (
                <option key={beat.id} value={beat.id} disabled={beat.locked}>
                  {beat.label}
                </option>
              ))}
          </select>
        </Field>
        <Field label="角色">
          <select
            aria-label="合成对白角色"
            value={actorId}
            onChange={(event) => setActorId(event.target.value)}
          >
            <option value="">旁白 / 未指定</option>
            {project.objects
              .filter((item) => item.actor || item.type === 'model')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="语音引擎">
          <select
            aria-label="语音引擎"
            value={engine}
            onChange={(event) => {
              const id = event.target.value as SpeechEngine;
              setEngine(id);
              setVoice(catalog?.engines.find((item) => item.id === id)?.voices[0]?.id ?? '');
            }}
          >
            {catalog?.engines.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.available}>
                {item.name}
                {item.available ? '' : ' (不可用)'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="语音">
          <select aria-label="对白语音" value={voice} onChange={(event) => setVoice(event.target.value)}>
            {selectedEngine?.voices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.language}
              </option>
            ))}
          </select>
        </Field>
        <Field label="语速">
          <NumberInput label="对白语速" value={rate} min={80} max={350} step={10} onChange={setRate} />
        </Field>
        <Field label="源时间">
          <NumberInput
            label="合成对白开始"
            value={start}
            min={0}
            max={86400}
            step={1 / project.settings.fps}
            onChange={setStart}
          />
        </Field>
        <textarea
          aria-label="合成对白文本"
          value={text}
          maxLength={5000}
          rows={4}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          className="text-button full-width"
          disabled={!text.trim() || !voice || locked}
          onClick={() => void synthesize()}
        >
          {busy ? <LoaderCircle size={15} className="spin" /> : <Speech size={15} />}{' '}
          {busy ? '合成中' : '合成并加入时间线'}
        </button>
      </fieldset>
      {locked && <div className="speech-diagnostic">对白节拍或表演版本已锁定</div>}
      {error && (
        <div className="speech-diagnostic" role="alert">
          {error}
        </div>
      )}
      {result && (
        <div className="speech-result">
          <span role="status">已生成 {result.duration.toFixed(2)} s</span>
          <audio aria-label="合成对白试听" controls preload="metadata" src={result.url} />
        </div>
      )}
    </div>
  );
}
