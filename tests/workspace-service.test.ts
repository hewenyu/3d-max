import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store';
import { WorkspaceService } from '../server/workspace-service';
import type { WorkspaceRequest, WorkspaceState } from '../shared/workspace';

async function fixture(maxRetainedBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-workspace-'));
  const store = new Store(directory, 'workspace-test');
  const project = store.project();
  const state: WorkspaceState = {
    revision: 0,
    projectId: project.id,
    projectRevision: project.revision,
    context: { sceneId: null, performanceId: null },
    selection: [],
    view: 'edit',
    observation: {
      edit: { position: [5, 4, 8], target: [0, 1, 0], fov: 45 },
      top: { position: [0, 20, 0], target: [0, 0, 0], zoom: 1 },
    },
    transport: {
      time: 0,
      sourceTime: 0,
      cameraTime: 0,
      duration: 10,
      playing: false,
      loop: false,
      muted: true,
    },
    settings: { tool: 'translate', snap: false, helpers: true, safeFrame: true },
    panels: {
      leftVisible: true,
      rightVisible: true,
      mobilePanel: null,
      inspectorTab: 'shot',
      inspectorMode: 'base',
      sceneTab: 'scene',
    },
    dialog: null,
    comparison: null,
    cutReview: null,
    media: null,
    fullscreen: false,
    fullscreenTarget: null,
    viewport: {
      width: 1280,
      height: 720,
      loading: false,
      sceneId: null,
      performanceId: null,
      workspace: true,
    },
  };
  const service = new WorkspaceService(store, 30, 10000, maxRetainedBytes);
  const credentials = service.register({ name: 'First tab', state });
  const request: WorkspaceRequest = {
    id: 'request-1',
    operation: 'apply',
    projectId: project.id,
    expectedRevision: project.revision,
    expectedWorkspaceRevision: 0,
    command: { type: 'selection', ids: ['actor-a'] },
  };
  return {
    store,
    service,
    state,
    credentials,
    request,
    async close() {
      service.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('workspace commands address one tab, authenticate reports and replay one actual acknowledgement', async () => {
  const context = await fixture();
  const { service, state, credentials, request } = context;
  try {
    const second = service.register({ id: credentials.id, name: 'Second tab', state });
    assert.notEqual(second.id, credentials.id, 'Registration cannot claim another tab ID');
    assert.throws(() => service.report(credentials.id, second.token, state), { code: 'UNAUTHORIZED' });
    assert.throws(() => service.request(credentials.id, request), { code: 'WORKSPACE_DISCONNECTED' });
    const messages: WorkspaceRequest[] = [];
    service.connect(
      credentials.id,
      credentials.token,
      (message) => messages.push(message),
      () => {},
    );
    let unrelatedCalls = 0;
    service.connect(
      second.id,
      second.token,
      () => unrelatedCalls++,
      () => {},
    );
    const first = service.request(credentials.id, request);
    assert.equal(service.request(credentials.id, request), first);
    assert.equal(messages.length, 1);
    assert.equal(unrelatedCalls, 0);
    assert.throws(
      () => service.request(credentials.id, { ...request, command: { type: 'selection', ids: [] } }),
      { code: 'REQUEST_CONFLICT' },
    );
    assert.throws(() => service.request(credentials.id, { ...request, id: 'busy' }), {
      code: 'WORKSPACE_BUSY',
    });
    const actual = { ...state, revision: 1, selection: ['actor-a'] };
    assert.deepEqual(service.acknowledge(credentials.id, credentials.token, request.id, actual), {
      accepted: true,
    });
    assert.deepEqual(await first, actual);
    assert.deepEqual(await service.request(credentials.id, request), actual);
    assert.equal(messages.length, 1);
    assert.deepEqual(service.list().find((session) => session.id === second.id)!.state.selection, []);
    assert.equal(service.list()[0].state.projectRevision, state.projectRevision);
    assert.equal(JSON.stringify(service.list()).includes(credentials.token), false);
    assert.throws(() => service.report(credentials.id, credentials.token, state), {
      code: 'WORKSPACE_REVISION_MISMATCH',
    });
  } finally {
    await context.close();
  }
});

test('workspace requests reject project switches and concurrent revisions before and after execution', async () => {
  const context = await fixture();
  const { service, store, state, credentials, request } = context;
  try {
    service.connect(
      credentials.id,
      credentials.token,
      () => {},
      () => {},
    );
    assert.throws(() => service.request(credentials.id, { ...request, projectId: 'wrong-project' }), {
      code: 'PROJECT_MISMATCH',
    });
    assert.throws(() => service.request(credentials.id, { ...request, expectedRevision: 999 }), {
      code: 'REVISION_MISMATCH',
    });
    assert.throws(() => service.request(credentials.id, { ...request, expectedWorkspaceRevision: 999 }), {
      code: 'WORKSPACE_REVISION_MISMATCH',
    });
    const pending = service.request(credentials.id, request);
    store.commands({ commands: [{ type: 'project.update', payload: { name: 'Concurrent edit' } }] });
    service.acknowledge(credentials.id, credentials.token, request.id, { ...state, revision: 1 });
    await assert.rejects(pending, { code: 'REVISION_MISMATCH' });
    const later = store.project();
    const updated = { ...state, projectRevision: later.revision, revision: 2 };
    service.report(credentials.id, credentials.token, updated);
    const switching = service.request(credentials.id, {
      ...request,
      id: 'switch',
      expectedRevision: later.revision,
      expectedWorkspaceRevision: 2,
    });
    store.newProject('Other project', 'empty');
    service.acknowledge(credentials.id, credentials.token, 'switch', updated);
    await assert.rejects(switching, { code: 'PROJECT_MISMATCH' });
  } finally {
    await context.close();
  }
});

test('workspace timeout, disconnect and native failures never become successful or repeat execution', async () => {
  const context = await fixture();
  const { service, state, credentials, request } = context;
  try {
    let executions = 0;
    let disconnect = service.connect(
      credentials.id,
      credentials.token,
      () => executions++,
      () => {},
    );
    await assert.rejects(service.request(credentials.id, request), { code: 'WORKSPACE_TIMEOUT' });
    assert.deepEqual(service.acknowledge(credentials.id, credentials.token, request.id, state), {
      accepted: false,
    });
    await assert.rejects(service.request(credentials.id, request), { code: 'WORKSPACE_TIMEOUT' });
    assert.equal(executions, 1);
    const dropped = service.request(credentials.id, { ...request, id: 'dropped' });
    disconnect();
    await assert.rejects(dropped, { code: 'WORKSPACE_DISCONNECTED' });
    disconnect = service.connect(
      credentials.id,
      credentials.token,
      () => executions++,
      () => {},
    );
    const fullscreen = service.request(credentials.id, {
      ...request,
      id: 'native',
      command: { type: 'fullscreen', enabled: true },
    });
    service.acknowledge(credentials.id, credentials.token, 'native', undefined, {
      code: 'USER_ACTIVATION_REQUIRED',
      message: 'Browser denied fullscreen',
    });
    await assert.rejects(fullscreen, { code: 'USER_ACTIVATION_REQUIRED' });
    const beforeRetry = executions;
    await assert.rejects(
      service.request(credentials.id, {
        ...request,
        id: 'native',
        command: { type: 'fullscreen', enabled: true },
      }),
      { code: 'USER_ACTIVATION_REQUIRED' },
    );
    assert.equal(executions, beforeRetry);
    disconnect();
  } finally {
    await context.close();
  }
});

test('viewport acknowledgement requires a PNG and retains exact evaluated state and constraints', async () => {
  const context = await fixture();
  const { service, state, credentials, request } = context;
  try {
    service.connect(
      credentials.id,
      credentials.token,
      () => {},
      () => {},
    );
    const { command: _command, ...read } = request;
    const invalid = service.request(credentials.id, { ...read, operation: 'capture' });
    service.acknowledge(credentials.id, credentials.token, read.id, { state, dataUrl: 'not-an-image' });
    await assert.rejects(invalid, { code: 'WORKSPACE_CAPTURE_FAILED' });
    const captured = service.request(credentials.id, { ...read, id: 'png', operation: 'capture' });
    const png = {
      state,
      dataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3k0AAAAASUVORK5CYII=',
    };
    service.acknowledge(credentials.id, credentials.token, 'png', png);
    assert.deepEqual(await captured, png);
    const inspected = service.request(credentials.id, { ...read, id: 'diagnostics', operation: 'inspect' });
    const diagnostics = {
      state,
      objects: [],
      constraints: [
        {
          objectId: 'actor-a',
          results: [
            {
              id: 'hand',
              effector: 'rightHand',
              status: 'solved',
              error: 0,
              target: [0, 1, 0],
              position: [0, 1, 0],
              reachable: true,
              reached: true,
              weight: 1,
            },
          ],
        },
      ],
      frame: { x: 0, y: 0, width: 1280, height: 720 },
      context: {
        sceneId: null,
        performanceId: null,
        sceneName: 'First set',
        workspace: true,
        loading: false,
      },
    };
    service.acknowledge(credentials.id, credentials.token, 'diagnostics', diagnostics);
    assert.deepEqual(await inspected, diagnostics);
    assert.throws(() => service.request(credentials.id, { ...request, operation: 'get' }), {
      code: 'VALIDATION_ERROR',
    });
    assert.throws(() => service.request(credentials.id, { ...read, operation: 'apply' }), {
      code: 'VALIDATION_ERROR',
    });
  } finally {
    await context.close();
  }
});

test('workspace revision guards reject conflicting state at the same revision', async () => {
  const context = await fixture();
  const { service, state, credentials, request } = context;
  try {
    service.connect(
      credentials.id,
      credentials.token,
      () => {},
      () => {},
    );
    const changed = { ...state, selection: ['actor-a'] };
    assert.throws(() => service.report(credentials.id, credentials.token, changed), {
      code: 'WORKSPACE_REVISION_MISMATCH',
    });
    const pending = service.request(credentials.id, request);
    service.acknowledge(credentials.id, credentials.token, request.id, changed);
    await assert.rejects(pending, { code: 'WORKSPACE_REVISION_MISMATCH' });
    assert.deepEqual(service.list()[0].state, state);
    assert.deepEqual(service.report(credentials.id, credentials.token, state), { revision: state.revision });
    const jitter = structuredClone(state);
    jitter.observation.edit.position[0] += 1e-12;
    assert.deepEqual(service.report(credentials.id, credentials.token, jitter), { revision: state.revision });
    assert.equal(
      service.list()[0].state.observation.edit.position[0],
      jitter.observation.edit.position[0],
      'Canonical comparison must preserve raw reported coordinates',
    );
  } finally {
    await context.close();
  }
});

test('workspace retry cache rejects excess allocation without evicting successful command outcomes', async () => {
  const context = await fixture(5000);
  const { service, state, credentials, request } = context;
  try {
    let delivered = 0;
    service.connect(
      credentials.id,
      credentials.token,
      () => delivered++,
      () => {},
    );
    const first = service.request(credentials.id, request);
    const actual = { ...state, revision: 1, selection: ['actor-a'] };
    service.acknowledge(credentials.id, credentials.token, request.id, actual);
    assert.deepEqual(await first, actual);
    assert.throws(
      () => service.request(credentials.id, { ...request, id: 'over-budget', expectedWorkspaceRevision: 1 }),
      { code: 'WORKSPACE_MEMORY_LIMIT' },
    );
    assert.equal(delivered, 1);
    assert.deepEqual(await service.request(credentials.id, request), actual);
    const { command: _command, ...read } = request;
    const fresh = service.request(credentials.id, {
      ...read,
      id: 'read-at-limit',
      operation: 'get',
      expectedWorkspaceRevision: 1,
    });
    service.acknowledge(credentials.id, credentials.token, 'read-at-limit', actual);
    assert.deepEqual(await fresh, actual);
    assert.equal(delivered, 2);
    assert.deepEqual(await service.request(credentials.id, request), actual);
  } finally {
    await context.close();
  }
});

test('oversized acknowledgements and late results retain a bounded failure instead of repeating commands', async () => {
  const context = await fixture(5000);
  const { service, state, credentials, request } = context;
  try {
    let delivered = 0;
    service.connect(
      credentials.id,
      credentials.token,
      () => delivered++,
      () => {},
    );
    const pending = service.request(credentials.id, request);
    service.acknowledge(credentials.id, credentials.token, request.id, {
      ...state,
      revision: 1,
      selection: Array.from({ length: 100 }, (_, index) => `${index}-${'x'.repeat(180)}`),
    });
    await assert.rejects(pending, { code: 'WORKSPACE_RESULT_TOO_LARGE' });
    assert.deepEqual(service.acknowledge(credentials.id, credentials.token, request.id, state), {
      accepted: false,
    });
    await assert.rejects(service.request(credentials.id, request), { code: 'WORKSPACE_RESULT_TOO_LARGE' });
    assert.equal(delivered, 1);
    const oversizedError = service.request(credentials.id, { ...request, id: 'oversized-error' });
    service.acknowledge(credentials.id, credentials.token, 'oversized-error', undefined, {
      code: 'FAILED',
      message: 'Large browser error',
      details: 'x'.repeat(20000),
    });
    await assert.rejects(oversizedError, { code: 'WORKSPACE_RESULT_TOO_LARGE' });
    await assert.rejects(service.request(credentials.id, { ...request, id: 'oversized-error' }), {
      code: 'WORKSPACE_RESULT_TOO_LARGE',
    });
    assert.equal(delivered, 2);
  } finally {
    await context.close();
  }
});

test('inspection acknowledgement validates full rendered diagnostics before reporting success', async () => {
  const context = await fixture();
  const { service, state, credentials, request } = context;
  try {
    service.connect(
      credentials.id,
      credentials.token,
      () => {},
      () => {},
    );
    const { command: _command, ...read } = request;
    const pending = service.request(credentials.id, { ...read, operation: 'inspect' });
    service.acknowledge(credentials.id, credentials.token, request.id, { state });
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'ZodError');
    assert.deepEqual(service.list()[0].state, state);
  } finally {
    await context.close();
  }
});
