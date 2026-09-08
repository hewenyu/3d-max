import type { Command, CommandResponse, Project } from '../shared/types';
import type { ModelingJob } from '../shared/modeling-jobs';
import { api } from './api';

export function needsModelingWorker(project: Project, commands: Command[]) {
  return (
    commands.some(
      (command) =>
        /^(topology|modifier|mesh|surface|curve|terrain)\./.test(command.type) ||
        Boolean(command.payload.modeling) ||
        Boolean((command.payload.patch as { modeling?: unknown } | undefined)?.modeling),
    ) ||
    project.objects.some((object) => object.modeling?.kind === 'stack' || object.modeling?.kind === 'surface')
  );
}
export async function executeModelingJob(
  project: Project,
  commands: Command[],
  onProgress: (job: ModelingJob) => void,
): Promise<CommandResponse> {
  let job = await api<ModelingJob>('/modeling/jobs', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      expectedRevision: project.revision,
      expectedContext: {
        sceneId: project.production?.activeSceneId ?? null,
        performanceId: project.production?.activePerformanceId ?? null,
      },
      requestId: crypto.randomUUID(),
      commands,
    }),
  });
  onProgress(job);
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 150));
    job = await api<ModelingJob>(`/modeling/jobs/${encodeURIComponent(job.id)}`);
    onProgress(job);
  }
  if (job.status !== 'completed' || !job.result || !('project' in job.result))
    throw Object.assign(
      new Error(job.status === 'cancelled' ? '建模计算已取消' : (job.error?.message ?? '建模计算失败')),
      job.error,
    );
  return job.result as CommandResponse;
}
