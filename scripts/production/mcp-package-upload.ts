import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PackageImportResult } from '../../server/project-packages';
import type { ProductionMcp } from './production-mcp';

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface UploadStatus {
  id: string;
  state: string;
  chunkBytes: number;
  totalChunks: number;
  receivedBytes: number;
  missingChunks: number[];
}

export async function uploadPackage(film: ProductionMcp, bytes: Buffer, name: string) {
  const digest = sha256(bytes);
  const input = {
    kind: 'project-package',
    name,
    size: bytes.length,
    sha256: digest,
    requestId: `accepted-package-${film.theme}-${digest}`,
  };
  const status = await film.call<UploadStatus>('transfer_begin', input);
  assert.equal((await film.call<UploadStatus>('transfer_begin', input)).id, status.id);
  for (const index of [...status.missingChunks].reverse()) {
    const chunk = bytes.subarray(index * status.chunkBytes, (index + 1) * status.chunkBytes);
    const args = { id: status.id, index, dataBase64: chunk.toString('base64'), sha256: sha256(chunk) };
    const started = new Date().toISOString();
    const response = await film.client.callTool({ name: 'transfer_chunk', arguments: args }, undefined, {
      timeout: 120000,
    });
    await appendFile(
      resolve(film.directory, 'mcp-operations.jsonl'),
      `${JSON.stringify({
        started,
        completed: new Date().toISOString(),
        name: 'transfer_chunk',
        arguments: { id: status.id, index, sha256: args.sha256, encodedBytes: args.dataBase64.length },
        rawBytes: chunk.length,
        isError: Boolean(response.isError),
        responseHash: sha256(Buffer.from(JSON.stringify(response))),
      })}\n`,
    );
    assert.ok(!response.isError, `Chunk ${index}: ${JSON.stringify(response)}`);
    if (index % 32 === 0)
      console.log(JSON.stringify({ theme: film.theme, uploadIndex: index, totalChunks: status.totalChunks }));
  }
  const complete = await film.call<UploadStatus>('transfer_status', { id: status.id });
  assert.deepEqual(complete.missingChunks, []);
  assert.equal(complete.receivedBytes, bytes.length);
  const result = await film.call<PackageImportResult>('transfer_commit', { id: status.id });
  assert.deepEqual(await film.call('transfer_commit', { id: status.id }), result);
  return {
    transferId: status.id,
    packageBytes: bytes.length,
    packageSha256: digest,
    totalChunks: status.totalChunks,
    result,
  };
}
