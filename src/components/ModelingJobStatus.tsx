import { LoaderCircle, X } from 'lucide-react';
import type { EditorActions } from '../useEditor';
import { IconButton } from './Controls';

export function ModelingJobStatus({ editor }: { editor: EditorActions }) {
  const job = editor.modelingJob;
  if (!job || !['queued', 'running'].includes(job.status)) return null;
  return (
    <div className="modeling-job-status" role="status">
      <LoaderCircle size={15} className="spin" />
      <span>
        {job.status === 'queued'
          ? '等待建模计算'
          : job.progress.stage === 'validating'
            ? '校验几何'
            : '计算几何'}{' '}
        {job.progress.completedCommands} / {job.progress.totalCommands}
      </span>
      <IconButton
        icon={X}
        label="取消建模计算"
        onClick={() => {
          void editor.cancelModeling().catch((error: Error) => editor.setError(error.message));
        }}
      />
    </div>
  );
}
