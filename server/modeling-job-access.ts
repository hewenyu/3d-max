import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import { ModelingJobService } from './modeling-jobs';
import type { ServerConfig } from './config';
import type { ModelingJob, ModelingJobRequest } from '../shared/modeling-jobs';
import { meshInspectSchema } from '../shared/topology-schema';
import { modelConversionRequestSchema, modelExportRequestSchema } from '../shared/model-assets';
import { guardedMeshSource, type inspectMesh } from './modeling-service';
import { guardedModelProject, type planModelConversion, type exportModelAsset } from './modeling-assets';
import { ApiError, errorStatus } from './errors';

const services = new WeakMap<Store, ModelingJobService>();
export function getModelingJobService(store: Store, config?: ServerConfig) {
  let service = services.get(store);
  if (!service) {
    service = new ModelingJobService(
      store,
      (checked, publish) => store.commitModelingJob(checked, publish),
      config,
    );
    services.set(store, service);
  }
  return service;
}

export function waitForModelingJob<T>(service: ModelingJobService, request: ModelingJobRequest): Promise<T> {
  const started = service.start(request);
  return new Promise<T>((resolve, reject) => {
    const receive = (job: ModelingJob) => {
      if (job.id !== started.id || job.status === 'queued' || job.status === 'running') return;
      service.off('job', receive);
      if (job.status === 'completed') {
        const result = service.status(job.id).result;
        if (result === undefined)
          reject(new ApiError('MODELING_RESULT_MISSING', 'Modeling job completed without a result', 500));
        else resolve(result as T);
      } else if (job.status === 'cancelled') {
        reject(new ApiError('MODELING_CANCELLED', 'Modeling job was cancelled', 409));
      } else {
        const error = job.error ?? { code: 'MODELING_FAILED', message: 'Modeling job failed', status: 500 };
        reject(new ApiError(error.code, error.message, errorStatus(error), error.details));
      }
    };
    service.on('job', receive);
    receive(service.status(started.id));
  });
}

export function inspectMeshInWorker(store: Store, config: ServerConfig, source: unknown) {
  const { kind: componentKind, ...input } = meshInspectSchema.parse(source);
  guardedMeshSource(store, input);
  return waitForModelingJob<ReturnType<typeof inspectMesh>>(getModelingJobService(store, config), {
    ...input,
    kind: 'inspect',
    componentKind,
    requestId: randomUUID(),
  });
}

export function planModelConversionInWorker(store: Store, config: ServerConfig, source: unknown) {
  const input = modelConversionRequestSchema.parse(source);
  guardedModelProject(store, input);
  return waitForModelingJob<Awaited<ReturnType<typeof planModelConversion>>>(
    getModelingJobService(store, config),
    {
      ...input,
      kind: 'conversion',
      requestId: randomUUID(),
    },
  );
}

export function exportModelAssetInWorker(store: Store, config: ServerConfig, source: unknown) {
  const input = modelExportRequestSchema.parse(source);
  guardedModelProject(store, input);
  return waitForModelingJob<Awaited<ReturnType<typeof exportModelAsset>>>(
    getModelingJobService(store, config),
    {
      ...input,
      kind: 'export',
      requestId: randomUUID(),
    },
  );
}
