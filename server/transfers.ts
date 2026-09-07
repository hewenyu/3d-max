import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Store } from './store';
import type { ServerConfig } from './config';
import { ApiError, errorBody } from './errors';
import { assetFileType, importAssetFile, type AssetImportResult } from './assets';
import { importProjectPackage, type PackageImportResult } from './project-packages';
import {
  transferBeginSchema,
  transferChunkSchema,
  transferIdSchema,
  transferLimits,
  type TransferChunk,
  type TransferRow,
} from './transfer-schema';

type TransferResult = AssetImportResult | PackageImportResult;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export class TransferService {
  private readonly directory: string;
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly config: ServerConfig,
  ) {
    this.directory = resolve(config.dataDir, 'transfers');
    mkdirSync(this.directory, { recursive: true });
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS file_transfers (
        id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        result TEXT, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS file_transfer_chunks (
        transfer_id TEXT NOT NULL REFERENCES file_transfers(id),
        chunk_index INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        PRIMARY KEY(transfer_id,chunk_index)
      );
      UPDATE file_transfers SET state='receiving' WHERE state='committing';
    `);
  }

  private row(id: string): TransferRow {
    transferIdSchema.parse({ id });
    const row = this.store.db.prepare('SELECT * FROM file_transfers WHERE id=?').get(id) as
      TransferRow | undefined;
    if (!row) throw new ApiError('NOT_FOUND', 'Transfer not found', 404);
    return row;
  }

  private chunks(id: string): TransferChunk[] {
    return this.store.db
      .prepare(
        'SELECT chunk_index AS "index",size,sha256 FROM file_transfer_chunks WHERE transfer_id=? ORDER BY chunk_index',
      )
      .all(id) as unknown as TransferChunk[];
  }

  private snapshot(row: TransferRow, includeResult = true) {
    const chunks = this.chunks(row.id);
    const indexes = new Set(chunks.map((chunk) => chunk.index));
    const totalChunks = Math.ceil(row.size / transferLimits.chunkBytes);
    return {
      id: row.id,
      requestId: row.request_id,
      kind: row.kind,
      name: row.name,
      size: row.size,
      sha256: row.sha256,
      state: row.state,
      chunkBytes: transferLimits.chunkBytes,
      totalChunks,
      receivedBytes: chunks.reduce((sum, chunk) => sum + chunk.size, 0),
      chunks,
      missingChunks: Array.from({ length: totalChunks }, (_, index) => index).filter(
        (index) => !indexes.has(index),
      ),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_error ? { lastError: JSON.parse(row.last_error) } : {}),
      ...(includeResult && row.result ? { result: JSON.parse(row.result) as TransferResult } : {}),
    };
  }

  status(id: string) {
    return this.snapshot(this.row(id));
  }

  list() {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM file_transfers ORDER BY CASE WHEN state IN ('receiving','committing') THEN 0 ELSE 1 END,created_at DESC LIMIT 100",
      )
      .all() as unknown as TransferRow[];
    return rows.map((row) => this.snapshot(row, false));
  }

  private assertReceiving(row: TransferRow) {
    if (row.state === 'cancelled') throw new ApiError('TRANSFER_CANCELLED', 'Transfer was cancelled', 409);
    if (row.state !== 'receiving')
      throw new ApiError('TRANSFER_NOT_WRITABLE', `Transfer is ${row.state}`, 409);
  }

  private async exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    this.pending.set(id, current);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.pending.get(id) === current) this.pending.delete(id);
    }
  }

  async begin(input: unknown) {
    const options = transferBeginSchema.parse(input);
    const limit = options.kind === 'asset' ? transferLimits.assetBytes : transferLimits.packageBytes;
    if (options.size > limit)
      throw new ApiError('TRANSFER_TOO_LARGE', `The ${options.kind} limit is ${limit} bytes`, 413);
    if (options.kind === 'asset') assetFileType(options.name);
    const db = this.store.db;
    let id: string;
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db
        .prepare('SELECT * FROM file_transfers WHERE request_id=?')
        .get(options.requestId) as TransferRow | undefined;
      if (existing) {
        if (
          existing.kind !== options.kind ||
          existing.name !== options.name ||
          existing.size !== options.size ||
          existing.sha256 !== options.sha256
        )
          throw new ApiError('IDEMPOTENCY_CONFLICT', 'This requestId describes a different upload', 409);
        id = existing.id;
      } else {
        const reserved = db
          .prepare(
            "SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM file_transfers WHERE state IN ('receiving','committing')",
          )
          .get() as { count: number; bytes: number };
        if (
          reserved.count >= transferLimits.activeTransfers ||
          reserved.bytes + options.size > transferLimits.reservedBytes
        )
          throw new ApiError(
            'TRANSFER_QUOTA',
            'Finish or cancel pending uploads before reserving more storage',
            429,
            transferLimits,
          );
        id = randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO file_transfers(id,request_id,kind,name,size,sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'receiving',?,?)",
        ).run(id, options.requestId, options.kind, options.name, options.size, options.sha256, now, now);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return this.status(id);
  }

  async chunk(input: unknown) {
    const options = transferChunkSchema.parse(input);
    if (options.dataBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(options.dataBase64))
      throw new ApiError('INVALID_BASE64', 'Chunk content must use canonical padded base64');
    const bytes = Buffer.from(options.dataBase64, 'base64');
    if (bytes.toString('base64') !== options.dataBase64)
      throw new ApiError('INVALID_BASE64', 'Chunk content must use canonical padded base64');
    if (sha256(bytes) !== options.sha256)
      throw new ApiError('CHECKSUM_MISMATCH', 'Chunk SHA-256 does not match its bytes');
    return this.exclusive(options.id, async () => {
      const row = this.row(options.id);
      this.assertReceiving(row);
      const offset = options.index * transferLimits.chunkBytes;
      if (offset >= row.size || bytes.length !== Math.min(transferLimits.chunkBytes, row.size - offset))
        throw new ApiError('INVALID_CHUNK', 'Chunk index or byte length does not match this transfer');
      const existing = this.chunks(row.id).find((chunk) => chunk.index === options.index);
      if (existing && existing.sha256 !== options.sha256 && options.replaceSha256 !== existing.sha256)
        throw new ApiError(
          'CHUNK_CONFLICT',
          'Chunk already exists; provide its current replaceSha256 to replace it',
          409,
          existing,
        );
      if (options.replaceSha256 && existing?.sha256 !== options.replaceSha256)
        throw new ApiError('CHUNK_CONFLICT', 'The chunk changed before replacement', 409, existing);
      const directory = resolve(this.directory, row.id);
      await mkdir(directory, { recursive: true });
      const temporary = resolve(directory, `${options.index}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { flag: 'wx', flush: true });
        this.assertReceiving(this.row(row.id));
        await rename(temporary, resolve(directory, `${options.index}.part`));
        this.assertReceiving(this.row(row.id));
        this.store.db
          .prepare(
            'INSERT INTO file_transfer_chunks(transfer_id,chunk_index,size,sha256) VALUES(?,?,?,?) ON CONFLICT(transfer_id,chunk_index) DO UPDATE SET size=excluded.size,sha256=excluded.sha256',
          )
          .run(row.id, options.index, bytes.length, options.sha256);
        this.store.db
          .prepare('UPDATE file_transfers SET updated_at=?,last_error=NULL WHERE id=?')
          .run(new Date().toISOString(), row.id);
      } finally {
        await unlink(temporary).catch(() => {});
        if (this.row(row.id).state === 'cancelled') await rm(directory, { recursive: true, force: true });
      }
      return { ...this.status(row.id), replayed: existing?.sha256 === options.sha256 };
    });
  }

  private async assemble(row: TransferRow) {
    const file = resolve(this.directory, row.id, 'assembled');
    const output = await open(file, 'w');
    const digest = createHash('sha256');
    try {
      for (const chunk of this.chunks(row.id)) {
        if (this.row(row.id).state === 'cancelled')
          throw new ApiError('TRANSFER_CANCELLED', 'Transfer was cancelled', 409);
        let bytes: Buffer;
        try {
          bytes = await readFile(resolve(this.directory, row.id, `${chunk.index}.part`));
        } catch {
          throw new ApiError('TRANSFER_CHUNK_MISSING', 'Resend a missing chunk', 409, { index: chunk.index });
        }
        if (bytes.length !== chunk.size || sha256(bytes) !== chunk.sha256)
          throw new ApiError('CHECKSUM_MISMATCH', 'Resend a damaged stored chunk', 409, {
            index: chunk.index,
          });
        digest.update(bytes);
        await output.writeFile(bytes);
      }
      await output.sync();
      if (digest.digest('hex') !== row.sha256)
        throw new ApiError(
          'CHECKSUM_MISMATCH',
          'The complete file SHA-256 does not match the declared digest',
        );
    } finally {
      await output.close();
    }
    return file;
  }

  async commit(id: string): Promise<TransferResult> {
    transferIdSchema.parse({ id });
    return this.exclusive(id, async () => {
      const row = this.row(id);
      if (row.state === 'completed') return JSON.parse(row.result!) as TransferResult;
      this.assertReceiving(row);
      const missing = this.status(id).missingChunks;
      if (missing.length)
        throw new ApiError('TRANSFER_INCOMPLETE', 'Upload all missing chunks before committing', 409, {
          missingChunks: missing,
        });
      this.store.db
        .prepare("UPDATE file_transfers SET state='committing',updated_at=?,last_error=NULL WHERE id=?")
        .run(new Date().toISOString(), id);
      try {
        const file = await this.assemble(row);
        // Importers invoke this synchronously inside the same SQLite transaction as the imported data.
        const committed = (result: TransferResult) => {
          const current = this.row(id);
          if (current.state !== 'committing')
            throw new ApiError('TRANSFER_CANCELLED', 'Transfer was cancelled before import completed', 409);
          this.store.db
            .prepare(
              "UPDATE file_transfers SET state='completed',result=?,updated_at=?,last_error=NULL WHERE id=?",
            )
            .run(JSON.stringify(result), new Date().toISOString(), id);
        };
        const result =
          row.kind === 'asset'
            ? await importAssetFile(this.store, this.config, { path: file, name: row.name }, committed)
            : await importProjectPackage(this.store, this.config, await readFile(file), committed);
        await rm(resolve(this.directory, id), { recursive: true, force: true }).catch(() => {});
        return result;
      } catch (error) {
        const current = this.row(id);
        if (current.state === 'completed') return JSON.parse(current.result!) as TransferResult;
        if (current.state === 'cancelled')
          throw new ApiError('TRANSFER_CANCELLED', 'Transfer was cancelled', 409);
        this.store.db
          .prepare("UPDATE file_transfers SET state='receiving',last_error=?,updated_at=? WHERE id=?")
          .run(JSON.stringify(errorBody(error)), new Date().toISOString(), id);
        throw error;
      } finally {
        await unlink(resolve(this.directory, id, 'assembled')).catch(() => {});
      }
    });
  }

  async cancel(id: string) {
    const row = this.row(id);
    if (row.state === 'completed') return this.snapshot(row);
    this.store.db
      .prepare("UPDATE file_transfers SET state='cancelled',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
    await rm(resolve(this.directory, id), { recursive: true, force: true });
    return this.status(id);
  }
}

const services = new WeakMap<Store, TransferService>();
export function transferService(store: Store, config: ServerConfig) {
  let service = services.get(store);
  if (!service) {
    service = new TransferService(store, config);
    services.set(store, service);
  }
  return service;
}
