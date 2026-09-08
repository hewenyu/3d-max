import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { CommandResponse, Project } from '../shared/types';
import type { ModelingAssetProgress } from '../shared/model-assets';
import {
  MODELING_JOB_LIMITS,
  type ModelingCommandJobRequest,
  type ModelingJobError,
} from '../shared/modeling-jobs';

export interface ModelingJobCheckedCommit {
  jobId: string;
  snapshot: Project;
  snapshotHash: string;
  request: ModelingCommandJobRequest;
  requestHash: string;
  response: CommandResponse;
  responseHash: string;
}
export type ModelingJobCommit = (
  checked: ModelingJobCheckedCommit,
  publish: (response: CommandResponse) => void,
) => CommandResponse;
export interface ModelingWorkerInput {
  snapshot: string;
  request: string;
  snapshotHash: string;
  requestHash: string;
  cancellation: SharedArrayBuffer;
  assets?: string;
  assetSnapshotHash?: string;
}
export type ModelingWorkerMessage =
  | { type: 'ready' }
  | { type: 'progress'; phase: 'computing' | 'validating'; completed: number; total: number }
  | { type: 'asset-progress'; progress: ModelingAssetProgress }
  | {
      type: 'result';
      snapshotHash: string;
      requestHash: string;
      response: string;
      responseHash: string;
      assetSnapshotHash?: string;
      bytes?: ArrayBuffer;
    }
  | { type: 'error'; error: ModelingJobError };
export function modelingDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createModelingWorker(input: ModelingWorkerInput): Worker {
  const loader = import.meta.resolve('tsx/esm/api');
  const workerUrl = new URL('./modeling-jobs-worker.ts', import.meta.url).href;
  // Keep cancellable computation outside async ES-module evaluation (Node 24 worker termination).
  const script = `const { parentPort,workerData } = require('node:worker_threads');
    import(${JSON.stringify(loader)}).then(({ tsImport }) => tsImport(${JSON.stringify(workerUrl)}, ${JSON.stringify(import.meta.url)}))
    .then(({ runModelingWorker }) => setImmediate(() => {
      if (Atomics.load(new Int32Array(workerData.cancellation),0)) { parentPort.close(); return; }
      parentPort.postMessage({type:'ready'});
      setImmediate(runModelingWorker);
    }));`;
  return new Worker(script, {
    eval: true,
    workerData: input,
    execArgv: [],
    name: 'whiteframe-modeling',
    resourceLimits: { maxOldGenerationSizeMb: MODELING_JOB_LIMITS.memoryMb, stackSizeMb: 16 },
  });
}
