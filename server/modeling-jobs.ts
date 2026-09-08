import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import {
  MODELING_JOB_LIMITS,
  modelingJobRequestSchema,
  type ModelingJob,
  type ModelingJobError,
  type ModelingJobRequest,
} from '../shared/modeling-jobs';
import type { CommandResponse, Project } from '../shared/types';
import type { Store } from './store';
import type { ServerConfig } from './config';
import type { ModelingAssetProgress } from '../shared/model-assets';
import { guardedModelProject, publishModelExport, type PreparedModelExport } from './modeling-assets';
import { ApiError, errorBody, errorStatus } from './errors';
import {
  createModelingWorker,
  modelingDigest,
  type ModelingJobCommit,
  type ModelingWorkerMessage,
} from './modeling-jobs-protocol';

interface JobRow {
  document: string;
  snapshot: string;
  request: string;
  result: string | null;
  reserved: number;
  assets: string;
}
interface ActiveWorker {
  id: string;
  worker: Worker;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  ready: boolean;
  cancellation: Int32Array;
  exited: Promise<void>;
  publishing?: Promise<void>;
}
interface RequestRow {
  fingerprint: string;
  job_id: string;
}

function jobError(error: unknown): ModelingJobError {
  return { ...errorBody(error).error, status: errorStatus(error) };
}
function assertId(value: string) {
  if (typeof value !== 'string' || !value.length || value.length > 200)
    throw new ApiError('INVALID_JOB_ID', 'A modeling job ID is required');
}
function context(project: Project) {
  return {
    sceneId: project.production?.activeSceneId ?? null,
    performanceId: project.production?.activePerformanceId ?? null,
  };
}

export class ModelingJobService extends EventEmitter {
  private queue: string[] = [];
  private active?: ActiveWorker;
  private stopped = false;
  constructor(
    private store: Store,
    private commit: ModelingJobCommit,
    private config?: ServerConfig,
  ) {
    super();
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS modeling_jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document TEXT NOT NULL,
        snapshot TEXT NOT NULL, request TEXT NOT NULL, result TEXT, reserved INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS modeling_jobs_project ON modeling_jobs(project_id);
      CREATE TABLE IF NOT EXISTS modeling_job_requests (
        project_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES modeling_jobs(id), PRIMARY KEY(project_id, request_id)
      );
    `);
    if (
      !(store.db.prepare('PRAGMA table_info(modeling_jobs)').all() as { name: string }[]).some(
        (column) => column.name === 'assets',
      )
    )
      store.db.exec("ALTER TABLE modeling_jobs ADD COLUMN assets TEXT NOT NULL DEFAULT '[]'");
    const interrupted = store.db
      .prepare(
        "SELECT document FROM modeling_jobs WHERE json_extract(document,'$.status') IN ('queued','running')",
      )
      .all() as { document: string }[];
    for (const { document } of interrupted) {
      const job = JSON.parse(document) as ModelingJob;
      this.save(
        {
          ...job,
          status: 'failed',
          progress: { ...job.progress, phase: 'finished' },
          finishedAt: new Date().toISOString(),
          error: {
            code: 'MODELING_INTERRUPTED',
            message: 'Server restarted before modeling finished; start a new request to retry',
          },
        },
        undefined,
        false,
      );
    }
  }

  private row(id: string): JobRow {
    assertId(id);
    const row = this.store.db
      .prepare('SELECT document,snapshot,request,result,reserved,assets FROM modeling_jobs WHERE id=?')
      .get(id) as unknown as JobRow | undefined;
    if (!row) throw new ApiError('NOT_FOUND', 'Modeling job not found', 404);
    return row;
  }

  status(id: string): ModelingJob {
    const row = this.row(id);
    return {
      ...JSON.parse(row.document),
      ...(row.result ? { result: JSON.parse(row.result) } : {}),
    } as ModelingJob;
  }

  list(projectId?: string): ModelingJob[] {
    if (projectId !== undefined) assertId(projectId);
    const rows = (
      projectId
        ? this.store.db
            .prepare('SELECT document FROM modeling_jobs WHERE project_id=? ORDER BY rowid DESC LIMIT 200')
            .all(projectId)
        : this.store.db.prepare('SELECT document FROM modeling_jobs ORDER BY rowid DESC LIMIT 200').all()
    ) as { document: string }[];
    return rows.map((row) => JSON.parse(row.document) as ModelingJob);
  }

  private notify(job: ModelingJob) {
    this.emit('job', job);
    this.store.emit('modeling-job', job);
  }

  private save(job: ModelingJob, result?: string, notify = true) {
    const { result: _result, ...document } = job;
    document.updatedAt = new Date().toISOString();
    this.store.db
      .prepare('UPDATE modeling_jobs SET document=?,result=COALESCE(?,result),reserved=? WHERE id=?')
      .run(
        JSON.stringify(document),
        result ?? null,
        ['queued', 'running'].includes(document.status) ? this.row(job.id).reserved : 0,
        job.id,
      );
    if (notify) this.notify(document);
  }

  start(input: unknown): ModelingJob {
    if (this.stopped) throw new ApiError('MODELING_STOPPED', 'Modeling workers are stopped', 503);
    const request = modelingJobRequestSchema.parse(input);
    const encodedRequest = JSON.stringify(request);
    const requestHash = modelingDigest(encodedRequest);
    const replay = this.store.db
      .prepare('SELECT fingerprint,job_id FROM modeling_job_requests WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as RequestRow | undefined;
    if (replay) {
      if (replay.fingerprint !== requestHash)
        throw new ApiError(
          'IDEMPOTENCY_CONFLICT',
          'A modeling request ID was reused with different inputs',
          409,
        );
      return this.status(replay.job_id);
    }
    const project = this.store.project();
    if (project.id !== request.projectId)
      throw new ApiError('PROJECT_CONFLICT', 'The active project changed before modeling', 409);
    if (project.revision !== request.expectedRevision)
      throw new ApiError('REVISION_CONFLICT', 'The project changed before modeling', 409);
    const currentContext = context(project);
    if (
      currentContext.sceneId !== request.expectedContext.sceneId ||
      currentContext.performanceId !== request.expectedContext.performanceId
    )
      throw new ApiError('CONTEXT_CONFLICT', 'The active scene or performance changed before modeling', 409);
    const snapshot = JSON.stringify(project);
    const assetJob = request.kind === 'conversion' || request.kind === 'export';
    if (assetJob && !this.config)
      throw new ApiError(
        'MODELING_ASSET_UNAVAILABLE',
        'Model asset jobs require the server asset configuration',
        503,
      );
    const assets = assetJob
      ? `[${(this.store.db.prepare('SELECT metadata FROM assets ORDER BY id').all() as { metadata: string }[]).map((row) => row.metadata).join(',')}]`
      : '[]';
    const assetBytes = Buffer.byteLength(assets);
    const snapshotBytes = Buffer.byteLength(snapshot);
    const requestBytes = Buffer.byteLength(encodedRequest);
    if (
      snapshotBytes + assetBytes > MODELING_JOB_LIMITS.snapshotBytes ||
      requestBytes > MODELING_JOB_LIMITS.requestBytes
    )
      throw new ApiError('MODELING_INPUT_LIMIT', 'Modeling snapshot or request exceeds its byte limit', 413, {
        snapshotBytes,
        requestBytes,
        assetBytes,
        limits: MODELING_JOB_LIMITS,
      });
    const reserved = snapshotBytes + requestBytes + assetBytes;
    const usage = this.store.db
      .prepare(
        'SELECT count(*) AS count,COALESCE(sum(reserved),0) AS bytes FROM modeling_jobs WHERE reserved>0',
      )
      .get() as { count: number; bytes: number };
    if (
      usage.count >= MODELING_JOB_LIMITS.unfinished ||
      usage.bytes + reserved > MODELING_JOB_LIMITS.reservedBytes
    )
      throw new ApiError(
        'MODELING_QUEUE_FULL',
        'Cancel or finish existing modeling jobs before starting another',
        429,
      );
    const now = new Date().toISOString();
    const job: ModelingJob = {
      id: randomUUID(),
      kind: request.kind,
      projectId: project.id,
      sourceRevision: project.revision,
      sourceContext: currentContext,
      requestId: request.requestId,
      status: 'queued',
      progress: {
        phase: 'queued',
        completedCommands: 0,
        totalCommands: request.kind === 'commands' ? request.commands.length : 0,
      },
      snapshotHash: modelingDigest(snapshot),
      requestHash,
      ...(assetJob ? { assetSnapshotHash: modelingDigest(assets) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db
        .prepare(
          'INSERT INTO modeling_jobs(id,project_id,document,snapshot,request,result,reserved,assets) VALUES(?,?,?,?,?,NULL,?,?)',
        )
        .run(job.id, job.projectId, JSON.stringify(job), snapshot, encodedRequest, reserved, assets);
      this.store.db
        .prepare(
          'INSERT INTO modeling_job_requests(project_id,request_id,fingerprint,job_id) VALUES(?,?,?,?)',
        )
        .run(job.projectId, job.requestId, requestHash, job.id);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    this.queue.push(job.id);
    this.notify(job);
    queueMicrotask(() => this.pump());
    return job;
  }

  startInspection(input: Omit<Extract<ModelingJobRequest, { kind: 'inspect' }>, 'kind'>): ModelingJob {
    return this.start({ ...input, kind: 'inspect' });
  }

  async cancel(id: string): Promise<ModelingJob> {
    const job = this.status(id);
    if (!['queued', 'running'].includes(job.status)) return job;
    this.queue = this.queue.filter((queued) => queued !== id);
    this.save({
      ...job,
      status: 'cancelled',
      progress: { ...job.progress, phase: 'finished' },
      finishedAt: new Date().toISOString(),
    });
    if (this.active?.id === id) {
      const active = this.active;
      active.settled = true;
      clearTimeout(active.timer);
      Atomics.store(active.cancellation, 0, 1);
      if (active.ready) await active.worker.terminate();
      else await active.exited;
      if (active.publishing) await active.publishing;
    }
    return this.status(id);
  }

  private fail(id: string, error: ModelingJobError) {
    const job = this.status(id);
    if (!['queued', 'running'].includes(job.status)) return;
    this.save({
      ...job,
      status: 'failed',
      error,
      progress: { ...job.progress, phase: 'finished' },
      finishedAt: new Date().toISOString(),
    });
  }

  private pump() {
    if (this.stopped || this.active) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.status(id);
    if (job.status !== 'queued') {
      queueMicrotask(() => this.pump());
      return;
    }
    try {
      const row = this.row(id);
      const cancellation = new Int32Array(new SharedArrayBuffer(4));
      const worker = createModelingWorker({
        snapshot: row.snapshot,
        request: row.request,
        snapshotHash: job.snapshotHash,
        requestHash: job.requestHash,
        cancellation: cancellation.buffer as SharedArrayBuffer,
        assets: row.assets,
        assetSnapshotHash: job.assetSnapshotHash,
      });
      const active: ActiveWorker = {
        id,
        worker,
        settled: false,
        ready: false,
        cancellation,
        exited: new Promise<void>((resolve) => worker.once('exit', () => resolve())),
        timer: setTimeout(() => {
          if (active.settled) return;
          active.settled = true;
          this.fail(id, {
            code: 'MODELING_TIMEOUT',
            message: `Modeling exceeded ${MODELING_JOB_LIMITS.timeoutMs / 1000} seconds`,
          });
          void worker.terminate();
        }, MODELING_JOB_LIMITS.timeoutMs),
      };
      this.active = active;
      this.save({
        ...job,
        status: 'running',
        startedAt: new Date().toISOString(),
        progress: { ...job.progress, phase: 'starting' },
      });
      worker.on('message', (message: ModelingWorkerMessage) => this.receive(active, message));
      worker.on('error', (error) => {
        if (!active.settled) {
          active.settled = true;
          this.fail(id, {
            code: 'MODELING_WORKER_FAILED',
            message: error.message,
            details: { name: error.name },
          });
        }
      });
      worker.on('exit', (code) => {
        clearTimeout(active.timer);
        if (!active.settled && !active.publishing)
          this.fail(id, {
            code: 'MODELING_WORKER_EXIT',
            message: `Modeling worker exited before returning a result (code ${code})`,
          });
        if (!active.publishing) {
          if (this.active === active) this.active = undefined;
          queueMicrotask(() => this.pump());
        }
      });
    } catch (error) {
      this.fail(id, {
        code: 'MODELING_WORKER_UNAVAILABLE',
        message:
          'Node could not start the modeling worker; check runtime worker permissions and tsx installation',
        details: jobError(error),
      });
      queueMicrotask(() => this.pump());
    }
  }

  private receive(active: ActiveWorker, message: ModelingWorkerMessage) {
    if (message.type === 'ready') {
      active.ready = true;
      if (active.settled || this.stopped) void active.worker.terminate();
      return;
    }
    if (active.settled || this.stopped || this.status(active.id).status !== 'running') return;
    try {
      if (message.type === 'asset-progress') {
        this.assetProgress(active, message.progress);
        return;
      }
      if (message.type === 'progress') {
        const job = this.status(active.id);
        if (
          !Number.isInteger(message.completed) ||
          message.completed < job.progress.completedCommands ||
          message.completed > job.progress.totalCommands ||
          message.total !== job.progress.totalCommands ||
          !['computing', 'validating'].includes(message.phase)
        )
          throw new ApiError('INVALID_WORKER_PROGRESS', 'Modeling worker returned invalid progress');
        this.save({
          ...job,
          progress: {
            ...job.progress,
            phase: 'computing',
            stage: message.phase,
            completedCommands: message.completed,
          },
        });
        return;
      }
      if (message.type === 'error') {
        active.settled = true;
        clearTimeout(active.timer);
        this.fail(active.id, message.error);
        return;
      }
      if (
        message.type !== 'result' ||
        typeof message.response !== 'string' ||
        Buffer.byteLength(message.response) + (message.bytes?.byteLength ?? 0) >
          MODELING_JOB_LIMITS.resultBytes
      )
        throw new ApiError('INVALID_WORKER_RESULT', 'Modeling worker returned an invalid result');
      const row = this.row(active.id);
      const job = JSON.parse(row.document) as ModelingJob;
      if (
        modelingDigest(row.snapshot) !== job.snapshotHash ||
        modelingDigest(row.request) !== job.requestHash ||
        message.snapshotHash !== job.snapshotHash ||
        message.requestHash !== job.requestHash ||
        message.assetSnapshotHash !== job.assetSnapshotHash ||
        (job.assetSnapshotHash && modelingDigest(row.assets) !== job.assetSnapshotHash) ||
        modelingDigest(message.response) !== message.responseHash
      )
        throw new ApiError(
          'WORKER_DIGEST_MISMATCH',
          'Modeling worker result does not match its stored immutable inputs',
        );
      const request = modelingJobRequestSchema.parse(JSON.parse(row.request));
      if (request.kind === 'conversion' || request.kind === 'export') {
        if (active.publishing)
          throw new ApiError('INVALID_WORKER_RESULT', 'An asset result was published more than once');
        active.publishing = this.finishAsset(active, job, request, message).finally(() => {
          clearTimeout(active.timer);
          if (this.active === active) this.active = undefined;
          queueMicrotask(() => this.pump());
        });
        return;
      }
      if (message.bytes)
        throw new ApiError('INVALID_WORKER_RESULT', 'This job kind cannot return binary geometry');
      active.settled = true;
      clearTimeout(active.timer);
      const response = JSON.parse(message.response) as CommandResponse;
      if (request.kind === 'inspect') {
        this.save(
          {
            ...job,
            status: 'completed',
            resultHash: message.responseHash,
            progress: { ...job.progress, phase: 'finished' },
            finishedAt: new Date().toISOString(),
          },
          message.response,
        );
        return;
      }
      if (
        !response.project ||
        response.project.id !== job.projectId ||
        response.project.revision !== job.sourceRevision + 1 ||
        !Array.isArray(response.results) ||
        response.results.length !== request.commands.length
      )
        throw new ApiError(
          'INVALID_WORKER_RESULT',
          'Modeling result revision or command result count is invalid',
        );
      this.save({
        ...job,
        progress: { ...job.progress, phase: 'committing', completedCommands: request.commands.length },
      });
      let published = false;
      const committed = this.commit(
        {
          jobId: job.id,
          snapshot: JSON.parse(row.snapshot) as Project,
          snapshotHash: job.snapshotHash,
          request,
          requestHash: job.requestHash,
          response,
          responseHash: message.responseHash,
        },
        (result) => {
          if (published)
            throw new ApiError('INVALID_COMMIT', 'Modeling commit attempted publication more than once');
          published = true;
          const encoded = JSON.stringify(result);
          this.save(
            {
              ...job,
              status: 'completed',
              resultHash: modelingDigest(encoded),
              progress: { ...job.progress, phase: 'finished', completedCommands: request.commands.length },
              finishedAt: new Date().toISOString(),
            },
            encoded,
            false,
          );
        },
      );
      if (!published || !committed || typeof (committed as { then?: unknown }).then === 'function')
        throw new ApiError(
          'INVALID_COMMIT',
          'Modeling commit must publish synchronously inside its transaction',
        );
      const completed = this.status(job.id);
      const { result: _result, ...document } = completed;
      this.notify(document);
    } catch (error) {
      active.settled = true;
      clearTimeout(active.timer);
      this.fail(active.id, jobError(error));
      void active.worker.terminate();
    }
  }

  private assetProgress(active: ActiveWorker, progress: ModelingAssetProgress) {
    const job = this.status(active.id);
    if (job.status !== 'running' || active.settled || this.stopped) return;
    const stages = ['reading', 'geometry', 'encoding', 'storing'];
    const previous = job.progress.asset;
    if (
      !['conversion', 'export'].includes(job.kind) ||
      !stages.includes(progress.stage) ||
      !Number.isInteger(progress.completed) ||
      !Number.isInteger(progress.total) ||
      progress.completed < 0 ||
      progress.total < 1 ||
      progress.total > 10000 ||
      progress.completed > progress.total ||
      (previous &&
        (stages.indexOf(progress.stage) < stages.indexOf(previous.stage) ||
          (previous.stage === progress.stage &&
            (progress.total !== previous.total || progress.completed < previous.completed))))
    )
      throw new ApiError('INVALID_WORKER_PROGRESS', 'Model asset progress is invalid or moved backwards');
    this.save({
      ...job,
      progress: {
        ...job.progress,
        phase: progress.stage === 'storing' ? 'committing' : 'computing',
        asset: progress,
      },
    });
  }

  private async finishAsset(
    active: ActiveWorker,
    job: ModelingJob,
    request: Extract<ModelingJobRequest, { kind: 'conversion' | 'export' }>,
    message: Extract<ModelingWorkerMessage, { type: 'result' }>,
  ) {
    try {
      const result = JSON.parse(message.response) as Record<string, unknown>;
      const resultContext = result.context as ModelingJob['sourceContext'] | undefined;
      if (
        result.projectId !== job.projectId ||
        result.revision !== job.sourceRevision ||
        resultContext?.sceneId !== job.sourceContext.sceneId ||
        resultContext?.performanceId !== job.sourceContext.performanceId
      )
        throw new ApiError(
          'INVALID_WORKER_RESULT',
          'Asset result does not match the requested project snapshot',
        );
      guardedModelProject(this.store, request);
      if (request.kind === 'conversion') {
        const mesh = result.mesh as { kind?: string; vertices?: unknown[]; faces?: unknown[] } | undefined;
        const asset = result.asset as { url?: string } | undefined;
        const object = this.store.project().objects.find((object) => object.id === request.objectId);
        if (
          message.bytes ||
          result.objectId !== request.objectId ||
          asset?.url !== object?.assetUrl ||
          mesh?.kind !== 'mesh' ||
          !Array.isArray(mesh.vertices) ||
          !Array.isArray(mesh.faces)
        )
          throw new ApiError(
            'INVALID_WORKER_RESULT',
            'Conversion result is not an editable mesh for the requested source asset',
          );
        this.save(
          {
            ...this.status(job.id),
            status: 'completed',
            resultHash: message.responseHash,
            progress: { ...this.status(job.id).progress, phase: 'finished' },
            finishedAt: new Date().toISOString(),
          },
          message.response,
        );
        active.settled = true;
        return;
      }
      if (
        !(message.bytes instanceof ArrayBuffer) ||
        result.bytes !== message.bytes.byteLength ||
        result.sourceTime !== request.sourceTime ||
        result.scope !== request.scope ||
        !Array.isArray(result.objectIds) ||
        !Array.isArray(result.hiddenObjectIds)
      )
        throw new ApiError(
          'INVALID_WORKER_RESULT',
          'Export result has invalid geometry metadata or binary data',
        );
      const bytes = Buffer.from(message.bytes);
      const current = this;
      const { kind: _kind, requestId: _requestId, ...input } = request;
      const published = await publishModelExport(
        this.store,
        this.config!,
        input,
        { bytes, metadata: result as PreparedModelExport['metadata'] },
        {
          signal: {
            get aborted() {
              return (
                active.settled ||
                current.stopped ||
                Atomics.load(active.cancellation, 0) !== 0 ||
                current.status(job.id).status !== 'running'
              );
            },
          },
          onProgress: (progress) => this.assetProgress(active, progress),
        },
        (response) => {
          const encoded = JSON.stringify(response);
          const currentJob = this.status(job.id);
          this.save(
            {
              ...currentJob,
              status: 'completed',
              resultHash: modelingDigest(encoded),
              progress: {
                ...currentJob.progress,
                phase: 'finished',
                asset: { stage: 'storing', completed: 1, total: 1 },
              },
              finishedAt: new Date().toISOString(),
            },
            encoded,
            false,
          );
        },
      );
      active.settled = true;
      const completed = this.status(job.id);
      if (
        completed.status !== 'completed' ||
        !completed.result ||
        (completed.result as { id?: string }).id !== published.id
      )
        throw new ApiError(
          'INVALID_COMMIT',
          'Asset import did not publish the completed job in its transaction',
        );
      const { result: _result, ...document } = completed;
      this.notify(document);
    } catch (error) {
      active.settled = true;
      this.fail(job.id, jobError(error));
      void active.worker.terminate();
    }
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const queued = [...this.queue];
    this.queue = [];
    for (const id of queued) await this.cancel(id);
    if (this.active) {
      const active = this.active;
      await this.cancel(active.id);
      if (active.ready) await active.worker.terminate();
      else await active.exited;
    }
  }
}
