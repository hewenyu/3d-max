import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  workspaceRequestSchema,
  workspaceStateSchema,
  workspaceStateFingerprint,
  type WorkspaceError,
  type WorkspaceRequest,
  type WorkspaceState,
} from '../shared/workspace';
import { viewportInspectionSchema } from '../shared/viewport';
import { ApiError, errorBody } from './errors';
import type { Store } from './store';

interface Outcome {
  fingerprint: string;
  promise: Promise<unknown>;
  finish: (result?: unknown, error?: WorkspaceError) => void;
  pending: boolean;
  retained: boolean;
  bytes: number;
}
interface Session {
  id: string;
  name: string;
  token: string;
  state: WorkspaceState;
  lastSeenAt: number;
  send?: (request: WorkspaceRequest) => void;
  disconnect?: () => void;
  requests: Map<string, Outcome>;
}
const registrationSchema = z
  .object({
    id: z.string().max(200).optional(),
    name: z.string().min(1).max(200),
    state: workspaceStateSchema,
  })
  .strict();
const failure = (code: string, message: string, details?: unknown): WorkspaceError => ({
  code,
  message,
  ...(details === undefined ? {} : { details }),
});
const inspectionResultSchema = viewportInspectionSchema.extend({ state: workspaceStateSchema });
const captureResultSchema = z.object({ state: workspaceStateSchema, dataUrl: z.string() }).strict();
function payloadBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null');
  } catch {
    return Infinity;
  }
}
function assertStateSize(state: WorkspaceState) {
  if (payloadBytes(state) > 4 * 1024 * 1024)
    throw new ApiError('WORKSPACE_STATE_TOO_LARGE', 'Workspace state exceeds 4 MiB', 413);
}

// These sessions contain transient browser state only. Project edits remain in Store/SQLite.
export class WorkspaceService {
  private sessions = new Map<string, Session>();
  private retainedBytes = 0;
  constructor(
    private store: Store,
    private timeoutMs = 15000,
    private staleMs = 15000,
    private maxRetainedBytes = 32 * 1024 * 1024,
  ) {}

  register(input: unknown) {
    const value = registrationSchema.parse(input);
    assertStateSize(value.state);
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.send && now - session.lastSeenAt > 30 * 60000) {
        for (const outcome of session.requests.values()) this.retainedBytes -= outcome.bytes;
        this.sessions.delete(session.id);
      }
    }
    if (this.sessions.size >= 128)
      throw new ApiError(
        'WORKSPACE_LIMIT',
        'Close stale editor sessions before opening another workspace',
        429,
      );
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(id, {
      id,
      token,
      name: value.name,
      state: value.state,
      lastSeenAt: now,
      requests: new Map(),
    });
    return { id, token };
  }

  private session(id: string) {
    const session = this.sessions.get(id);
    if (!session)
      throw new ApiError('WORKSPACE_NOT_FOUND', 'The editor workspace is no longer registered', 404);
    return session;
  }

  authenticate(id: string, token: string) {
    const session = this.session(id);
    if (
      Buffer.byteLength(token) !== Buffer.byteLength(session.token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(session.token))
    )
      throw new ApiError('UNAUTHORIZED', 'A valid workspace session token is required', 401);
    return session;
  }

  connect(id: string, token: string, send: (request: WorkspaceRequest) => void, close: () => void) {
    const session = this.authenticate(id, token);
    session.disconnect?.();
    session.send = send;
    session.disconnect = close;
    session.lastSeenAt = Date.now();
    return () => {
      if (session.send !== send) return;
      session.send = undefined;
      session.disconnect = undefined;
      for (const outcome of session.requests.values())
        if (outcome.pending)
          outcome.finish(
            undefined,
            failure(
              'WORKSPACE_DISCONNECTED',
              'The editor disconnected before acknowledgement. Read its state before issuing a new request.',
            ),
          );
    };
  }

  report(id: string, token: string, input: unknown) {
    const session = this.authenticate(id, token);
    const state = workspaceStateSchema.parse(input);
    assertStateSize(state);
    this.validateStateRevision(session, state);
    session.state = state;
    session.lastSeenAt = Date.now();
    return { revision: state.revision };
  }

  private validateStateRevision(session: Session, state: WorkspaceState) {
    if (state.revision < session.state.revision)
      throw new ApiError(
        'WORKSPACE_REVISION_MISMATCH',
        'An older workspace report cannot overwrite newer state',
        409,
      );
    if (
      state.revision === session.state.revision &&
      workspaceStateFingerprint(state) !== workspaceStateFingerprint(session.state)
    )
      throw new ApiError(
        'WORKSPACE_REVISION_MISMATCH',
        'Changed browser state must advance its workspace revision',
        409,
      );
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      name: session.name,
      connected: Boolean(session.send && Date.now() - session.lastSeenAt <= this.staleMs),
      lastSeenAt: new Date(session.lastSeenAt).toISOString(),
      state: structuredClone(session.state),
    }));
  }

  private guard(request: WorkspaceRequest, state: WorkspaceState, checkWorkspace: boolean) {
    const project = this.store.project();
    if (project.id !== request.projectId || state.projectId !== request.projectId)
      throw new ApiError('PROJECT_MISMATCH', 'The server or editor has switched projects', 409);
    if (project.revision !== request.expectedRevision || state.projectRevision !== request.expectedRevision)
      throw new ApiError('REVISION_MISMATCH', 'The project changed or has not reached the editor yet', 409, {
        projectRevision: project.revision,
        workspaceProjectRevision: state.projectRevision,
      });
    if (
      checkWorkspace &&
      request.expectedWorkspaceRevision !== undefined &&
      state.revision !== request.expectedWorkspaceRevision
    )
      throw new ApiError(
        'WORKSPACE_REVISION_MISMATCH',
        'The user changed the workspace since it was read',
        409,
        {
          revision: state.revision,
        },
      );
  }

  request(id: string, input: unknown): Promise<unknown> {
    const request = workspaceRequestSchema.parse(input);
    if ((request.operation === 'apply') !== Boolean(request.command))
      throw new ApiError('VALIDATION_ERROR', 'Only apply requests require a workspace command');
    const session = this.session(id);
    const fingerprint = JSON.stringify(request);
    for (const [key, outcome] of session.requests)
      if (!outcome.pending && !outcome.retained) session.requests.delete(key);
    const previous = session.requests.get(request.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ApiError(
          'REQUEST_CONFLICT',
          'This workspace request ID was already used with different input',
          409,
        );
      return previous.promise;
    }
    if (!session.send || Date.now() - session.lastSeenAt > this.staleMs)
      throw new ApiError('WORKSPACE_DISCONNECTED', 'Open or reconnect the requested editor workspace', 409);
    this.guard(request, session.state, true);
    if ([...session.requests.values()].some((outcome) => outcome.pending))
      throw new ApiError('WORKSPACE_BUSY', 'Wait for the current workspace request to finish', 409);
    if (session.requests.size >= 10000)
      throw new ApiError(
        'WORKSPACE_REQUEST_LIMIT',
        'Reconnect the editor to start a fresh workspace session',
        429,
      );
    const retained = request.operation === 'apply';
    const fingerprintBytes = Buffer.byteLength(fingerprint);
    const reservedBytes = retained ? fingerprintBytes + Math.max(4096, payloadBytes(session.state)) : 0;
    if (this.retainedBytes + reservedBytes > this.maxRetainedBytes)
      throw new ApiError(
        'WORKSPACE_MEMORY_LIMIT',
        'Workspace retry cache is full; reconnect the editor after stale sessions expire',
        429,
      );

    let finish!: Outcome['finish'];
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          finish(
            undefined,
            failure(
              'WORKSPACE_TIMEOUT',
              'The editor did not acknowledge this request. Its outcome is unknown; read state before a new request.',
            ),
          ),
        this.timeoutMs,
      );
      finish = (result, error) => {
        const outcome = session.requests.get(request.id)!;
        if (!outcome.pending) return;
        outcome.pending = false;
        clearTimeout(timer);
        if (!outcome.retained) session.requests.delete(request.id);
        const account = (payload: unknown) => {
          if (!outcome.retained) return true;
          const next = fingerprintBytes + payloadBytes(payload);
          if (this.retainedBytes - outcome.bytes + next > this.maxRetainedBytes) return false;
          this.retainedBytes += next - outcome.bytes;
          outcome.bytes = next;
          return true;
        };
        const rejectResult = (cause: unknown) => {
          let reason = cause;
          if (!account(errorBody(reason))) {
            reason = new ApiError(
              'WORKSPACE_RESULT_TOO_LARGE',
              'Editor result exceeded the retry cache budget. The command may have applied; read actual state before a new request.',
              409,
            );
            account(errorBody(reason));
          }
          reject(reason);
        };
        if (error) return rejectResult(new ApiError(error.code, error.message, 409, error.details));
        try {
          const validated =
            request.operation === 'capture'
              ? captureResultSchema.parse(result)
              : request.operation === 'inspect'
                ? inspectionResultSchema.parse(result)
                : workspaceStateSchema.parse(result);
          const state = workspaceStateSchema.parse(
            request.operation === 'capture' || request.operation === 'inspect'
              ? (validated as { state: WorkspaceState }).state
              : validated,
          );
          assertStateSize(state);
          this.guard(request, state, false);
          this.validateStateRevision(session, state);
          if (request.operation === 'capture') {
            const image = (validated as { dataUrl: string }).dataUrl;
            const bytes = Buffer.from(image.slice('data:image/png;base64,'.length), 'base64');
            if (
              !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image) ||
              bytes.length < 24 ||
              !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            )
              throw new ApiError(
                'WORKSPACE_CAPTURE_FAILED',
                'The editor did not return an actual PNG image',
                409,
              );
          }
          if (!account(validated))
            throw new ApiError(
              'WORKSPACE_RESULT_TOO_LARGE',
              'Editor result exceeded the retry cache budget. The command may have applied; read actual state before a new request.',
              409,
            );
          session.state = state;
          session.lastSeenAt = Date.now();
          resolve(validated);
        } catch (caught) {
          rejectResult(caught);
        }
      };
    });
    // Retain completed outcomes until this browser session expires; retries must never execute twice.
    session.requests.set(request.id, {
      fingerprint,
      promise,
      finish,
      pending: true,
      retained,
      bytes: reservedBytes,
    });
    this.retainedBytes += reservedBytes;
    promise.catch(() => {});
    try {
      session.send(request);
    } catch {
      finish(undefined, failure('WORKSPACE_DISCONNECTED', 'Could not deliver the editor request'));
    }
    return promise;
  }

  acknowledge(id: string, token: string, requestId: string, result?: unknown, error?: WorkspaceError) {
    const session = this.authenticate(id, token);
    const outcome = session.requests.get(requestId);
    if (!outcome) throw new ApiError('WORKSPACE_REQUEST_NOT_FOUND', 'Unknown workspace request', 404);
    const accepted = outcome.pending;
    outcome.finish(result, error);
    return { accepted };
  }

  close() {
    for (const session of this.sessions.values()) {
      session.disconnect?.();
      for (const outcome of session.requests.values())
        if (outcome.pending)
          outcome.finish(undefined, failure('WORKSPACE_DISCONNECTED', 'Server is shutting down'));
    }
    this.sessions.clear();
    this.retainedBytes = 0;
  }
}

const services = new WeakMap<Store, WorkspaceService>();
export function getWorkspaceService(store: Store) {
  let service = services.get(store);
  if (!service) {
    service = new WorkspaceService(store);
    services.set(store, service);
  }
  return service;
}
