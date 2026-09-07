import { useRef, useState } from 'react';
import { Download, LoaderCircle, Package, Upload } from 'lucide-react';
import type { EditorActions } from '../useEditor';
import { api } from '../api';
import { Field, Section } from './Controls';

interface PackageExport {
  url: string;
  size: number;
  assets: number;
  videos: number;
  revision: number;
}

export function ProjectPackageControls({
  editor,
  onImported,
}: {
  editor: EditorActions;
  onImported: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState(true);
  const [videos, setVideos] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PackageExport | null>(null);
  const exportPackage = async () => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(
        await api<PackageExport>('/packages/export', {
          method: 'POST',
          body: JSON.stringify({
            projectId: editor.project?.id,
            includeHistory: history,
            includeVideos: videos,
          }),
        }),
      );
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const importPackage = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      if (await editor.replace('/packages/import', form)) onImported();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="项目包">
      <fieldset disabled={busy}>
        <Field label="编辑历史">
          <input
            type="checkbox"
            aria-label="项目包包含编辑历史"
            checked={history}
            onChange={(event) => setHistory(event.target.checked)}
          />
        </Field>
        <Field label="成片视频">
          <input
            type="checkbox"
            aria-label="项目包包含成片视频"
            checked={videos}
            onChange={(event) => setVideos(event.target.checked)}
          />
        </Field>
        <div className="two-fields">
          <button className="text-button" onClick={() => void exportPackage()} disabled={!editor.project}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Package size={15} />}导出项目包
          </button>
          <button className="text-button" onClick={() => input.current?.click()}>
            <Upload size={15} />
            恢复项目包
          </button>
        </div>
        <input
          ref={input}
          type="file"
          accept=".whiteframe,application/gzip"
          aria-label="恢复项目包文件"
          hidden
          onChange={(event) => {
            void importPackage(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </fieldset>
      {result && (
        <div className="row">
          <a className="text-button" href={result.url} download>
            <Download size={15} />
            下载项目包
          </a>
          <span className="small muted">
            r{result.revision} · {(result.size / 1024 / 1024).toFixed(2)} MB
          </span>
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
