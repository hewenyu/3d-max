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

export function createApp(config: ServerConfig = getConfig()) {
  prepareDirectories(config);
  const store = new Store(config.dataDir, config.token);
  const render = new RenderService(config, store);
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
  app.post('/api/preview', async (request, response) => response.json(await render.preview(request.body)));
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
    async close() {
      await render.close();
      store.close();
    },
  };
}
