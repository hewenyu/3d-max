import { z } from 'zod';
import { assetByteLimit } from './assets';
import { packageLimits } from './package-codec';

export const transferLimits = {
  chunkBytes: 1024 * 1024,
  assetBytes: assetByteLimit,
  packageBytes: packageLimits.compressed,
  activeTransfers: 8,
  reservedBytes: 2 * 1024 * 1024 * 1024,
} as const;

const digest = z.string().regex(/^[a-f0-9]{64}$/, 'Use a lowercase SHA-256 hex digest');
export const transferIdSchema = z.object({ id: z.string().uuid() }).strict();
export const transferBeginSchema = z
  .object({
    kind: z.enum(['asset', 'project-package']),
    name: z.string().min(1),
    size: z.number().int().min(1).max(transferLimits.packageBytes),
    sha256: digest,
    requestId: z.string().min(1).max(200),
  })
  .strict();
export const transferChunkSchema = transferIdSchema.extend({
  index: z.number().int().min(0).max(511),
  dataBase64: z
    .string()
    .min(4)
    .max(Math.ceil(transferLimits.chunkBytes / 3) * 4),
  sha256: digest,
  replaceSha256: digest.optional(),
});
export const transferStatusSchema = z.object({ id: z.string().uuid().optional() }).strict();

export type TransferState = 'receiving' | 'committing' | 'completed' | 'cancelled';
export interface TransferRow {
  id: string;
  request_id: string;
  kind: 'asset' | 'project-package';
  name: string;
  size: number;
  sha256: string;
  state: TransferState;
  created_at: string;
  updated_at: string;
  result: string | null;
  last_error: string | null;
}
export interface TransferChunk {
  index: number;
  size: number;
  sha256: string;
}
