import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  captureTemplate,
  templateCaptureSchema,
  templateContentSchema,
  type TemplateContent,
  type TemplateSummary,
} from '../shared/templates';
import type { Store } from './store';
import { ApiError } from './errors';

const identifier = z.string().min(1).max(200);
export const templateSaveSchema = templateCaptureSchema
  .extend({
    projectId: identifier,
    expectedRevision: z.number().int().min(0),
    requestId: identifier.optional(),
  })
  .strict();
export const templateUpdateSchema = z
  .object({
    id: identifier,
    expectedRevision: z.number().int().min(0),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000),
  })
  .strict();
export const templateIdSchema = z.object({ id: identifier }).strict();
interface TemplateRow {
  id: string;
  document: string;
  revision: number;
  updated_at: string;
}

function initialize(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS template_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL);
  `);
}

function summary(row: TemplateRow): TemplateSummary {
  const content = JSON.parse(row.document) as TemplateContent;
  return {
    id: row.id,
    name: content.name,
    description: content.description,
    kind: content.kind,
    objectCount: content.project.objects.length,
    shotCount: content.project.shots.length,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export function listTemplates(store: Store): TemplateSummary[] {
  initialize(store);
  return (
    store.db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all() as unknown as TemplateRow[]
  ).map(summary);
}

export function getTemplate(store: Store, id: string) {
  initialize(store);
  const row = store.db.prepare('SELECT * FROM templates WHERE id=?').get(id) as TemplateRow | undefined;
  if (!row) throw new ApiError('NOT_FOUND', 'Template not found', 404);
  return { ...summary(row), content: templateContentSchema.parse(JSON.parse(row.document)) };
}

export function saveTemplate(store: Store, input: unknown) {
  initialize(store);
  const { projectId, expectedRevision, requestId, ...options } = templateSaveSchema.parse(input);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ projectId, expectedRevision, ...options }))
    .digest('hex');
  if (requestId) {
    const cached = store.db
      .prepare('SELECT fingerprint,response FROM template_requests WHERE request_id=?')
      .get(requestId) as { fingerprint: string; response: string } | undefined;
    if (cached) {
      if (cached.fingerprint !== fingerprint)
        throw new ApiError('IDEMPOTENCY_CONFLICT', 'Template request ID was used with different inputs', 409);
      return JSON.parse(cached.response) as TemplateSummary;
    }
  }
  const project = store.project();
  if (project.id !== projectId)
    throw new ApiError('PROJECT_CONFLICT', 'The active project changed before saving the template', 409);
  if (project.revision !== expectedRevision)
    throw new ApiError('REVISION_CONFLICT', 'The project changed before saving the template', 409);
  const content = captureTemplate(project, options);
  store.assertAssets(content.project);
  const row: TemplateRow = {
    id: randomUUID(),
    document: JSON.stringify(content),
    revision: 0,
    updated_at: new Date().toISOString(),
  };
  const result = summary(row);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db
      .prepare('INSERT INTO templates VALUES(?,?,?,?)')
      .run(row.id, row.document, row.revision, row.updated_at);
    if (requestId)
      store.db
        .prepare('INSERT INTO template_requests VALUES(?,?,?)')
        .run(requestId, fingerprint, JSON.stringify(result));
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return result;
}

export function updateTemplate(store: Store, input: unknown) {
  const { id, expectedRevision, name, description } = templateUpdateSchema.parse(input);
  const current = getTemplate(store, id);
  if (current.revision !== expectedRevision)
    throw new ApiError('REVISION_CONFLICT', 'The template changed before editing', 409);
  const content = { ...current.content, name, description };
  const changed = store.db
    .prepare('UPDATE templates SET document=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
    .run(JSON.stringify(content), new Date().toISOString(), id, expectedRevision);
  if (!changed.changes) throw new ApiError('REVISION_CONFLICT', 'The template changed before editing', 409);
  return getTemplate(store, id);
}

export function deleteTemplate(store: Store, input: unknown) {
  const { id } = templateIdSchema.parse(input);
  getTemplate(store, id);
  store.db.prepare('DELETE FROM templates WHERE id=?').run(id);
  return { id, deleted: true };
}
