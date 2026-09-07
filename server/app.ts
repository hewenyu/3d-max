import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import type { Project, RenderJob } from '../shared/types.ts';
import { getConfig, prepareDirectories, type ServerConfig } from './config.ts';
import { Store } from './store.ts';
import { RenderService } from './render.ts';
import { ApiError, errorBody, errorStatus } from './errors.ts';
import { localOnly } from './security.ts';
import { installAssetRoutes } from './assets.ts';
import { installMcpRoutes } from './mcp.ts';
import { simulateProject } from './simulation-service.ts';
import { installPackageRoutes } from './package-routes.ts';
import { inspectContinuity } from './continuity-service.ts';
import { installTemplateRoutes } from './template-routes.ts';
import { analyzeFaceAudio, faceCatalog, morphCatalog } from './face-service.ts';
import { modelCatalog } from './model-service';
import { parseScriptRequest } from './script-service.ts';
import { speechCatalog } from './speech-runtime.ts';
import { synthesizeSpeech } from './speech-service.ts';
import { ReviewService } from './review-service.ts';
import { createReviewApp, installReviewOwnerRoutes, reviewAddress } from './review-routes.ts';
import { getWorkspaceService } from './workspace-service';
import { installWorkspaceRoutes } from './workspace-routes';

export function createApp(config: ServerConfig = getConfig()) {
  prepareDirectories(config);
  const store = new Store(config.dataDir, config.token);
  const render = new RenderService(config, store);
  const reviews = new ReviewService(store, config);
  const workspaces = getWorkspaceService(store);
  const review = reviewAddress(config);
  const app = express();
  app.disable('x-powered-by');
  app.use(localOnly(config));
  app.use(express.json({ limit: '40mb' }));
  app.get('/api/health', (_request, response) =>
    response.json({ ok: true, storage: 'sqlite', projectRevision: store.project().revision }),
  );
  app.get('/api/project', (_request, response) => response.json(store.project()));
  app.get('/api/projects', (_request, response) => response.json(store.projects()));
  app.post('/api/projects/:id/open', (request, response) =>
    response.json(store.openProject(String(request.params.id))),
  );
  app.post('/api/commands', (request, response) => response.json(store.commands(request.body)));
  app.get('/api/face/catalog', async (_request, response) => response.json(await faceCatalog()));
  app.post('/api/models/catalog', async (request, response) =>
    response.json(await modelCatalog(store, request.body)),
  );
  app.post('/api/face/analyze', async (request, response) =>
    response.json(await analyzeFaceAudio(store, request.body)),
  );
  app.post('/api/face/morph-catalog', async (request, response) =>
    response.json(await morphCatalog(store, request.body)),
  );
  app.post('/api/script/parse', (request, response) => response.json(parseScriptRequest(request.body)));
  app.get('/api/speech/catalog', async (_request, response) => response.json(await speechCatalog()));
  app.post('/api/speech/synthesize', async (request, response) =>
    response.json(await synthesizeSpeech(store, config, request.body)),
  );
  app.post('/api/continuity', (request, response) => response.json(inspectContinuity(store, request.body)));
  app.post('/api/simulation/bake', async (request, response) =>
    response.json(await simulateProject(store, request.body)),
  );
  app.post('/api/project/new', (request, response) => {
    const input = z
      .object({
        name: z.string().max(200).default('Untitled project'),
        template: z.enum(['empty', 'demo']).default('empty'),
      })
      .strict()
      .parse(request.body);
    response.json(store.newProject(input.name, input.template));
  });
  app.post('/api/project/import', (request, response) => response.json(store.importProject(request.body)));
  app.get('/api/project/download', (_request, response) =>
    response
      .attachment('whiteframe-project.json')
      .type('application/json')
      .send(JSON.stringify(store.project(), null, 2)),
  );
  app.get('/api/history', (_request, response) => response.json(store.history()));
  const historyRequest = z
    .object({
      projectId: z.string().min(1).max(200).optional(),
      expectedRevision: z.number().int().min(0).optional(),
    })
    .strict();
  app.post('/api/history/undo', (request, response) =>
    response.json(store.travel(-1, historyRequest.parse(request.body || {}))),
  );
  app.post('/api/history/redo', (request, response) =>
    response.json(store.travel(1, historyRequest.parse(request.body || {}))),
  );
  app.get('/api/events', (request, response) => {
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const onProject = (project: Project) =>
      response.write(`event: project\ndata: ${JSON.stringify(project)}\n\n`);
    const onRender = (job: RenderJob) => response.write(`event: render\ndata: ${JSON.stringify(job)}\n\n`);
    onProject(store.project());
    store.on('project', onProject);
    store.on('render', onRender);
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
    request.on('close', () => {
      clearInterval(heartbeat);
      store.off('project', onProject);
      store.off('render', onRender);
    });
  });
  installAssetRoutes(app, config, store);
  installPackageRoutes(app, config, store);
  installTemplateRoutes(app, store);
  installReviewOwnerRoutes(app, reviews, review.url);
  installWorkspaceRoutes(app, workspaces);
  app.post('/api/preview', async (request, response) => response.json(await render.preview(request.body)));
  app.post('/api/viewport', async (request, response) => response.json(await render.viewport(request.body)));
  app.post('/api/constraints/inspect', async (request, response) =>
    response.json(await render.inspectConstraints(request.body)),
  );
  app.get('/api/renders', (_request, response) => response.json(store.jobs()));
  app.post('/api/renders', (request, response) => response.status(202).json(render.start(request.body)));
  app.get('/api/renders/:id', (request, response) => response.json(store.job(String(request.params.id))));
  app.post('/api/renders/:id/cancel', (request, response) =>
    response.json(render.cancel(String(request.params.id))),
  );
  app.get('/api/renders/:id/file', (request, response) => {
    const job = store.job(String(request.params.id));
    if (job.status !== 'completed')
      throw new ApiError('RENDER_NOT_READY', 'Export is not ready for download', 409);
    response
      .type('video/mp4')
      .attachment(`whiteframe-${job.id.slice(0, 8)}.mp4`)
      .sendFile(resolve(config.dataDir, 'renders', `${job.id}.mp4`), { dotfiles: 'allow' });
  });
  app.get('/api/renders/:id/stream', (request, response, next) => {
    const job = store.job(String(request.params.id));
    if (job.status !== 'completed')
      throw new ApiError('RENDER_NOT_READY', 'Export is not ready for playback', 409);
    response
      .type('video/mp4')
      .set({
        'Content-Disposition': `inline; filename="whiteframe-${job.id.slice(0, 8)}.mp4"`,
        'Cache-Control': 'private, max-age=0, must-revalidate',
      })
      .sendFile(
        resolve(config.dataDir, 'renders', `${job.id}.mp4`),
        { dotfiles: 'allow', acceptRanges: true },
        (error) => {
          if (!error) return;
          if (response.headersSent) return next(error);
          response.removeHeader('Content-Type');
          response.removeHeader('Content-Disposition');
          const fileError = error as Error & { status?: number; headers?: Record<string, string> };
          if (fileError.status === 416) {
            if (fileError.headers?.['Content-Range'])
              response.set('Content-Range', fileError.headers['Content-Range']);
            return next(
              new ApiError('RANGE_NOT_SATISFIABLE', 'Requested video range is outside the file', 416),
            );
          }
          next(error);
        },
      );
  });
  const mcp = installMcpRoutes(app, store, render, config);
  app.get('/api/connection', (_request, response) =>
    response.json({
      url: `${config.apiUrl}/mcp`,
      token: store.token,
      transport: 'streamable-http',
      command: 'npx',
      args: ['tsx', resolve('server/stdio.ts')],
      cwd: resolve('.'),
      env: { WHITEFRAME_API_URL: config.apiUrl },
      apiUrl: config.apiUrl,
      connected: Boolean(mcp.lastSeenAt && Date.now() - new Date(mcp.lastSeenAt).getTime() < 120000),
      lastSeenAt: mcp.lastSeenAt,
      requests: mcp.requests,
    }),
  );
  app.use('/api', (_request, _response, next) =>
    next(new ApiError('NOT_FOUND', 'API endpoint not found', 404)),
  );
  if (existsSync(resolve(config.distDir, 'index.html'))) {
    app.use(express.static(config.distDir));
    app.get('/{*path}', (_request, response) => response.sendFile(resolve(config.distDir, 'index.html')));
  }
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (response.headersSent) return;
    if (error instanceof ZodError)
      return response
        .status(400)
        .json(errorBody(new ApiError('VALIDATION_ERROR', 'Request data is invalid', 400, error.issues)));
    if (error?.code === 'LIMIT_FILE_SIZE')
      return response
        .status(413)
        .json(errorBody(new ApiError('ASSET_TOO_LARGE', 'Asset exceeds the 100 MiB limit', 413)));
    if (error instanceof SyntaxError && 'body' in error)
      return response
        .status(400)
        .json(errorBody(new ApiError('INVALID_JSON', 'Request body is not valid JSON')));
    response.status(errorStatus(error)).json(errorBody(error));
  };
  app.use(errors);
  return {
    app,
    store,
    render,
    reviews,
    review,
    workspaces,
    reviewApp: createReviewApp(reviews, review.url),
    async close() {
      workspaces.close();
      await render.close();
      store.close();
    },
  };
}
