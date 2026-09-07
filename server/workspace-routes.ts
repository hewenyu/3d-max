import type { Express } from 'express';
import { z } from 'zod';
import { workspaceStateSchema } from '../shared/workspace';
import type { WorkspaceService } from './workspace-service';

const token = z.string().min(1).max(200);
const stateReport = z.object({ token, state: workspaceStateSchema }).strict();
const acknowledgement = z
  .object({
    token,
    requestId: z.string().min(1).max(200),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.string().min(1), message: z.string(), details: z.unknown().optional() })
      .strict()
      .optional(),
  })
  .strict();

export function installWorkspaceRoutes(app: Express, workspaces: WorkspaceService) {
  app.post('/api/workspaces', (request, response) =>
    response.status(201).json(workspaces.register(request.body)),
  );
  app.post('/api/workspaces/:id/state', (request, response) => {
    const body = stateReport.parse(request.body);
    response.json(workspaces.report(String(request.params.id), body.token, body.state));
  });
  app.post('/api/workspaces/:id/results', (request, response) => {
    const body = acknowledgement.parse(request.body);
    response.json(
      workspaces.acknowledge(String(request.params.id), body.token, body.requestId, body.result, body.error),
    );
  });
  app.get('/api/workspaces/:id/events', (request, response) => {
    const id = String(request.params.id);
    const credential = token.parse(request.query.token);
    workspaces.authenticate(id, credential);
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const disconnect = workspaces.connect(
      id,
      credential,
      (message) => {
        response.write(`event: workspace_request\ndata: ${JSON.stringify(message)}\n\n`);
      },
      () => response.end(),
    );
    response.write(': connected\n\n');
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 5000);
    request.on('close', () => {
      clearInterval(heartbeat);
      disconnect();
    });
  });
}
