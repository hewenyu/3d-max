import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { z } from 'zod';
import { ApiError } from './errors';
import { renderOptionsSchema } from './render';

export const packageLimits = {
  compressed: 512 * 1024 * 1024,
  expanded: 8 * 1024 * 1024 * 1024,
  record: 256 * 1024 * 1024,
};
const magic = 'WHITEFRAME/2\n';
const id = z.string().regex(/^[a-zA-Z0-9-]{1,160}$/);
export const binarySchema = z
  .object({
    data: z.string().max(packageLimits.compressed * 1.4),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const packageAssetSchema = z
  .object({
    id,
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(100),
    size: z
      .number()
      .int()
      .min(0)
      .max(100 * 1024 * 1024),
    duration: z.number().finite().positive().optional(),
    url: z.string(),
    extension: z.enum(['.glb', '.gltf', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.webm']),
    file: binarySchema,
  })
  .strict();
const renderJobSchema = z
  .object({
    id,
    name: z.string().min(1).max(500).optional(),
    status: z.enum(['queued', 'rendering', 'encoding', 'completed', 'failed', 'cancelled']),
    progress: z.number().finite().min(0).max(1),
    frame: z.number().int().min(0),
    totalFrames: z.number().int().min(0),
    projectRevision: z.number().int().min(0),
    createdAt: z.string().datetime(),
    options: renderOptionsSchema,
    url: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
const historySchema = z.object({ position: z.number().int().min(0), snapshot: z.unknown() }).strict();
const jobSchema = z
  .object({ job: renderJobSchema, snapshot: z.unknown(), file: binarySchema.optional() })
  .strict();
const headerSchema = z
  .object({
    format: z.literal('whiteframe-project'),
    createdAt: z.string().datetime(),
    project: z.unknown(),
    cursor: z.number().int().min(0),
  })
  .strict();
const count = z.number().int().min(0).max(10000);
const recordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('header'), value: headerSchema }).strict(),
  z.object({ type: z.literal('history'), value: historySchema }).strict(),
  z.object({ type: z.literal('asset'), value: packageAssetSchema }).strict(),
  z.object({ type: z.literal('job'), value: jobSchema }).strict(),
  z.object({ type: z.literal('end'), history: count, assets: count, jobs: count }).strict(),
]);
export type PackageRecord = z.infer<typeof recordSchema>;
const legacySchema = headerSchema.extend({
  version: z.literal(1),
  history: z.array(historySchema).min(1).max(10000),
  assets: z.array(packageAssetSchema).max(10000),
  jobs: z.array(jobSchema).max(10000),
});

export async function encodePackageRecords(records: AsyncIterable<PackageRecord>) {
  let expanded = Buffer.byteLength(magic);
  let compressed = 0;
  const chunks: Buffer[] = [];
  const counts = { history: 0, asset: 0, job: 0 };
  async function* lines() {
    yield magic;
    for await (const record of records) {
      if (record.type === 'history' || record.type === 'asset' || record.type === 'job') {
        if (++counts[record.type] > 10000)
          throw new ApiError('PACKAGE_TOO_LARGE', 'Too many package records', 413);
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(`${JSON.stringify(record)}\n`);
      } catch (error) {
        if (error instanceof RangeError)
          throw new ApiError('PACKAGE_TOO_LARGE', 'A package record exceeds the string size limit', 413);
        throw error;
      }
      expanded += bytes.length;
      if (bytes.length > packageLimits.record || expanded > packageLimits.expanded)
        throw new ApiError(
          'PACKAGE_TOO_LARGE',
          'Project package exceeds the record or expanded size limit',
          413,
        );
      yield bytes;
    }
  }
  await pipeline(
    Readable.from(lines()),
    createGzip(),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        compressed += chunk.length;
        if (compressed > packageLimits.compressed)
          callback(new ApiError('PACKAGE_TOO_LARGE', 'Compressed project package exceeds 512 MiB', 413));
        else {
          chunks.push(chunk);
          callback();
        }
      },
    }),
  );
  return Buffer.concat(chunks);
}

export async function* readPackageRecords(data: Buffer): AsyncGenerator<PackageRecord> {
  if (data.length > packageLimits.compressed)
    throw new ApiError('INVALID_PACKAGE', 'Compressed package exceeds 512 MiB');
  const source = Readable.from([data]);
  const unzip = source.pipe(createGunzip());
  let expanded = 0;
  let length = 0;
  let fragments: Buffer[] = [];
  let format: 'unknown' | 'v1' | 'v2' = 'unknown';
  let ended = false;
  let header = false;
  const counts = { history: 0, assets: 0, jobs: 0 };
  const consume = (bytes: Buffer) => {
    fragments.push(bytes);
    length += bytes.length;
    const limit = format === 'v1' ? packageLimits.compressed : packageLimits.record;
    if (length > limit) throw new ApiError('INVALID_PACKAGE', 'Package record exceeds the size limit');
  };
  const record = (line: Buffer) => {
    const parsed = recordSchema.parse(JSON.parse(line.toString('utf8')));
    if (ended || (!header && parsed.type !== 'header') || (header && parsed.type === 'header'))
      throw new ApiError('INVALID_PACKAGE', 'Invalid package record order');
    if (parsed.type === 'header') header = true;
    if (parsed.type === 'history') counts.history++;
    if (parsed.type === 'asset') counts.assets++;
    if (parsed.type === 'job') counts.jobs++;
    if (Object.values(counts).some((value) => value > 10000))
      throw new ApiError('INVALID_PACKAGE', 'Too many package records');
    if (parsed.type === 'end') {
      if (
        !counts.history ||
        parsed.history !== counts.history ||
        parsed.assets !== counts.assets ||
        parsed.jobs !== counts.jobs
      )
        throw new ApiError('INVALID_PACKAGE', 'Package record counts do not match');
      ended = true;
    }
    return parsed;
  };
  try {
    for await (const input of unzip) {
      let chunk = Buffer.from(input as Buffer);
      expanded += chunk.length;
      if (expanded > packageLimits.expanded)
        throw new ApiError('INVALID_PACKAGE', 'Expanded package exceeds 8 GiB');
      if (format === 'unknown') {
        consume(chunk);
        if (length < Buffer.byteLength(magic)) continue;
        chunk = Buffer.concat(fragments);
        fragments = [];
        length = 0;
        format = chunk.subarray(0, magic.length).toString('utf8') === magic ? 'v2' : 'v1';
        if (format === 'v2') chunk = chunk.subarray(magic.length);
      }
      if (format === 'v1') {
        consume(chunk);
        continue;
      }
      let start = 0;
      for (let newline = chunk.indexOf(10, start); newline !== -1; newline = chunk.indexOf(10, start)) {
        consume(chunk.subarray(start, newline));
        yield record(Buffer.concat(fragments, length));
        fragments = [];
        length = 0;
        start = newline + 1;
      }
      if (start < chunk.length) consume(chunk.subarray(start));
    }
    if (format === 'v1') {
      const legacy = legacySchema.parse(JSON.parse(Buffer.concat(fragments, length).toString('utf8')));
      yield {
        type: 'header',
        value: {
          format: legacy.format,
          createdAt: legacy.createdAt,
          project: legacy.project,
          cursor: legacy.cursor,
        },
      };
      for (const value of legacy.history) yield { type: 'history', value };
      for (const value of legacy.assets) yield { type: 'asset', value };
      for (const value of legacy.jobs) yield { type: 'job', value };
      yield {
        type: 'end',
        history: legacy.history.length,
        assets: legacy.assets.length,
        jobs: legacy.jobs.length,
      };
    } else if (format !== 'v2' || length || !ended) {
      throw new ApiError('INVALID_PACKAGE', 'Package is incomplete');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      'INVALID_PACKAGE',
      'Unable to read a valid Whiteframe project package',
      400,
      (error as Error).message,
    );
  } finally {
    source.destroy();
    unzip.destroy();
  }
}
