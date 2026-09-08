import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../server/store';
import { ModelingJobService } from '../server/modeling-jobs';
import { modelingDigest } from '../server/modeling-jobs-protocol';
import type { ModelingJob } from '../shared/modeling-jobs';
import type { Command, Project } from '../shared/types';
import { topologyCube } from './fixtures/topology-command-cases';

function setup(store: Store): Project {
  const mesh = topologyCube();
  store.newProject('Worker modeling', 'empty');
  return store.commands({
    commands: [
      { type: 'object.create', payload: { id: 'target', type: 'box', dimensions: [2, 2, 2] } },
      { type: 'mesh.set', payload: { id: 'target', mesh: { vertices: mesh.vertices, faces: mesh.faces } } },
    ],
  }).project;
}
function request(project: Project, requestId: string, commands: Command[]) {
  return {
    projectId: project.id,
    expectedRevision: project.revision,
    expectedContext: {
      sceneId: project.production?.activeSceneId ?? null,
      performanceId: project.production?.activePerformanceId ?? null,
    },
    requestId,
    commands,
  };
}
function waitFor(
  service: ModelingJobService,
  id: string,
  predicate: (job: ModelingJob) => boolean,
  timeout = 15000,
): Promise<ModelingJob> {
  const current = service.status(id);
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.off('job', listener);
      reject(new Error(`Job ${id} did not reach the expected state: ${JSON.stringify(service.status(id))}`));
    }, timeout);
    const listener = (job: ModelingJob) => {
      if (job.id === id && predicate(job)) {
        clearTimeout(timer);
        service.off('job', listener);
        resolve(service.status(id));
      }
    };
    service.on('job', listener);
  });
}
const terminal = (job: ModelingJob) => ['completed', 'failed', 'cancelled'].includes(job.status);
const bevel: Command = { type: 'topology.bevel', payload: { id: 'target', width: 0.15, segments: 3 } };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-modeling-jobs-'));
  const store = new Store(directory);
  const project = setup(store);
  const service = new ModelingJobService(store, (checked, publish) =>
    store.commitModelingJob(checked, publish),
  );
  return {
    directory,
    store,
    project,
    service,
    close: async () => {
      await service.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('real worker computes geometry, reports command stages, commits one history entry and permits exact undo', async () => {
  const work = await fixture();
  try {
    const progress: ModelingJob['progress'][] = [];
    work.service.on('job', (job: ModelingJob) => progress.push(job.progress));
    let ticks = 0;
    const interval = setInterval(() => ticks++, 2);
    const job = work.service.start(
      request(work.project, 'geometry', [
        bevel,
        { type: 'object.update', payload: { id: 'target', patch: { name: 'Beveled body' } } },
      ]),
    );
    const done = await waitFor(work.service, job.id, terminal);
    clearInterval(interval);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.ok(
      ticks > 2,
      'The event loop must remain responsive during real worker loading and geometry computation',
    );
    assert.ok(progress.some((value) => value.completedCommands === 1 && value.phase === 'computing'));
    assert.ok(progress.some((value) => value.stage === 'validating' && value.completedCommands === 2));
    const project = work.store.project();
    assert.equal(project.revision, work.project.revision + 1);
    assert.equal(project.objects[0].name, 'Beveled body');
    assert.ok(project.objects[0].modeling?.kind === 'mesh' && project.objects[0].modeling.faces.length > 6);
    assert.equal(done.resultHash, modelingDigest(JSON.stringify(done.result)));
    work.store.travel(-1);
    assert.deepEqual(work.store.project().objects, work.project.objects);
    work.store.travel(1);
    assert.deepEqual(work.store.project().objects, project.objects);
  } finally {
    await work.close();
  }
});

test('idempotency replays completed jobs across project switches and store restarts without duplicate publication', async () => {
  const work = await fixture();
  let reopened: Store | undefined;
  let reopenedService: ModelingJobService | undefined;
  try {
    const input = request(work.project, 'replay', [bevel]);
    const job = work.service.start(input);
    assert.equal(work.service.start(input).id, job.id);
    assert.throws(
      () =>
        work.service.start({ ...input, commands: [{ ...bevel, payload: { ...bevel.payload, width: 0.2 } }] }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const done = await waitFor(work.service, job.id, terminal);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    work.store.newProject('Other project', 'empty');
    const active = work.store.project();
    assert.equal(work.service.start(input).id, job.id);
    assert.deepEqual(work.store.project(), active);
    await work.service.close();
    reopened = new Store(work.directory);
    reopenedService = new ModelingJobService(reopened, (checked, publish) =>
      reopened!.commitModelingJob(checked, publish),
    );
    assert.deepEqual(reopenedService.start(input), done);
    assert.deepEqual(reopened.project(), active);
    assert.equal(reopenedService.list(work.project.id).length, 1);
  } finally {
    await reopenedService?.close();
    reopened?.close();
    await work.close();
  }
});

test('concurrent project edits reject computed results at commit without losing the intervening edit', async () => {
  const work = await fixture();
  try {
    const job = work.service.start(
      request(work.project, 'conflict', [{ ...bevel, payload: { ...bevel.payload, segments: 10 } }]),
    );
    await waitFor(work.service, job.id, (value) => value.progress.stage === 'computing');
    work.store.commands({
      commands: [
        { type: 'object.update', payload: { id: 'target', patch: { name: 'User edit during computation' } } },
      ],
    });
    const current = work.store.project();
    const done = await waitFor(work.service, job.id, terminal);
    assert.equal(done.status, 'failed');
    assert.ok(
      ['REVISION_CONFLICT', 'SNAPSHOT_CONFLICT'].includes(done.error?.code ?? ''),
      JSON.stringify(done.error),
    );
    assert.deepEqual(work.store.project(), current);
  } finally {
    await work.close();
  }
});

test('queued and actively computing jobs can be cancelled without publishing geometry', async () => {
  const work = await fixture();
  try {
    const active = work.service.start(
      request(work.project, 'cancel-active', [{ ...bevel, payload: { ...bevel.payload, segments: 16 } }]),
    );
    const queued = work.service.start(request(work.project, 'cancel-queued', [bevel]));
    assert.equal((await work.service.cancel(queued.id)).status, 'cancelled');
    await waitFor(work.service, active.id, (job) => job.progress.stage === 'computing');
    assert.equal((await work.service.cancel(active.id)).status, 'cancelled');
    assert.deepEqual(work.store.project(), work.project);
    assert.equal(work.service.status(active.id).result, undefined);
    assert.equal((await work.service.cancel(active.id)).status, 'cancelled');
  } finally {
    await work.close();
  }
});

test('cancelling during asynchronous module loading exits without starting geometry computation', async () => {
  const work = await fixture();
  try {
    let computed = false;
    work.service.on('job', (job: ModelingJob) => {
      if (job.progress.stage === 'computing') computed = true;
    });
    const job = work.service.start(request(work.project, 'cancel-loading', [bevel]));
    await waitFor(
      work.service,
      job.id,
      (value) => value.status === 'running' && value.progress.phase === 'starting',
    );
    assert.equal((await work.service.cancel(job.id)).status, 'cancelled');
    assert.equal(computed, false);
    assert.deepEqual(work.store.project(), work.project);
  } finally {
    await work.close();
  }
});

test('surface construction and modifier evaluation run in one worker transaction with retained sources', async () => {
  const work = await fixture();
  try {
    const commands: Command[] = [
      {
        type: 'surface.set',
        payload: {
          id: 'target',
          surface: {
            kind: 'surface',
            operation: 'sweep',
            segments: 6,
            profileSegments: 2,
            path: { points: [{ position: [0, 0, 0] }, { position: [0, 0, 4] }] },
            profile: {
              outer: {
                closed: true,
                points: [
                  [-1, -1],
                  [1, -1],
                  [1, 1],
                  [-1, 1],
                ].map((position) => ({ position })),
              },
            },
          },
        },
      },
      {
        type: 'modifier.add',
        payload: { id: 'target', modifier: { id: 'row', type: 'array', count: 3, offset: [3, 0, 0] } },
      },
    ];
    const job = work.service.start(request(work.project, 'surface-modifier', commands));
    const done = await waitFor(work.service, job.id, terminal);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    const source = work.store.project().objects[0].modeling;
    assert.equal(source?.kind, 'stack');
    assert.ok(
      source?.kind === 'stack' && source.base.kind === 'surface' && source.modifiers[0].type === 'array',
    );
    assert.equal(work.store.project().revision, work.project.revision + 1);
    work.store.travel(-1);
    assert.deepEqual(work.store.project().objects, work.project.objects);
  } finally {
    await work.close();
  }
});

test('queued jobs retain their starting snapshots and a later conflicting job cannot overwrite the first result', async () => {
  const work = await fixture();
  try {
    const first = work.service.start(request(work.project, 'queue-first', [bevel]));
    const second = work.service.start(
      request(work.project, 'queue-second', [
        { type: 'object.update', payload: { id: 'target', patch: { name: 'Stale queued rename' } } },
      ]),
    );
    assert.equal((await waitFor(work.service, first.id, terminal)).status, 'completed');
    const accepted = work.store.project();
    const rejected = await waitFor(work.service, second.id, terminal);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.error?.code, 'REVISION_CONFLICT');
    assert.deepEqual(work.store.project(), accepted);
  } finally {
    await work.close();
  }
});

test('worker validation honors locked geometry and rolls back earlier commands in its batch', async () => {
  const work = await fixture();
  try {
    const locked = work.store.commands({
      commands: [{ type: 'object.update', payload: { id: 'target', patch: { locked: true } } }],
    }).project;
    const job = work.service.start(
      request(locked, 'locked', [{ type: 'project.update', payload: { name: 'Must never persist' } }, bevel]),
    );
    const done = await waitFor(work.service, job.id, terminal);
    assert.equal(done.status, 'failed');
    assert.match(done.error?.message ?? '', /locked/i);
    assert.deepEqual(work.store.project(), locked);
    const invalid = work.service.start(
      request(locked, 'invalid', [{ type: 'not-a-real-command', payload: {} }]),
    );
    assert.equal((await waitFor(work.service, invalid.id, terminal)).status, 'failed');
  } finally {
    await work.close();
  }
});

test('worker inspection returns actual evaluated geometry and diagnostics without project mutation', async () => {
  const work = await fixture();
  try {
    const source = work.store.commands({
      commands: [
        {
          type: 'modifier.add',
          payload: { id: 'target', modifier: { id: 'array', type: 'array', count: 2, offset: [3, 0, 0] } },
        },
      ],
    }).project;
    const input = {
      ...request(source, 'inspect', []),
      kind: 'inspect',
      objectId: 'target',
      stage: 'evaluated',
      componentKind: 'face',
      offset: 0,
      limit: 100,
    };
    const { commands: _commands, ...inspection } = input;
    const job = work.service.start(inspection);
    const done = await waitFor(work.service, job.id, terminal);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal((done.result as { total: number }).total, 12);
    assert.equal(
      (done.result as { diagnostics: { counts: { connectedComponents: number } } }).diagnostics.counts
        .connectedComponents,
      2,
    );
    assert.deepEqual(work.store.project(), source);
  } finally {
    await work.close();
  }
});

test('stored snapshot tampering and transaction publication failure cannot install computed geometry', async () => {
  const work = await fixture();
  try {
    const job = work.service.start(
      request(work.project, 'tampered', [{ ...bevel, payload: { ...bevel.payload, segments: 8 } }]),
    );
    await waitFor(work.service, job.id, (value) => value.progress.stage === 'computing');
    work.store.db
      .prepare('UPDATE modeling_jobs SET snapshot=? WHERE id=?')
      .run(JSON.stringify({ ...work.project, name: 'tampered' }), job.id);
    const failed = await waitFor(work.service, job.id, terminal);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'WORKER_DIGEST_MISMATCH');
    assert.deepEqual(work.store.project(), work.project);
    work.store.db.exec(
      "CREATE TRIGGER reject_modeling_publication BEFORE UPDATE ON modeling_jobs WHEN json_extract(NEW.document,'$.status')='completed' BEGIN SELECT RAISE(ABORT,'Injected publication failure'); END",
    );
    const publication = work.service.start(request(work.project, 'publication-rollback', [bevel]));
    assert.equal((await waitFor(work.service, publication.id, terminal)).status, 'failed');
    assert.deepEqual(work.store.project(), work.project);
    const receipts = work.store.db
      .prepare('SELECT count(*) AS count FROM requests WHERE request_id LIKE ?')
      .get('modeling-job:%') as { count: number };
    assert.equal(receipts.count, 0);
  } finally {
    await work.close();
  }
});

test('real server process interruption leaves a failed durable job on restart without modifying project history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-modeling-crash-'));
  let store = new Store(directory);
  const project = setup(store);
  store.close();
  const input = request(project, 'crash-recovery', [
    { ...bevel, payload: { ...bevel.payload, segments: 16 } },
  ]);
  const script = `import { Store } from ${JSON.stringify(new URL('../server/store.ts', import.meta.url).href)};
    import { ModelingJobService } from ${JSON.stringify(new URL('../server/modeling-jobs.ts', import.meta.url).href)};
    const store = new Store(${JSON.stringify(directory)});
    const service = new ModelingJobService(store, (checked,publish) => store.commitModelingJob(checked,publish));
    service.on('job', job => { if(job.progress.stage === 'computing') process.stdout.write(JSON.stringify({id:job.id})+'\\n'); });
    service.start(${JSON.stringify(input)});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let service: ModelingJobService | undefined;
  try {
    const id = await new Promise<string>((resolve, reject) => {
      let output = '';
      let errors = '';
      const timer = setTimeout(
        () => reject(new Error(`Crash fixture did not enter computing: ${errors}`)),
        15000,
      );
      child.stderr.on('data', (value) => {
        errors += String(value);
      });
      child.stdout.on('data', (value) => {
        output += String(value);
        const match = output.match(/\{"id":"([^"]+)"\}/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Crash fixture exited early: ${code}: ${errors}`));
      });
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    store = new Store(directory);
    service = new ModelingJobService(store, (checked, publish) => store.commitModelingJob(checked, publish));
    assert.equal(service.status(id).status, 'failed');
    assert.equal(service.status(id).error?.code, 'MODELING_INTERRUPTED');
    assert.deepEqual(store.project(), project);
    assert.equal(service.start(input).id, id);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
    await service?.close();
    if (service) store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('job input guards and queue capacity reject before spawning or committing work', async () => {
  const work = await fixture();
  try {
    const input = request(work.project, 'guard', [bevel]);
    assert.throws(() => work.service.start({ ...input, expectedRevision: -1 }));
    assert.throws(
      () => work.service.start({ ...input, expectedContext: { sceneId: 'unknown', performanceId: null } }),
      { code: 'CONTEXT_CONFLICT' },
    );
    assert.throws(() => work.service.start({ ...input, projectId: 'other' }), { code: 'PROJECT_CONFLICT' });
    assert.throws(() => work.service.start({ ...input, commands: [] }));
    for (let index = 0; index < 8; index++) work.service.start({ ...input, requestId: `queued-${index}` });
    assert.throws(() => work.service.start(input), { code: 'MODELING_QUEUE_FULL' });
    for (const job of work.service.list()) await work.service.cancel(job.id);
    assert.deepEqual(work.store.project(), work.project);
  } finally {
    await work.close();
  }
});
