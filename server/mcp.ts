import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Express } from 'express';
import { z } from 'zod';
import { commandDefinitions } from '../shared/commands.ts';
import { sampleObject, sampleTimeline } from '../shared/timeline.ts';
import { affectedShots, comparePerformances, resolveShotProject } from '../shared/production.ts';
import type { Command } from '../shared/types.ts';
import type { ServerConfig } from './config.ts';
import { errorBody } from './errors.ts';
import { bearerAuth } from './security.ts';
import type { Store } from './store.ts';
import { previewSchema, type RenderService } from './render.ts';
import { simulationRequestSchema, simulateProject } from './simulation-service.ts';
import { actorActionCatalog, actorJointNames } from '../shared/actor-animation.ts';
import { analyzeFaceAudio, faceCatalog, morphCatalog } from './face-service.ts';
import { faceAnalysisRequestSchema, morphCatalogRequestSchema } from '../shared/face-analysis.ts';
import { modelCatalogRequestSchema } from '../shared/model-catalog';
import { modelCatalog } from './model-service';
import { packageExportSchema, saveProjectPackage } from './package-routes.ts';
import { importProjectPackage } from './project-packages.ts';
import { continuityRequestSchema, inspectContinuity } from './continuity-service.ts';
import { parseScriptRequest } from './script-service.ts';
import { scriptParseSchema } from '../shared/script-schema.ts';
import { speechRequestSchema } from '../shared/speech.ts';
import { speechCatalog } from './speech-runtime.ts';
import { synthesizeSpeech } from './speech-service.ts';
import { ReviewService } from './review-service.ts';
import { reviewAddress } from './review-routes.ts';
import { registerReviewOwnerTools } from './review-mcp.ts';
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
  updateTemplate,
  templateSaveSchema,
  templateUpdateSchema,
  templateIdSchema,
} from './template-service.ts';

const revisionFields = {
  expectedContext: z
    .object({
      sceneId: z.string().min(1).max(160).nullable(),
      performanceId: z.string().min(1).max(160).nullable(),
    })
    .strict()
    .optional()
    .describe(
      'Expected active scene and performance IDs, or null for a legacy project. Prevents applying an edit to another active scene/take.',
    ),
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
    'speech_catalog',
    {
      description:
        'Discover installed local text-to-speech engines, exact voice identifiers, languages, rate limits and dependency diagnostics. macOS Say and eSpeak NG produce temporary dialogue audio.',
      inputSchema: {},
    },
    guard(() => speechCatalog()),
  );
  server.registerTool(
    'speech_synthesize',
    {
      description:
        'Synthesize plain dialogue into a real local WAV asset and atomically arrange a source-time audio clip and a new or selected dialogue beat linked by a synchronization group. Uses installed voices from speech_catalog. Rate is engine words/minute (80..350); actual duration comes from decoded audio. Requires projectId/expectedRevision/requestId; retries replay the original result. Existing audio stays as editable alternate takes. The returned audioId can drive actor_face_lipsync_analyze, playback and MP4 export.',
      inputSchema: speechRequestSchema.shape,
    },
    (args) => guard(() => synthesizeSpeech(store, config, args))(),
  );
  server.registerTool(
    'script_parse',
    {
      description:
        'Parse Fountain 1.1 or structured JSON into a reviewable scene/cast/action/dialogue/timing breakdown with diagnostics. Read-only. Chinese Fountain character cues use @; force scene headings with a leading dot. Does not infer natural-language blocking or choreography. Adjust the breakdown and call script_apply, optionally selecting scene IDs.',
      inputSchema: scriptParseSchema.shape,
    },
    (args) => guard(() => parseScriptRequest(args))(),
  );
  server.registerTool(
    'actor_face_catalog',
    {
      description:
        'Read normalized expression channels, presets, Rhubarb mouth shapes and availability/compatibility of the local phonetic recognizer.',
      inputSchema: {},
    },
    guard(() => faceCatalog()),
  );
  server.registerTool(
    'actor_face_lipsync_analyze',
    {
      description:
        'Analyze uploaded source-time dialogue with real Rhubarb phonetic recognition. Returns editable mouth cues and commands without changing the project. Apply returned commands with edit_batch using the returned projectId, revision and context. phonetic supports non-English speech with manual review; pocketsphinx is English-only.',
      inputSchema: faceAnalysisRequestSchema.shape,
    },
    (args) => guard(() => analyzeFaceAudio(store, args))(),
  );
  server.registerTool(
    'model_morph_catalog',
    {
      description:
        'Read imported glTF morph target names and missing configured bindings. Use model_morph_bindings_set and actor_face_* tools to animate the mapped face.',
      inputSchema: morphCatalogRequestSchema.shape,
    },
    (args) => guard(() => morphCatalog(store, args))(),
  );
  server.registerTool(
    'model_catalog',
    {
      description:
        'Inspect an imported glTF model: node hierarchy, skeleton joint directory, embedded animation indexes, duration and target channels. Reports native rig compatibility; automatic retargeting to built-in actors is unavailable. Select with model_animation_set.',
      inputSchema: modelCatalogRequestSchema.shape,
    },
    (args) => guard(() => modelCatalog(store, args))(),
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
    'template_list',
    {
      description: 'List reusable object assemblies and scene templates saved in SQLite across all projects.',
      inputSchema: {},
    },
    guard(() => listTemplates(store)),
  );
  server.registerTool(
    'template_get',
    {
      description:
        'Read editable template content and metadata. Pass content to template_instantiate to create an independent copy in the active project.',
      inputSchema: templateIdSchema.shape,
    },
    ({ id }) => guard(() => getTemplate(store, id))(),
  );
  server.registerTool(
    'template_save',
    {
      description:
        'Save the current scene/take including shots, cuts and synchronization, or selected objects with their hierarchy and constraint dependencies, as an immutable reusable template. Original content is preserved; project ID and revision prevent stale captures.',
      inputSchema: templateSaveSchema.shape,
    },
    (args) => guard(() => saveTemplate(store, args))(),
  );
  server.registerTool(
    'template_update',
    {
      description: 'Rename a reusable template and edit its description with a revision guard.',
      inputSchema: templateUpdateSchema.shape,
    },
    (args) => guard(() => updateTemplate(store, args))(),
  );
  server.registerTool(
    'template_delete',
    {
      description:
        'Remove a saved library template. Previously instantiated objects and scenes stay independently editable.',
      inputSchema: templateIdSchema.shape,
    },
    (args) => guard(() => deleteTemplate(store, args))(),
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
    'project_package_export',
    {
      description:
        'Create an immutable portable .whiteframe project package with all referenced assets, independent takes, undo history and optionally completed videos. Returns a downloadable URL; restore it in a clean installation with project_package_import or the browser.',
      inputSchema: packageExportSchema.shape,
    },
    (args) =>
      guard(async () => {
        const result = await saveProjectPackage(store, config, args);
        return { ...result, downloadUrl: new URL(result.url, config.apiUrl).href };
      })(),
  );
  server.registerTool(
    'project_package_import',
    {
      description:
        'Restore a portable Whiteframe project package as a new editable project, including assets, undo history and included videos. Provide base64 package bytes (up to 32 MiB encoded); larger packages use browser upload. Existing projects are preserved.',
      inputSchema: {
        dataBase64: z
          .string()
          .min(1)
          .max(32 * 1024 * 1024),
      },
    },
    (args) => guard(() => importProjectPackage(store, config, Buffer.from(args.dataBase64, 'base64')))(),
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
      actors: {
        actions: actorActionCatalog,
        joints: actorJointNames,
        constraints: ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'],
      },
      simulation: { engine: 'Rapier', fixedStep: true, editableBake: true, maxDuration: 600, maxBodies: 64 },
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
          const { expectedRevision, requestId, projectId, expectedContext, ...payload } = args as Record<
            string,
            unknown
          >;
          return store.commands({
            commands: [{ type: definition.type, payload }],
            expectedRevision: expectedRevision as number | undefined,
            requestId: requestId as string | undefined,
            projectId: projectId as string | undefined,
            expectedContext: expectedContext as
              { sceneId: string | null; performanceId: string | null } | undefined,
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
    'production_inspect',
    {
      description:
        'Read scene/performance libraries, affected shots, story scenes and optional differences between independent takes. Does not mutate the project.',
      inputSchema: {
        sceneId: z.string().optional(),
        leftPerformanceId: z.string().optional(),
        rightPerformanceId: z.string().optional(),
      },
    },
    (args) =>
      guard(() => {
        const project = store.project();
        const state = project.production;
        return {
          projectId: project.id,
          revision: project.revision,
          activeSceneId: state?.activeSceneId ?? null,
          activePerformanceId: state?.activePerformanceId ?? null,
          scenes:
            state?.scenes.map((scene) => ({
              id: scene.id,
              name: scene.name,
              locked: scene.locked,
              objectCount: scene.objects.length,
              affectedShotIds: affectedShots(project, scene.id).map((shot) => shot.id),
              performances: scene.performances.map((take) => ({
                id: take.id,
                name: take.name,
                locked: take.locked,
                affectedShotIds: affectedShots(project, scene.id, take.id).map((shot) => shot.id),
              })),
            })) ?? [],
          storyScenes: state?.storyScenes ?? [],
          comparison:
            state && args.leftPerformanceId && args.rightPerformanceId
              ? comparePerformances(
                  project,
                  args.sceneId ?? state.activeSceneId,
                  args.leftPerformanceId,
                  args.rightPerformanceId,
                )
              : null,
        };
      })(),
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
        sceneId: z.string().optional(),
        performanceId: z.string().optional(),
      },
    },
    (args) =>
      guard(() => {
        const project = store.project();
        const timeline = sampleTimeline(project, args.time, args.sequenceId);
        const sourceTime = args.sourceTime ?? timeline.sourceTime;
        const scene = resolveShotProject(
          project,
          args.sceneId
            ? { ...timeline.shot!, sceneId: args.sceneId, performanceId: args.performanceId }
            : timeline.shot,
        );
        return {
          revision: project.revision,
          timeline,
          sourceTime,
          objects: scene.objects.map((object) => sampleObject(object, sourceTime)),
          beats: scene.beats,
          notes: project.notes,
          settings: scene.settings,
        };
      })(),
  );
  server.registerTool(
    'continuity_analyze',
    {
      description:
        'Analyze an editable sequence using sampled scene geometry, actors and cameras. Returns time-indexed evidence for axis crossings, screen direction, eyelines, action and prop continuity, collisions, framing, occlusion and contact errors. Use continuity_ignore with an explicit reason for intentional exceptions. Analysis does not modify the project.',
      inputSchema: continuityRequestSchema.shape,
    },
    (args) => guard(() => inspectContinuity(store, args))(),
  );
  server.registerTool(
    'simulation_bake',
    {
      description:
        'Bake fixed-step Rapier physics into editable source-time object keyframes and collision events. Runs from an immutable project snapshot; concurrent edits reject the result atomically. Stable requestId replays the original result across restarts. Configure bodies with physics_body_set first.',
      inputSchema: simulationRequestSchema.shape,
    },
    (args) => guard(() => simulateProject(store, args))(),
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
        'Read an export task or list recent tasks. Completed tasks include downloadable and inline-playable local URLs.',
      inputSchema: { id: z.string().optional() },
    },
    ({ id }) =>
      guard(() => {
        const absolute = <T extends { id: string; url?: string }>(job: T) => ({
          ...job,
          ...(job.url
            ? {
                downloadUrl: new URL(job.url, config.apiUrl).href,
                playbackUrl: new URL(`/api/renders/${job.id}/stream`, config.apiUrl).href,
              }
            : {}),
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
  registerReviewOwnerTools(server, new ReviewService(store, config), reviewAddress(config).url);
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
