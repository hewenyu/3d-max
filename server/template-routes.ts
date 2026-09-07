import type { Express } from 'express';
import type { Store } from './store';
import { deleteTemplate, getTemplate, listTemplates, saveTemplate, updateTemplate } from './template-service';

export function installTemplateRoutes(app: Express, store: Store) {
  app.get('/api/templates', (_request, response) => response.json(listTemplates(store)));
  app.post('/api/templates', (request, response) =>
    response.status(201).json(saveTemplate(store, request.body)),
  );
  app.get('/api/templates/:id', (request, response) =>
    response.json(getTemplate(store, String(request.params.id))),
  );
  app.patch('/api/templates/:id', (request, response) =>
    response.json(updateTemplate(store, { ...request.body, id: String(request.params.id) })),
  );
  app.delete('/api/templates/:id', (request, response) =>
    response.json(deleteTemplate(store, { id: String(request.params.id) })),
  );
}
