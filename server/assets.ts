import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import multer from 'multer';
import type { Express } from 'express';
import type { Store, AssetRecord } from './store.ts';
import type { ServerConfig } from './config.ts';
import { ApiError } from './errors.ts';

const exec = promisify(execFile);
const types: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

export async function validateModel(bytes: Buffer, extension: string, store: Store) {
  let document: { buffers?: { uri?: string }[]; images?: { uri?: string }[]; asset?: { version?: string } };
  try {
    if (extension === '.glb') {
      if (
        bytes.length < 20 ||
        bytes.toString('ascii', 0, 4) !== 'glTF' ||
        bytes.readUInt32LE(4) !== 2 ||
        bytes.readUInt32LE(8) !== bytes.length ||
        bytes.readUInt32LE(16) !== 0x4e4f534a
      )
        throw new Error('Invalid GLB header');
      const size = bytes.readUInt32LE(12);
      if (20 + size > bytes.length) throw new Error('Truncated GLB');
      document = JSON.parse(bytes.toString('utf8', 20, 20 + size));
    } else document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ApiError('INVALID_MODEL', 'Upload a valid glTF 2.0 or GLB file');
  }
  if (document.asset?.version !== '2.0')
    throw new ApiError('INVALID_MODEL', 'Only glTF 2.0 models are supported');
  for (const item of [...(document.buffers || []), ...(document.images || [])]) {
    if (
      item.uri &&
      !/^data:(application\/octet-stream|application\/gltf-buffer|image\/(png|jpeg|webp));base64,[A-Za-z0-9+/=\s]+$/.test(
        item.uri,
      ) &&
      !store.assetByUrl(item.uri)
    )
      throw new ApiError(
        'EXTERNAL_ASSET',
        'Model resources must be embedded or reference uploaded local assets',
      );
  }
}

export function installAssetRoutes(app: Express, config: ServerConfig, store: Store) {
  const upload = multer({
    dest: resolve(config.dataDir, 'assets'),
    limits: { fileSize: 100 * 1024 * 1024, files: 1 },
    fileFilter: (_request, file, done) => {
      if (!types[extname(file.originalname).toLowerCase()])
        return done(
          new ApiError(
            'UNSUPPORTED_ASSET',
            'Supported files: GLB, glTF, MP3, WAV, M4A, AAC, OGG, FLAC and WebM',
          ),
        );
      done(null, true);
    },
  });
  app.post('/api/assets', upload.single('file'), async (request, response) => {
    const file = request.file;
    if (!file) throw new ApiError('MISSING_FILE', 'Select a file to upload');
    const extension = extname(file.originalname).toLowerCase();
    const id = randomUUID();
    const path = resolve(config.dataDir, 'assets', id + extension);
    let duration: number | undefined;
    try {
      if (extension === '.glb' || extension === '.gltf')
        await validateModel(await readFile(file.path), extension, store);
      else {
        const { stdout } = await exec(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file.path],
          { timeout: 15000, maxBuffer: 1024 * 1024 },
        );
        const info = JSON.parse(stdout) as {
          format?: { duration?: string };
          streams?: { codec_type: string }[];
        };
        duration = Number(info.format?.duration);
        if (
          !info.streams?.some((stream) => stream.codec_type === 'audio') ||
          !Number.isFinite(duration) ||
          duration <= 0
        )
          throw new ApiError('INVALID_AUDIO', 'The uploaded file must contain a decodable audio track');
      }
      await rename(file.path, path);
      const asset: AssetRecord = {
        id,
        name: file.originalname,
        path,
        mime: types[extension],
        size: file.size,
        url: `/api/assets/${id}/file`,
        ...(duration === undefined ? {} : { duration }),
      };
      store.addAsset(asset);
      response
        .status(201)
        .json({ id, name: asset.name, url: asset.url, ...(duration === undefined ? {} : { duration }) });
    } catch (error) {
      await unlink(file.path).catch(() => {});
      await unlink(path).catch(() => {});
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        'INVALID_ASSET',
        'Unable to read asset; verify the file format and FFmpeg installation',
      );
    }
  });
  app.get('/api/assets/:id/file', (request, response) => {
    const asset = store.asset(String(request.params.id));
    if (!asset) throw new ApiError('NOT_FOUND', 'Asset not found', 404);
    response
      .type(asset.mime)
      .set('X-Content-Type-Options', 'nosniff')
      .sendFile(asset.path, { dotfiles: 'allow' });
  });
}
