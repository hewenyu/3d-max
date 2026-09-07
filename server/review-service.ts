import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  reviewCommentSchema,
  reviewInviteSchema,
  reviewPublishSchema,
  reviewUpdateSchema,
  type ReviewComment,
  type ReviewInvite,
  type ReviewPrincipal,
  type ReviewPublication,
} from '../shared/review';
import type { Store } from './store';
import type { ServerConfig } from './config';
import { ApiError } from './errors';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface DocumentRow {
  document: string;
}
interface InviteRow extends DocumentRow {
  token_hash: string;
  revoked: number;
}

export class ReviewService {
  constructor(
    readonly store: Store,
    readonly config: ServerConfig,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS review_publications (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_invites (
        id TEXT PRIMARY KEY, publication_id TEXT NOT NULL REFERENCES review_publications(id),
        token_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0, document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY, publication_id TEXT NOT NULL REFERENCES review_publications(id),
        document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_requests (
        publication_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, response TEXT NOT NULL,
        PRIMARY KEY(publication_id, actor_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS review_sessions (
        token_hash TEXT PRIMARY KEY, invite_id TEXT NOT NULL REFERENCES review_invites(id),
        expires_at INTEGER NOT NULL
      );
    `);
  }

  private transaction<T>(run: () => T) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.store.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }

  publications(): ReviewPublication[] {
    return (
      this.store.db
        .prepare('SELECT document FROM review_publications ORDER BY rowid DESC')
        .all() as unknown as DocumentRow[]
    ).map((row) => JSON.parse(row.document));
  }

  publication(id: string): ReviewPublication {
    const row = this.store.db.prepare('SELECT document FROM review_publications WHERE id=?').get(id) as
      DocumentRow | undefined;
    if (!row) throw new ApiError('NOT_FOUND', 'Review publication not found', 404);
    return JSON.parse(row.document);
  }

  publish(input: unknown) {
    const { jobId, title } = reviewPublishSchema.parse(input);
    const job = this.store.job(jobId);
    if (job.status !== 'completed') throw new ApiError('RENDER_NOT_READY', 'Publish a completed video', 409);
    const project = this.store.jobProject(jobId);
    const file = resolve(this.config.dataDir, 'renders', `${job.id}.mp4`);
    if (!existsSync(file)) throw new ApiError('NOT_FOUND', 'Rendered video file is missing', 404);
    const fps = job.options.fps ?? project.settings.fps;
    const publication: ReviewPublication = {
      id: randomUUID(),
      projectId: project.id,
      jobId,
      title,
      projectRevision: job.projectRevision,
      duration: job.totalFrames / fps,
      fps,
      createdAt: new Date().toISOString(),
    };
    this.store.db
      .prepare('INSERT INTO review_publications VALUES (?,?)')
      .run(publication.id, JSON.stringify(publication));
    return publication;
  }

  owner(publicationId: string): ReviewPrincipal {
    this.publication(publicationId);
    return { id: 'owner', name: '导演', role: 'owner', publicationId };
  }

  ownerDetails(publicationId: string) {
    const principal = this.owner(publicationId);
    return {
      principal,
      publication: this.publication(publicationId),
      comments: this.comments(principal),
      invites: this.invites(publicationId),
    };
  }

  invites(publicationId: string): ReviewInvite[] {
    this.publication(publicationId);
    return (
      this.store.db
        .prepare('SELECT document,revoked FROM review_invites WHERE publication_id=? ORDER BY rowid')
        .all(publicationId) as unknown as InviteRow[]
    ).map((row) => ({ ...JSON.parse(row.document), revoked: Boolean(row.revoked) }));
  }

  invite(publicationId: string, input: unknown) {
    this.publication(publicationId);
    const fields = reviewInviteSchema.parse(input);
    const token = randomBytes(32).toString('base64url');
    const invite: ReviewInvite = {
      id: randomUUID(),
      publicationId,
      ...fields,
      revoked: false,
      createdAt: new Date().toISOString(),
    };
    this.store.db
      .prepare('INSERT INTO review_invites VALUES (?,?,?,0,?)')
      .run(invite.id, publicationId, hash(token), JSON.stringify(invite));
    return { invite, token };
  }

  revoke(publicationId: string, inviteId: string) {
    this.publication(publicationId);
    const changed = this.store.db
      .prepare('UPDATE review_invites SET revoked=1 WHERE id=? AND publication_id=?')
      .run(inviteId, publicationId);
    if (!changed.changes) throw new ApiError('NOT_FOUND', 'Review participant not found', 404);
    this.store.db.prepare('DELETE FROM review_sessions WHERE invite_id=?').run(inviteId);
    return { id: inviteId, revoked: true };
  }

  authenticate(token: string | undefined, session = false): ReviewPrincipal {
    if (!token || token.length > 200)
      throw new ApiError('UNAUTHORIZED', 'A valid review invitation is required', 401);
    const row = session
      ? (this.store.db
          .prepare(
            `SELECT i.document,i.revoked FROM review_sessions s JOIN review_invites i ON i.id=s.invite_id
          WHERE s.token_hash=? AND s.expires_at>?`,
          )
          .get(hash(token), Date.now()) as InviteRow | undefined)
      : (this.store.db
          .prepare('SELECT document,revoked FROM review_invites WHERE token_hash=?')
          .get(hash(token)) as InviteRow | undefined);
    if (!row || row.revoked)
      throw new ApiError('UNAUTHORIZED', 'Review access has expired or been revoked', 401);
    const { id, name, role, publicationId } = JSON.parse(row.document) as ReviewInvite;
    return { id, name, role, publicationId };
  }

  login(token: string) {
    const principal = this.authenticate(token);
    const session = randomBytes(32).toString('base64url');
    this.store.db.prepare('DELETE FROM review_sessions WHERE expires_at<=?').run(Date.now());
    this.store.db
      .prepare('INSERT INTO review_sessions VALUES (?,?,?)')
      .run(hash(session), principal.id, Date.now() + 8 * 3600000);
    return { principal, session };
  }

  logout(session: string | undefined) {
    if (session) this.store.db.prepare('DELETE FROM review_sessions WHERE token_hash=?').run(hash(session));
  }

  comments(principal: ReviewPrincipal): ReviewComment[] {
    return (
      this.store.db
        .prepare('SELECT document FROM review_comments WHERE publication_id=? ORDER BY rowid')
        .all(principal.publicationId) as unknown as DocumentRow[]
    ).map((row) => JSON.parse(row.document));
  }

  private comment(publicationId: string, id: string): ReviewComment {
    const row = this.store.db
      .prepare('SELECT document FROM review_comments WHERE publication_id=? AND id=?')
      .get(publicationId, id) as DocumentRow | undefined;
    if (!row) throw new ApiError('NOT_FOUND', 'Review comment not found', 404);
    return JSON.parse(row.document);
  }

  private canWrite(principal: ReviewPrincipal) {
    if (principal.role === 'viewer')
      throw new ApiError('FORBIDDEN', 'This invitation only permits viewing', 403);
  }

  addComment(principal: ReviewPrincipal, input: unknown) {
    this.canWrite(principal);
    const { requestId, ...fields } = reviewCommentSchema.parse(input);
    const publication = this.publication(principal.publicationId);
    if (fields.time > publication.duration)
      throw new ApiError('INVALID_TIME', 'Comment time is outside the video');
    if (fields.replyTo && this.comment(publication.id, fields.replyTo).replyTo)
      throw new ApiError('INVALID_REPLY', 'Reply to the thread root');
    const fingerprint = hash(JSON.stringify(fields));
    return this.transaction(() => {
      const previous = this.store.db
        .prepare(
          'SELECT fingerprint,response FROM review_requests WHERE publication_id=? AND actor_id=? AND request_id=?',
        )
        .get(publication.id, principal.id, requestId) as
        { fingerprint: string; response: string } | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ApiError('REQUEST_CONFLICT', 'Request ID was used with different comment content', 409);
        return JSON.parse(previous.response) as ReviewComment;
      }
      const now = new Date().toISOString();
      const comment: ReviewComment = {
        id: randomUUID(),
        publicationId: publication.id,
        ...fields,
        author: { id: principal.id, name: principal.name },
        status: 'open',
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      const document = JSON.stringify(comment);
      this.store.db
        .prepare('INSERT INTO review_comments VALUES (?,?,?)')
        .run(comment.id, publication.id, document);
      this.store.db
        .prepare('INSERT INTO review_requests VALUES (?,?,?,?,?)')
        .run(publication.id, principal.id, requestId, fingerprint, document);
      return comment;
    });
  }

  updateComment(principal: ReviewPrincipal, input: unknown) {
    this.canWrite(principal);
    const { id, expectedVersion, ...patch } = reviewUpdateSchema.parse(input);
    return this.transaction(() => {
      const comment = this.comment(principal.publicationId, id);
      if (comment.author.id !== principal.id && principal.role !== 'owner')
        throw new ApiError('FORBIDDEN', 'Only the author or director can edit this comment', 403);
      if (comment.version !== expectedVersion)
        throw new ApiError('REVISION_CONFLICT', 'The comment changed; reload before editing', 409, {
          comment,
        });
      if (patch.status !== undefined && comment.replyTo)
        throw new ApiError('INVALID_REPLY', 'Resolve or reopen the thread root');
      const next = {
        ...comment,
        ...patch,
        version: comment.version + 1,
        updatedAt: new Date().toISOString(),
      };
      this.store.db.prepare('UPDATE review_comments SET document=? WHERE id=?').run(JSON.stringify(next), id);
      return next;
    });
  }
}
