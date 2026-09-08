import type { Express } from 'express';
import type { Store } from './store';
import type { ServerConfig } from './config';
import { queryMeshSelection } from './modeling-service';
import {
  getModelingJobService,
  inspectMeshInWorker,
  planModelConversionInWorker,
  exportModelAssetInWorker,
} from './modeling-job-access';

export function installModelingRoutes(app: Express, store: Store, config: ServerConfig) {
  const jobs = getModelingJobService(store, config);
  app.post('/api/modeling/jobs', (request, response) => response.status(202).json(jobs.start(request.body)));
  app.get('/api/modeling/jobs', (request, response) =>
    response.json(
      jobs.list(typeof request.query.projectId === 'string' ? request.query.projectId : undefined),
    ),
  );
  app.get('/api/modeling/jobs/:id', (request, response) =>
    response.json(jobs.status(String(request.params.id))),
  );
  app.post('/api/modeling/jobs/:id/cancel', async (request, response) =>
    response.json(await jobs.cancel(String(request.params.id))),
  );
  app.post('/api/modeling/inspect', async (request, response) =>
    response.json(await inspectMeshInWorker(store, config, request.body)),
  );
  app.post('/api/modeling/selection', (request, response) =>
    response.json(queryMeshSelection(store, request.body)),
  );
  app.post('/api/modeling/conversion', async (request, response) =>
    response.json(await planModelConversionInWorker(store, config, request.body)),
  );
  app.post('/api/modeling/export', async (request, response) =>
    response.json(await exportModelAssetInWorker(store, config, request.body)),
  );
}
