import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { meshInspectSchema, meshSelectionQuerySchema } from '../shared/topology-schema';
import { queryMeshSelection } from './modeling-service';
import { modelConversionRequestSchema, modelExportRequestSchema } from './modeling-assets';
import type { Store } from './store';
import type { ServerConfig } from './config';
import { errorBody } from './errors';
import { z } from 'zod';
import {
  modelingCommandJobRequestSchema,
  modelingInspectJobRequestSchema,
  modelConversionJobRequestSchema,
  modelExportJobRequestSchema,
} from '../shared/modeling-jobs';
import {
  getModelingJobService,
  inspectMeshInWorker,
  planModelConversionInWorker,
  exportModelAssetInWorker,
} from './modeling-job-access';

async function result(run: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await run()) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorBody(error)) }] };
  }
}

export function registerModelingTools(server: McpServer, store: Store, config: ServerConfig) {
  const jobs = getModelingJobService(store, config);
  server.registerTool(
    'model_conversion_start',
    {
      description:
        'Prepare a static GLB/glTF conversion plan in an isolated CPU worker. Returns a persisted cancellable job with reading and geometry progress. Apply the completed plan through mesh_set using its captured revision and context.',
      inputSchema: modelConversionJobRequestSchema.shape,
    },
    (input) => result(() => jobs.start(input)),
  );
  server.registerTool(
    'model_export_start',
    {
      description:
        'Export evaluated selection or scene geometry as an actual GLB in an isolated CPU worker. Returns a persisted cancellable job with per-object geometry, encoding and storage progress. Query modeling_job_status for the downloadable asset; publication checks project revision and context again.',
      inputSchema: modelExportJobRequestSchema.shape,
    },
    (input) => result(() => jobs.start(input)),
  );
  server.registerTool(
    'modeling_job_start',
    {
      description:
        'Run an atomic batch of shared editing commands in an isolated CPU worker. SQLite retains the immutable snapshot, real command progress and result. Returns immediately; query modeling_job_status or cancel. Strict project/revision/context guards are checked again at commit; concurrent edits reject stale results. Retrying the same requestId replays the job.',
      inputSchema: modelingCommandJobRequestSchema.shape,
    },
    (input) => result(() => jobs.start(input)),
  );
  server.registerTool(
    'modeling_inspect_start',
    {
      description:
        'Inspect source or evaluated mesh geometry in an isolated cancellable worker. Reports stable component IDs, paginated positions, topology diagnostics and bounds against the captured revision; does not edit the project. Returns a job ID for modeling_job_status.',
      inputSchema: modelingInspectJobRequestSchema.shape,
    },
    (input) => result(() => jobs.start(input)),
  );
  server.registerTool(
    'modeling_job_status',
    {
      description: 'Read a persisted modeling job, real progress, structured failure or completed result.',
      inputSchema: { id: z.string().min(1).max(200) },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => result(() => jobs.status(id)),
  );
  server.registerTool(
    'modeling_job_list',
    {
      description: 'List persisted modeling jobs, optionally for one project.',
      inputSchema: { projectId: z.string().min(1).max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ projectId }) => result(() => jobs.list(projectId)),
  );
  server.registerTool(
    'modeling_job_cancel',
    {
      description:
        'Cancel queued or active geometry work. Running CPU calculation is terminated; no partial project edit is committed.',
      inputSchema: { id: z.string().min(1).max(200) },
    },
    ({ id }) => result(() => jobs.cancel(id)),
  );
  server.registerTool(
    'mesh_inspect',
    {
      description:
        'Inspect source mesh or evaluated geometry with stable IDs, local-meter positions, polygon normals, adjacency, dimensions and topology diagnostics. Paginates components; source IDs are editable, evaluated IDs are inspection-only. Requires project/revision/context guards. Read-only and works without a browser.',
      inputSchema: meshInspectSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (input) => result(() => inspectMeshInWorker(store, config, input)),
  );
  server.registerTool(
    'mesh_selection_query',
    {
      description:
        'Resolve, invert, grow, shrink, connect, loop or ring-select stable source mesh components without a browser. Returns IDs/indices and traversal stopping reasons. Read-only; supply the resulting selection to topology_* commands or workspace_apply components to update an open editor.',
      inputSchema: meshSelectionQuerySchema.shape,
      annotations: { readOnlyHint: true },
    },
    (input) => result(() => queryMeshSelection(store, input)),
  );
  server.registerTool(
    'model_conversion_plan',
    {
      description:
        'Convert a compatible static GLB/glTF into a reviewable editable mesh plan without changing the object or original asset. Reports omitted attributes and unsupported animation/rig features. Apply the returned mesh through mesh_set with the returned project/revision/context guards.',
      inputSchema: modelConversionRequestSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (input) => result(() => planModelConversionInWorker(store, config, input)),
  );
  server.registerTool(
    'model_export',
    {
      description:
        'Export actual evaluated white-model geometry as a downloadable GLB asset for selected objects (including descendants) or the active scene at explicit source time. Includes transforms and modifiers; unsupported rigs or dynamic assets fail with diagnostics. Returns a local asset URL and geometry/file statistics.',
      inputSchema: modelExportRequestSchema.shape,
    },
    (input) => result(() => exportModelAssetInWorker(store, config, input)),
  );
}
