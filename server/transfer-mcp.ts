import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Store } from './store';
import type { ServerConfig } from './config';
import { errorBody } from './errors';
import { transferService } from './transfers';
import {
  transferBeginSchema,
  transferChunkSchema,
  transferIdSchema,
  transferStatusSchema,
  transferLimits,
} from './transfer-schema';

async function result(run: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await run()) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorBody(error)) }] };
  }
}

export function registerTransferTools(server: McpServer, store: Store, config: ServerConfig) {
  const service = transferService(store, config);
  server.registerTool(
    'transfer_begin',
    {
      description: `Begin or resume an idempotent chunked asset or project-package upload. Declare the exact raw byte size and complete lowercase SHA-256 digest. Assets accept the same 100 MiB and formats as browser upload; packages accept 512 MiB. Returned chunkBytes is ${transferLimits.chunkBytes}; upload zero-based chunks in any order. A stable requestId returns the same transfer. No HTTP upload or local server path is required. At most eight unfinished transfers may reserve 2 GiB total; cancel abandoned uploads to free the reservation.`,
      inputSchema: transferBeginSchema.shape,
    },
    (args) => result(() => service.begin(args)),
  );
  server.registerTool(
    'transfer_chunk',
    {
      description:
        'Upload one canonical padded base64 chunk with its own SHA-256. Use the exact chunkBytes size except for the final remainder. Identical retries are idempotent. To deliberately replace a different accepted chunk, provide its current digest as replaceSha256; status lists the digests. Chunk data and received progress survive server restarts.',
      inputSchema: transferChunkSchema.shape,
    },
    (args) => result(() => service.chunk(args)),
  );
  server.registerTool(
    'transfer_status',
    {
      description:
        'Read persisted upload progress, accepted chunk digests, missing indexes, errors and final import result. Without id, list unfinished transfers first and up to 100 recent transfers, omitting large final results. A restart returns interrupted commits to receiving so commit can be retried.',
      inputSchema: transferStatusSchema.shape,
    },
    ({ id }) => result(() => (id ? service.status(id) : service.list())),
  );
  server.registerTool(
    'transfer_commit',
    {
      description:
        'Assemble uploaded chunks, verify the complete SHA-256 and import using the same model/audio/package validation as the browser. Asset import returns the local asset id/name/url; package import returns a newly activated editable project with restored assets/history/videos. Import and the saved result commit in one SQLite transaction. Repeating commit, including after disconnect or restart, returns the original result without duplicate imports or reopening another current project. Validation errors retain uploaded chunks for correction and retry.',
      inputSchema: transferIdSchema.shape,
    },
    ({ id }) => result(() => service.commit(id)),
  );
  server.registerTool(
    'transfer_cancel',
    {
      description:
        'Cancel a receiving or in-progress upload and remove its staged files. Cancellation before the import transaction prevents publication of assets/projects. Repeated cancellation is safe. An already completed transfer returns its completed status and never deletes imported content.',
      inputSchema: transferIdSchema.shape,
    },
    ({ id }) => result(() => service.cancel(id)),
  );
}
