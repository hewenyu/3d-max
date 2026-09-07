import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Express } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { ServerConfig } from './config';
import type { Store } from './store';
import { ApiError } from './errors';
import { exportProjectPackage, importProjectPackage } from './project-packages';

export const packageExportSchema = z
  .object({
    projectId: z.string().min(1).max(160).optional(),
    includeHistory: z.boolean().default(true),
    includeVideos: z.boolean().default(true),
  })
  .strict();

export async function saveProjectPackage(store: Store, config: ServerConfig, input: unknown) {
  const options = packageExportSchema.parse(input);
  const result = await exportProjectPackage(store, config, options);
  const id = randomUUID();
  const directory = resolve(config.dataDir, 'packages');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${id}.whiteframe`);
  await writeFile(path, result.data, { flag: 'wx' });
  const { data: _data, ...details } = result;
  const record = {
    id,
    ...details,
    size: result.data.length,
    createdAt: new Date().toISOString(),
    url: `/api/packages/${id}/file`,
  };
  try {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS project_packages (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)',
    );
    store.db.prepare('INSERT INTO project_packages(id,metadata) VALUES(?,?)').run(id, JSON.stringify(record));
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
  return record;
}

export function installPackageRoutes(app: Express, config: ServerConfig, store: Store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS project_packages (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)');
  const upload = multer({
    dest: resolve(config.dataDir, 'assets'),
    limits: { fileSize: 512 * 1024 * 1024, files: 1 },
  });
  app.post('/api/packages/export', async (request, response) =>
    response.status(201).json(await saveProjectPackage(store, config, request.body)),
  );
  app.get('/api/packages/:id/file', (request, response) => {
    const id = String(request.params.id);
    const row = store.db.prepare('SELECT metadata FROM project_packages WHERE id=?').get(id) as
      { metadata: string } | undefined;
    if (!row || !/^[a-f0-9-]{36}$/.test(id))
      throw new ApiError('NOT_FOUND', 'Project package not found', 404);
    response
      .type('application/gzip')
      .attachment(`whiteframe-${id.slice(0, 8)}.whiteframe`)
      .sendFile(resolve(config.dataDir, 'packages', `${id}.whiteframe`), { dotfiles: 'allow' });
  });
  app.post('/api/packages/import', upload.single('file'), async (request, response) => {
    if (!request.file) throw new ApiError('MISSING_FILE', 'Select a Whiteframe project package');
    try {
      response.status(201).json(await importProjectPackage(store, config, await readFile(request.file.path)));
    } finally {
      await unlink(request.file.path).catch(() => {});
    }
  });
}
