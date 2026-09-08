import { z } from 'zod';

const identifier = z.string().min(1).max(200);
const guards = {
  projectId: identifier,
  expectedRevision: z.number().int().min(0),
  expectedContext: z
    .object({ sceneId: identifier.nullable(), performanceId: identifier.nullable() })
    .strict(),
};
export const modelConversionRequestSchema = z.object({ ...guards, objectId: identifier }).strict();
export const modelExportRequestSchema = z
  .object({
    ...guards,
    scope: z.enum(['selection', 'scene']),
    objectIds: z.array(identifier).min(1).max(10000).optional(),
    sourceTime: z.number().finite().min(0).max(100000).default(0),
    includeHidden: z.boolean().default(false),
    name: z.string().trim().min(1).max(180).optional(),
  })
  .strict();
export interface ModelingAssetDiagnostic {
  code: string;
  message: string;
  objectId?: string;
  node?: number;
  primitive?: number;
  attributes?: string[];
}
export interface ModelingAssetProgress {
  stage: 'reading' | 'geometry' | 'encoding' | 'storing';
  completed: number;
  total: number;
}
