import { useEffect, useRef } from 'react';
import {
  workspaceRequestSchema,
  workspaceStateFingerprint,
  WorkspaceFailure,
  type WorkspaceCommand,
  type WorkspaceState,
} from '../../shared/workspace';
import type { SceneEngine } from '../engine/SceneEngine';
import { settleWorkspace } from './Surfaces';

interface BridgeOptions {
  enabled: boolean;
  name: string;
  engine: () => SceneEngine | null;
  read: () => Omit<WorkspaceState, 'revision'> | null;
  apply: (command: WorkspaceCommand) => Promise<void>;
}

async function post(path: string, data: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok)
    throw new WorkspaceFailure(
      body.error?.code ?? 'WORKSPACE_HTTP_ERROR',
      body.error?.message ?? `Workspace request failed (${response.status})`,
    );
  return body;
}

export function useWorkspaceBridge(options: BridgeOptions) {
  const current = useRef(options);
  current.current = options;
  useEffect(() => {
    if (!options.enabled) return;
    let closed = false;
    let events: EventSource | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let credentials: { id: string; token: string } | undefined;
    let fingerprint = '';
    let revision = 0;
    let sequence = Promise.resolve();
    let busy = false;
    let reconnecting = false;
    const state = (): WorkspaceState => {
      const value = current.current.read();
      if (!value) throw new WorkspaceFailure('WORKSPACE_NOT_READY', 'Project and viewport are not ready');
      const next = workspaceStateFingerprint(value);
      if (next !== fingerprint) {
        fingerprint = next;
        revision++;
      }
      return { ...value, revision };
    };
    const publish = async () => {
      if (!credentials || closed || busy) return;
      await post(`/api/workspaces/${credentials.id}/state`, { token: credentials.token, state: state() });
    };
    const connect = async () => {
      if (closed || reconnecting) return;
      reconnecting = true;
      try {
        const initial = state();
        credentials = await post('/api/workspaces', { name: current.current.name, state: initial });
        if (closed || !credentials) return;
        const { id, token } = credentials;
        events = new EventSource(
          `/api/workspaces/${encodeURIComponent(id)}/events?token=${encodeURIComponent(token)}`,
        );
        events.addEventListener('workspace_request', (event) => {
          const input: unknown = JSON.parse((event as MessageEvent).data);
          sequence = sequence
            .then(async () => {
              if (closed) return;
              busy = true;
              const parsed = workspaceRequestSchema.safeParse(input);
              const requestId = parsed.success ? parsed.data.id : (input as { id?: string }).id;
              try {
                if (!parsed.success)
                  throw new WorkspaceFailure('INVALID_WORKSPACE_REQUEST', parsed.error.message);
                const request = parsed.data;
                const before = state();
                if (before.projectId !== request.projectId)
                  throw new WorkspaceFailure('PROJECT_CONFLICT', 'The browser project changed', {
                    state: before,
                  });
                if (before.projectRevision !== request.expectedRevision)
                  throw new WorkspaceFailure('REVISION_CONFLICT', 'The browser project revision changed', {
                    state: before,
                  });
                if (
                  request.expectedWorkspaceRevision !== undefined &&
                  before.revision !== request.expectedWorkspaceRevision
                )
                  throw new WorkspaceFailure('WORKSPACE_CONFLICT', 'The browser workspace changed', {
                    state: before,
                  });
                if (before.viewport.loading)
                  throw new WorkspaceFailure('WORKSPACE_NOT_READY', 'The viewport is loading');
                if (request.operation === 'apply') {
                  if (!request.command)
                    throw new WorkspaceFailure('INVALID_WORKSPACE_REQUEST', 'apply requires a command');
                  await current.current.apply(request.command);
                }
                await settleWorkspace();
                const engine = current.current.engine();
                if (!engine) throw new WorkspaceFailure('WORKSPACE_NOT_READY', 'The viewport is unavailable');
                await engine.ready;
                const after = state();
                if (
                  after.projectId !== request.projectId ||
                  after.projectRevision !== request.expectedRevision
                )
                  throw new WorkspaceFailure(
                    'REVISION_CONFLICT',
                    'Project changed during the workspace request',
                    { state: after },
                  );
                let result: unknown = after;
                if (request.operation === 'capture')
                  result = {
                    state: after,
                    dataUrl: engine.captureViewport(request.options?.overlays ?? false),
                  };
                if (request.operation === 'inspect')
                  result = { state: after, ...engine.inspectViewport(request.options?.objectIds) };
                await post(`/api/workspaces/${id}/results`, { token, requestId, result });
              } catch (cause) {
                const error =
                  cause instanceof WorkspaceFailure
                    ? { code: cause.code, message: cause.message, details: cause.details }
                    : {
                        code: 'WORKSPACE_FAILED',
                        message: cause instanceof Error ? cause.message : String(cause),
                      };
                await post(`/api/workspaces/${id}/results`, { token, requestId, error }).catch(
                  () => undefined,
                );
              } finally {
                busy = false;
              }
            })
            .catch(() => undefined);
        });
        timer = setInterval(
          () =>
            void publish().catch((cause) => {
              if (
                cause instanceof WorkspaceFailure &&
                ['WORKSPACE_NOT_FOUND', 'UNAUTHORIZED'].includes(cause.code)
              ) {
                events?.close();
                if (timer) clearInterval(timer);
                credentials = undefined;
                void connect();
              }
            }),
          1000,
        );
      } catch {
        if (!closed) setTimeout(() => void connect(), 1500);
      } finally {
        reconnecting = false;
      }
    };
    void connect();
    return () => {
      closed = true;
      events?.close();
      if (timer) clearInterval(timer);
    };
  }, [options.enabled]);
}
