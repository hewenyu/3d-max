import { z } from 'zod';
import type { CommandResponse } from './types';
import { componentKindSchema } from './topology-schema';
import {
  modelConversionRequestSchema,
  modelExportRequestSchema,
  type ModelingAssetProgress,
} from './model-assets';

const identifier = z.string().min(1).max(200);
const base = z
  .object({
    projectId: identifier,
    expectedRevision: z.number().int().min(0),
    expectedContext: z
      .object({ sceneId: identifier.nullable(), performanceId: identifier.nullable() })
      .strict(),
    requestId: identifier,
  })
  .strict();
export const modelingCommandJobRequestSchema = base
  .extend({
    kind: z.literal('commands').default('commands'),
    commands: z
      .array(z.object({ type: identifier, payload: z.record(z.unknown()) }).strict())
      .min(1)
      .max(200),
  })
  .strict();
export const modelingInspectJobRequestSchema = base
  .extend({
    kind: z.literal('inspect'),
    objectId: identifier,
    stage: z.enum(['source', 'evaluated']).default('source'),
    componentKind: componentKindSchema.default('face'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(2000).default(200),
    tolerance: z.number().finite().positive().max(1000).optional(),
  })
  .strict();
export const modelConversionJobRequestSchema = base
  .merge(modelConversionRequestSchema)
  .extend({ kind: z.literal('conversion') })
  .strict();
export const modelExportJobRequestSchema = base
  .merge(modelExportRequestSchema)
  .extend({ kind: z.literal('export') })
  .strict();
export const modelingJobRequestSchema = z.union([
  modelingCommandJobRequestSchema,
  modelingInspectJobRequestSchema,
  modelConversionJobRequestSchema,
  modelExportJobRequestSchema,
]);
export type ModelingCommandJobRequest = z.infer<typeof modelingCommandJobRequestSchema>;
export type ModelingInspectJobRequest = z.infer<typeof modelingInspectJobRequestSchema>;
export type ModelingJobRequest = z.infer<typeof modelingJobRequestSchema>;
export type ModelingJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface ModelingJobProgress {
  phase: 'queued' | 'starting' | 'computing' | 'committing' | 'finished';
  completedCommands: number;
  totalCommands: number;
  stage?: 'computing' | 'validating';
  asset?: ModelingAssetProgress;
}
export interface ModelingJobError {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
}
export interface ModelingJob {
  id: string;
  kind: ModelingJobRequest['kind'];
  projectId: string;
  sourceRevision: number;
  sourceContext: ModelingJobRequest['expectedContext'];
  requestId: string;
  status: ModelingJobStatus;
  progress: ModelingJobProgress;
  snapshotHash: string;
  requestHash: string;
  assetSnapshotHash?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  resultHash?: string;
  error?: ModelingJobError;
  result?: CommandResponse | Record<string, unknown>;
}
export const MODELING_JOB_LIMITS = {
  unfinished: 8,
  snapshotBytes: 64 * 1024 * 1024,
  requestBytes: 32 * 1024 * 1024,
  resultBytes: 128 * 1024 * 1024,
  reservedBytes: 256 * 1024 * 1024,
  timeoutMs: 120000,
  memoryMb: 512,
} as const;
