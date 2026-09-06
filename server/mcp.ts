import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Express } from 'express';
import { z } from 'zod';
import { commandDefinitions } from '../shared/commands.ts';
import { sampleObject, sampleTimeline } from '../shared/timeline.ts';
import type { Command } from '../shared/types.ts';
import type { ServerConfig } from './config.ts';
import { errorBody } from './errors.ts';
import { bearerAuth } from './security.ts';
import type { Store } from './store.ts';
import { previewSchema, type RenderService } from './render.ts';

const revisionFields = {
  projectId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Expected active project ID; prevents editing a different project after another client switches projects.',
    ),
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Expected current project revision; mismatches fail atomically.'),
  requestId: z.string().min(1).max(200).optional().describe('Stable request ID used for safe retries.'),
};
const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const guard = (run: () => unknown | Promise<unknown>) => async (): Promise<CallToolResult> => {
  try {
    return json(await run());
  } catch (error) {
    return { ...json(errorBody(error)), isError: true };
  }
};

export function createMcpServer(store: Store, render: RenderService, config: ServerConfig) {
  const server = new McpServer(
    { name: 'whiteframe-studio', version: '0.1.0' },
    {
      instructions:
        'Editable local 3D white-model director previsualization. Read project_get first. All distances are meters, rotations are degrees, Y is up, actors face +Z. Commands are atomic and shared with the browser editor. Read project ID and revision and use projectId/expectedRevision/requestId. Respect locked objects. Render jobs bind immutable project snapshots. Asset URLs must refer to uploads in this server.',
    },
  );
  server.registerTool(
    'project_get',
    {
      description:
        'Read the complete current project, current revision, source animation, editable cameras, shot sequence, audio and director intent.',
      inputSchema: {},
    },
    guard(() => store.project()),
  );
  server.registerTool(
    'project_list',
    { description: 'List projects saved in the local SQLite database.', inputSchema: {} },
    guard(() => store.projects()),
  );
  server.registerTool(
    'project_open',
    {
      description:
        'Activate a previously saved project by ID. The browser receives the same project through SSE.',
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) => guard(() => store.openProject(id))(),
  );
  server.registerTool(
    'project_new',
    {
      description: 'Create and activate a new project. Existing projects remain saved in SQLite.',
      inputSchema: {
        name: z.string().max(200).default('Untitled project'),
        template: z.enum(['empty', 'demo']).default('empty'),
      },
    },
    ({ name, template }) => guard(() => store.newProject(name, template))(),
  );
  server.registerTool(
    'project_import',
    {
      description:
        'Import a project JSON object as a new project. Referenced assets must already be uploaded locally.',
      inputSchema: { project: z.record(z.unknown()) },
    },
    ({ project }) => guard(() => store.importProject(project))(),
  );
  server.registerTool(
    'capabilities_list',
    {
      description:
        'List supported editing commands and render limits. Use tools/list for the complete argument schemas.',
      inputSchema: {},
    },
    guard(() => ({
      commands: commandDefinitions.map(({ type, description }) => ({ type, description })),
      units: { distance: 'meters', angle: 'degrees', time: 'seconds', up: 'Y' },
      export: {
        format: 'MP4 / H.264',
        resolutions: [720, 1080],
        fps: [1, 60],
        maxFrames: 18000,
        assets: 'GLB/glTF and reference audio',
      },
    })),
  );
  for (const definition of commandDefinitions) {
    server.registerTool(
      definition.type.replaceAll('.', '_'),
      { description: definition.description, inputSchema: definition.schema.extend(revisionFields).shape },
      (args) =>
        guard(() => {
          const { expectedRevision, requestId, projectId, ...payload } = args as Record<string, unknown>;
          return store.commands({
            commands: [{ type: definition.type, payload }],
            expectedRevision: expectedRevision as number | undefined,
            requestId: requestId as string | undefined,
            projectId: projectId as string | undefined,
          });
        })(),
    );
  }
  server.registerTool(
    'edit_batch',
    {
      description:
        'Apply up to 200 ordered edits as one SQLite transaction and one undo step. Any failure rolls back all edits.',
      inputSchema: {
        commands: z
          .array(z.object({ type: z.string(), payload: z.record(z.unknown()) }))
          .min(1)
          .max(200),
        ...revisionFields,
      },
    },
    (args) =>
      guard(() =>
        store.commands(args as { commands: Command[]; expectedRevision?: number; requestId?: string }),
      )(),
  );
  server.registerTool(
    'history_undo',
    {
      description: 'Undo the most recent atomic edit. Revision remains monotonic.',
      inputSchema: { projectId: revisionFields.projectId, expectedRevision: revisionFields.expectedRevision },
    },
    (args) => guard(() => store.travel(-1, args))(),
  );
  server.registerTool(
    'history_redo',
    {
      description: 'Restore the next undone edit.',
      inputSchema: { projectId: revisionFields.projectId, expectedRevision: revisionFields.expectedRevision },
    },
    (args) => guard(() => store.travel(1, args))(),
  );
  server.registerTool(
    'scene_inspect',
    {
      description:
        'Inspect source-time object transforms and the camera selected by a sequence time. Object transforms are local to parents or attachments.',
      inputSchema: {
        time: z.number().min(0).default(0),
        sequenceId: z.string().optional(),
        sourceTime: z.number().min(0).optional(),
      },
    },
    (args) =>
      guard(() => {
        const project = store.project();
        const timeline = sampleTimeline(project, args.time, args.sequenceId);
        const sourceTime = args.sourceTime ?? timeline.sourceTime;
        return {
          revision: project.revision,
          timeline,
          sourceTime,
          objects: project.objects.map((object) => sampleObject(object, sourceTime)),
          beats: project.beats,
          notes: project.notes,
          settings: project.settings,
        };
      })(),
  );
  server.registerTool(
    'preview_capture',
    {
      description:
        'Render an actual PNG of a selected shot or sequence at a time in seconds. Shot time is relative to shot sourceIn. Returns image content for visual inspection.',
      inputSchema: previewSchema.shape,
    },
    async (args) => {
      try {
        const { dataUrl } = await render.preview(args);
        return {
          content: [
            { type: 'image', mimeType: 'image/png', data: dataUrl.slice('data:image/png;base64,'.length) },
          ],
        };
      } catch (error) {
        return { ...json(errorBody(error)), isError: true };
      }
    },
  );
  server.registerTool(
    'render_start',
    {
      description:
        'Queue deterministic MP4 export bound to the current project revision. A stable requestId prevents duplicate exports. Single-shot export includes source-synchronized audio; sequence-synchronized audio requires a sequence export.',
      inputSchema: {
        sequenceId: z.string().optional(),
        shotId: z.string().optional(),
        fps: z.number().int().min(1).max(60).optional(),
        resolution: z.union([z.literal(720), z.literal(1080)]).optional(),
        aspect: z.enum(['16:9', '9:16', '1:1']).optional(),
        includeAudio: z.boolean().optional(),
        burnIn: z.boolean().optional(),
        requestId: z.string().min(1).max(200).optional(),
        projectId: revisionFields.projectId,
        expectedRevision: revisionFields.expectedRevision,
      },
    },
    (args) => guard(() => render.start(args))(),
  );
  server.registerTool(
    'render_status',
    {
      description:
        'Read an export task or list recent tasks. Completed tasks include a downloadable local URL.',
      inputSchema: { id: z.string().optional() },
    },
    ({ id }) =>
      guard(() => {
        const absolute = <T extends { url?: string }>(job: T) => ({
          ...job,
          ...(job.url ? { downloadUrl: new URL(job.url, config.apiUrl).href } : {}),
        });
        return id ? absolute(store.job(id)) : store.jobs().map(absolute);
      })(),
  );
  server.registerTool(
    'render_cancel',
    {
      description: 'Cancel a queued or running export. Completed exports remain unchanged.',
      inputSchema: { id: z.string() },
    },
    ({ id }) => guard(() => render.cancel(id))(),
  );
  server.registerTool(
    'asset_import',
    {
      description:
        'Upload a GLB/glTF or audio asset from base64 file content. External filesystem paths and remote URLs are not accepted. Maximum encoded content is 32 MiB.',
      inputSchema: {
        name: z.string().min(1).max(200),
        dataBase64: z
          .string()
          .min(1)
          .max(32 * 1024 * 1024),
      },
    },
    ({ name, dataBase64 }) =>
      guard(async () => {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) throw new Error('Invalid base64 asset content');
        const form = new FormData();
        form.set('file', new Blob([new Uint8Array(Buffer.from(dataBase64, 'base64'))]), name);
        const response = await fetch(new URL('/api/assets', config.apiUrl), { method: 'POST', body: form });
        const result = await response.json();
        if (!response.ok) return Promise.reject(result.error);
        return result;
      })(),
  );
  return server;
}

export function installMcpRoutes(app: Express, store: Store, render: RenderService, config: ServerConfig) {
  const state = { lastSeenAt: null as string | null, requests: 0 };
  app.all('/mcp', bearerAuth(store.token), async (request, response) => {
    state.lastSeenAt = new Date().toISOString();
    state.requests++;
    const server = createMcpServer(store, render, config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });
  return state;
}
