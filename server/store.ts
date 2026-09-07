import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type { CommandRequest, CommandResponse, Project, RenderJob } from '../shared/types.ts';
import { applyCommands, validateProject } from '../shared/commands.ts';
import { createDemoProject, createEmptyProject } from '../shared/project.ts';
import { ApiError } from './errors.ts';
import { assertModelAnimation } from './model-service';

export interface AssetRecord {
  id: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  duration?: number;
  url: string;
}

interface ProjectRow {
  id: string;
  document: string;
  cursor: number;
}
interface SnapshotRow {
  snapshot: string;
}
interface RequestRow {
  fingerprint: string;
  response: string;
}

export class Store extends EventEmitter {
  readonly db: DatabaseSync;
  readonly token: string;

  constructor(dataDir: string, token?: string) {
    super();
    this.db = new DatabaseSync(resolve(dataDir, 'whiteframe.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, document TEXT NOT NULL, cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history (project_id TEXT NOT NULL, position INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(project_id, position));
      CREATE TABLE IF NOT EXISTS requests (project_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(project_id, request_id));
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS render_jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS render_requests (project_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(project_id, request_id));
    `);
    const storedToken = this.meta('mcp_token');
    this.token = token || storedToken || randomBytes(32).toString('hex');
    if (!storedToken && !token) this.setMeta('mcp_token', this.token);
    if (!this.meta('active_project')) this.install(createDemoProject());
    for (const job of this.jobs()) {
      if (['queued', 'rendering', 'encoding'].includes(job.status))
        this.updateJob({ ...job, status: 'failed', error: 'Server restarted before export completed' });
    }
  }

  close() {
    this.db.close();
  }

  private meta(key: string) {
    return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)
      ?.value;
  }

  private setMeta(key: string, value: string) {
    this.db
      .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  project(): Project {
    const row = this.db
      .prepare('SELECT document FROM projects WHERE id=?')
      .get(this.meta('active_project')!) as { document: string };
    return JSON.parse(row.document) as Project;
  }

  projects() {
    return (
      this.db
        .prepare("SELECT document FROM projects ORDER BY json_extract(document,'$.updatedAt') DESC")
        .all() as { document: string }[]
    ).map((row) => {
      const { id, name, sceneName, revision, updatedAt } = JSON.parse(row.document) as Project;
      return { id, name, sceneName, revision, updatedAt };
    });
  }

  openProject(id: string) {
    const project = this.transaction(() => {
      const row = this.db.prepare('SELECT document FROM projects WHERE id=?').get(id) as
        { document: string } | undefined;
      if (!row) throw new ApiError('NOT_FOUND', 'Project not found', 404);
      this.setMeta('active_project', id);
      return JSON.parse(row.document) as Project;
    });
    this.emit('project', project);
    return project;
  }

  private install(project: Project) {
    this.db
      .prepare('INSERT INTO projects(id,document,cursor) VALUES(?,?,0)')
      .run(project.id, JSON.stringify(project));
    this.db
      .prepare('INSERT INTO history(project_id,position,snapshot) VALUES(?,0,?)')
      .run(project.id, JSON.stringify(project));
    this.setMeta('active_project', project.id);
  }

  assertAssets(project: Project) {
    for (const object of [
      ...project.objects,
      ...(project.production?.scenes.flatMap((scene) => scene.objects) ?? []),
    ]) {
      const asset = object.assetUrl ? this.assetByUrl(object.assetUrl) : undefined;
      if (object.type === 'model' && asset) assertModelAnimation(asset, object);
    }
    for (const { url, kind } of [
      ...project.objects.map((object) => ({ url: object.assetUrl, kind: 'model/' })),
      ...project.audio.map((clip) => ({ url: clip.url, kind: 'audio/' })),
      ...(project.production?.scenes.flatMap((scene) => [
        ...scene.objects.map((object) => ({ url: object.assetUrl, kind: 'model/' })),
        ...scene.performances.flatMap((take) =>
          take.audio.map((clip) => ({ url: clip.url, kind: 'audio/' })),
        ),
      ]) ?? []),
    ]) {
      if (url && !this.assetByUrl(url)?.mime.startsWith(kind))
        throw new ApiError('INVALID_ASSET', 'Project references an unavailable local asset', 400, { url });
    }
  }

  private save(project: Project, cursor: number) {
    this.db.prepare('DELETE FROM history WHERE project_id=? AND position>?').run(project.id, cursor);
    this.db
      .prepare('INSERT INTO history(project_id,position,snapshot) VALUES(?,?,?)')
      .run(project.id, cursor + 1, JSON.stringify(project));
    this.db
      .prepare('UPDATE projects SET document=?,cursor=? WHERE id=?')
      .run(JSON.stringify(project), cursor + 1, project.id);
  }

  cachedCommands(projectId: string, requestId: string, fingerprint: string): CommandResponse | undefined {
    const cached = this.db
      .prepare('SELECT fingerprint,response FROM requests WHERE project_id=? AND request_id=?')
      .get(projectId, requestId) as RequestRow | undefined;
    if (!cached) return undefined;
    if (cached.fingerprint !== fingerprint)
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'This requestId was already used with different commands',
        409,
      );
    return { ...(JSON.parse(cached.response) as CommandResponse), replayed: true };
  }

  // Computed operations fingerprint their validated inputs before producing editable commands.
  commands(
    request: CommandRequest & { projectId?: string },
    inputFingerprint?: string,
    generatedAssets: AssetRecord[] = [],
  ): CommandResponse {
    if (
      !request ||
      !Array.isArray(request.commands) ||
      !request.commands.length ||
      request.commands.length > 200
    )
      throw new ApiError('INVALID_COMMANDS', 'Provide between 1 and 200 commands');
    if (
      request.commands.some(
        (command) =>
          !command ||
          typeof command.type !== 'string' ||
          !command.payload ||
          typeof command.payload !== 'object' ||
          Array.isArray(command.payload),
      )
    )
      throw new ApiError('INVALID_COMMANDS', 'Each command requires a type and an object payload');
    if (
      request.requestId !== undefined &&
      (typeof request.requestId !== 'string' || request.requestId.length > 200 || !request.requestId.length)
    )
      throw new ApiError('INVALID_REQUEST_ID', 'requestId must contain 1 to 200 characters');
    if (
      request.expectedRevision !== undefined &&
      (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)
    )
      throw new ApiError('INVALID_REVISION', 'expectedRevision must be a non-negative integer');
    if (
      request.projectId !== undefined &&
      (typeof request.projectId !== 'string' || !request.projectId || request.projectId.length > 200)
    )
      throw new ApiError('INVALID_PROJECT_ID', 'projectId must contain 1 to 200 characters');
    const fingerprint =
      inputFingerprint ?? createHash('sha256').update(JSON.stringify(request.commands)).digest('hex');
    const result: CommandResponse = this.transaction(() => {
      const current = this.project();
      if (request.projectId !== undefined && request.projectId !== current.id)
        throw new ApiError(
          'PROJECT_CONFLICT',
          'The active project changed; read the current project before editing',
          409,
          { expected: request.projectId, actual: current.id, project: current },
        );
      if (request.requestId) {
        const cached = this.cachedCommands(current.id, request.requestId, fingerprint);
        if (cached) return cached;
      }
      if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision)
        throw new ApiError(
          'REVISION_CONFLICT',
          'Project changed; read the latest state before editing',
          409,
          { expected: request.expectedRevision, actual: current.revision, project: current },
        );
      if (request.expectedContext !== undefined) {
        const context = request.expectedContext;
        if (
          !context ||
          typeof context !== 'object' ||
          Array.isArray(context) ||
          Object.keys(context).some((key) => !['sceneId', 'performanceId'].includes(key)) ||
          [context.sceneId, context.performanceId].some(
            (id) => id !== null && (typeof id !== 'string' || !id || id.length > 160),
          )
        )
          throw new ApiError(
            'INVALID_CONTEXT',
            'Expected context must contain sceneId and performanceId identifiers or null',
          );
        if (
          context.sceneId !== (current.production?.activeSceneId ?? null) ||
          context.performanceId !== (current.production?.activePerformanceId ?? null)
        )
          throw new ApiError(
            'CONTEXT_CONFLICT',
            'The active scene or performance changed; reload before editing',
            409,
            { project: current },
          );
      }
      const response = applyCommands(current, request.commands);
      for (const asset of generatedAssets) this.addAsset(asset);
      this.assertAssets(response.project);
      response.project.revision = current.revision + 1;
      response.project.updatedAt = new Date().toISOString();
      const row = this.db.prepare('SELECT cursor FROM projects WHERE id=?').get(current.id) as {
        cursor: number;
      };
      this.save(response.project, row.cursor);
      if (request.requestId)
        this.db
          .prepare('INSERT INTO requests(project_id,request_id,fingerprint,response) VALUES(?,?,?,?)')
          .run(current.id, request.requestId, fingerprint, JSON.stringify(response));
      return response;
    });
    if (!result.replayed) this.emit('project', result.project);
    return result;
  }

  newProject(name: string, template: 'empty' | 'demo') {
    const project = template === 'demo' ? createDemoProject() : createEmptyProject();
    project.name = name.trim() || project.name;
    this.transaction(() => this.install(project));
    this.emit('project', project);
    return project;
  }

  importProject(input: unknown) {
    const project = validateProject(input);
    this.assertAssets(project);
    project.id = randomUUID();
    project.revision = 0;
    project.updatedAt = new Date().toISOString();
    this.transaction(() => this.install(project));
    this.emit('project', project);
    return project;
  }

  history() {
    const project = this.project();
    const row = this.db.prepare('SELECT cursor FROM projects WHERE id=?').get(project.id) as {
      cursor: number;
    };
    const next = this.db
      .prepare('SELECT 1 FROM history WHERE project_id=? AND position=?')
      .get(project.id, row.cursor + 1);
    return { canUndo: row.cursor > 0, canRedo: Boolean(next) };
  }

  travel(direction: -1 | 1, expected: { projectId?: string; expectedRevision?: number } = {}) {
    const project = this.transaction(() => {
      const current = this.project();
      if (expected.projectId !== undefined && expected.projectId !== current.id)
        throw new ApiError(
          'PROJECT_CONFLICT',
          'The active project changed; reload before changing history',
          409,
          { project: current },
        );
      if (expected.expectedRevision !== undefined && expected.expectedRevision !== current.revision)
        throw new ApiError('REVISION_CONFLICT', 'Project changed; reload before changing history', 409, {
          project: current,
        });
      const row = this.db
        .prepare('SELECT * FROM projects WHERE id=?')
        .get(current.id) as unknown as ProjectRow;
      const position = row.cursor + direction;
      const target = this.db
        .prepare('SELECT snapshot FROM history WHERE project_id=? AND position=?')
        .get(current.id, position) as SnapshotRow | undefined;
      if (!target)
        throw new ApiError('HISTORY_EMPTY', direction < 0 ? 'Nothing to undo' : 'Nothing to redo', 409);
      const next = JSON.parse(target.snapshot) as Project;
      next.revision = current.revision + 1;
      next.updatedAt = new Date().toISOString();
      this.db
        .prepare('UPDATE projects SET document=?,cursor=? WHERE id=?')
        .run(JSON.stringify(next), position, next.id);
      return next;
    });
    this.emit('project', project);
    return project;
  }

  addAsset(asset: AssetRecord) {
    this.db.prepare('INSERT INTO assets(id,metadata) VALUES(?,?)').run(asset.id, JSON.stringify(asset));
  }
  asset(id: string): AssetRecord | undefined {
    const row = this.db.prepare('SELECT metadata FROM assets WHERE id=?').get(id) as
      { metadata: string } | undefined;
    return row ? (JSON.parse(row.metadata) as AssetRecord) : undefined;
  }
  assetByUrl(url: string) {
    const match = /^\/api\/assets\/([a-zA-Z0-9-]+)\/file$/.exec(url);
    return match ? this.asset(match[1]) : undefined;
  }
  cachedRender(projectId: string, requestId: string, fingerprint: string) {
    const row = this.db
      .prepare('SELECT fingerprint,job_id FROM render_requests WHERE project_id=? AND request_id=?')
      .get(projectId, requestId) as { fingerprint: string; job_id: string } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint)
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'This export requestId was already used with different options',
        409,
      );
    return this.job(row.job_id);
  }
  addJob(job: RenderJob, project: Project, request?: { id: string; fingerprint: string }) {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO render_jobs(id,document,snapshot) VALUES(?,?,?)')
        .run(job.id, JSON.stringify(job), JSON.stringify(project));
      if (request)
        this.db
          .prepare('INSERT INTO render_requests(project_id,request_id,fingerprint,job_id) VALUES(?,?,?,?)')
          .run(project.id, request.id, request.fingerprint, job.id);
    });
    this.emit('render', job);
  }
  updateJob(job: RenderJob) {
    this.db.prepare('UPDATE render_jobs SET document=? WHERE id=?').run(JSON.stringify(job), job.id);
    this.emit('render', job);
  }
  job(id: string): RenderJob {
    const row = this.db.prepare('SELECT document FROM render_jobs WHERE id=?').get(id) as
      { document: string } | undefined;
    if (!row) throw new ApiError('NOT_FOUND', 'Export task not found', 404);
    return JSON.parse(row.document) as RenderJob;
  }
  jobProject(id: string): Project {
    const row = this.db.prepare('SELECT snapshot FROM render_jobs WHERE id=?').get(id) as
      SnapshotRow | undefined;
    if (!row) throw new ApiError('NOT_FOUND', 'Export task not found', 404);
    return JSON.parse(row.snapshot) as Project;
  }
  jobs() {
    return (
      this.db.prepare('SELECT document FROM render_jobs ORDER BY rowid DESC LIMIT 100').all() as {
        document: string;
      }[]
    ).map((row) => JSON.parse(row.document) as RenderJob);
  }
}
