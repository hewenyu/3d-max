import type {
  exportModelAsset,
  ModelingAssetDiagnostic,
  planModelConversion,
} from '../../../server/modeling-assets';
import type { Project } from '../../../shared/types';
import type { ModelingJob } from '../../../shared/modeling-jobs';

export type ModelConversion = Awaited<ReturnType<typeof planModelConversion>>;
export type ModelExport = Awaited<ReturnType<typeof exportModelAsset>>;
export type ModelDiagnostic = ModelingAssetDiagnostic;
export class ModelAssetError extends Error {
  constructor(
    message: string,
    public code?: string,
    public diagnostics: ModelDiagnostic[] = [],
  ) {
    super(message);
  }
}
export function modelAssetGuard(project: Project) {
  return {
    projectId: project.id,
    expectedRevision: project.revision,
    expectedContext: {
      sceneId: project.production?.activeSceneId ?? null,
      performanceId: project.production?.activePerformanceId ?? null,
    },
  };
}
async function jobRequest(path: string, input?: Record<string, unknown>): Promise<ModelingJob> {
  const response = await fetch(
    `/api/modeling/jobs${path}`,
    input
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }
      : undefined,
  );
  const data = await response.json();
  if (!response.ok)
    throw new ModelAssetError(
      data.error?.message ?? `模型处理失败 (${response.status})`,
      data.error?.code,
      data.error?.details?.diagnostics ?? [],
    );
  return data as ModelingJob;
}
export function cancelModelAsset(id: string) {
  return jobRequest(`/${encodeURIComponent(id)}/cancel`, {});
}
export async function requestModelAsset<T>(
  kind: 'conversion' | 'export',
  input: Record<string, unknown>,
  onProgress: (job: ModelingJob) => void,
): Promise<T> {
  const request = { ...input, kind, requestId: crypto.randomUUID() };
  let job: ModelingJob;
  try {
    job = await jobRequest('', request);
  } catch (error) {
    if (error instanceof ModelAssetError) throw error;
    job = await jobRequest('', request);
  }
  onProgress(job);
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 150));
    job = await jobRequest(`/${encodeURIComponent(job.id)}`);
    onProgress(job);
  }
  if (job.status !== 'completed' || !job.result) {
    const details = job.error?.details as { diagnostics?: ModelDiagnostic[] } | undefined;
    throw new ModelAssetError(
      job.status === 'cancelled' ? '模型处理已取消' : (job.error?.message ?? '模型处理失败'),
      job.status === 'cancelled' ? 'MODELING_CANCELLED' : job.error?.code,
      details?.diagnostics ?? [],
    );
  }
  return job.result as T;
}

export function modelDiagnosticMessage(diagnostic: ModelDiagnostic) {
  const labels: Record<string, string> = {
    CONVERSION_ATTRIBUTES: '法线将重新计算，其余顶点属性保留在原始模型中。',
    WHITE_MATERIAL: '材质和贴图保留在原始模型中，转换结果使用白模材质。',
    FLATTENED_STATIC_SCENE: '当前模型场景合并为一张网格；节点层级、模型相机和其他场景保留在原始模型中。',
    SKINNED_MODEL: '蒙皮模型不支持静态网格转换。',
    ANIMATED_MODEL: '含内嵌动画的模型不支持静态网格转换。',
    MORPH_TARGETS: '含形态键的模型不支持静态网格转换。',
    SKIN_ATTRIBUTES: '关节和蒙皮权重无法保存在静态网格中。',
    PRIMITIVE_MODE: '仅支持由三角面组成的模型。',
    POSITION_ATTRIBUTE: '模型缺少有效的顶点位置属性。',
    BONE_ATTACHMENT: '骨骼挂接对象需先解除挂接。',
    ANIMATED_RIG: '角色、载具和特效需要专用姿态导出，无法导出为当前静态 GLB。',
    MULTI_MATERIAL: '多材质几何需要先拆分后再导出。',
    EMPTY_OBJECT: '对象没有可导出的三角面。',
  };
  return labels[diagnostic.code] ?? diagnostic.message;
}
