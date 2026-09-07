import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Project } from '../../shared/types';
import { fileHash, verifyFrozenManifest } from './verify-frozen-manifest';

const run = promisify(execFile);
const optionsSchema = z
  .object({
    shotId: z.string().min(1),
    fps: z.number().positive(),
    resolution: z.number().positive(),
    aspect: z.string().min(1),
    includeAudio: z.boolean(),
    burnIn: z.boolean(),
  })
  .strict();
const baselineSchema = z
  .object({
    baselineManifest: z.string().min(1),
    baselineVideo: z.string().min(1),
    baselineVideoSha256: z.string().regex(/^[a-f0-9]{64}$/),
    shotId: z.string().min(1),
    projectContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    renderOptions: optionsSchema,
  })
  .strict();
export type RenderBaseline = z.infer<typeof baselineSchema>;

export function projectContentHash(project: Project) {
  const { id: _id, revision: _revision, updatedAt: _updatedAt, ...content } = project;
  return fileHash(JSON.stringify(content));
}

export async function loadRenderBaselines(path?: string): Promise<Record<string, RenderBaseline>> {
  if (!path) return {};
  const directory = dirname(resolve(path));
  const input = z.record(baselineSchema).parse(JSON.parse(await readFile(path, 'utf8')));
  return Object.fromEntries(
    Object.entries(input).map(([theme, baseline]) => [
      theme,
      {
        ...baseline,
        baselineManifest: resolve(directory, baseline.baselineManifest),
        baselineVideo: resolve(directory, baseline.baselineVideo),
      },
    ]),
  );
}

export async function verifyRenderComparison(input: {
  ssim: number;
  video: string;
  project: Project;
  renderOptions: z.infer<typeof optionsSchema>;
  expectedFrames: number;
  directory: string;
  baseline?: RenderBaseline;
}) {
  if (input.ssim > 0.999)
    return { acceptance: 'accepted-full-film-ssim', threshold: 0.999, ssim: input.ssim };
  assert.ok(input.ssim >= 0.98, `Re-export differs from accepted full film: SSIM ${input.ssim}`);
  assert.ok(input.baseline, `SSIM ${input.ssim} requires an explicit verified same-shot render baseline`);
  const baseline = input.baseline;
  assert.equal(baseline.shotId, input.renderOptions.shotId);
  assert.deepEqual(baseline.renderOptions, input.renderOptions, 'Baseline render options differ');
  assert.equal(
    baseline.projectContentHash,
    projectContentHash(input.project),
    'Baseline project content differs',
  );
  const manifest = await verifyFrozenManifest(baseline.baselineManifest);
  const baselineBytes = await readFile(baseline.baselineVideo);
  assert.equal(
    fileHash(baselineBytes),
    baseline.baselineVideoSha256,
    'Baseline video differs from calibration',
  );
  const candidateBytes = await readFile(input.video);
  const frames = async (path: string, name: string) => {
    const result = await run('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0', '-f', 'framemd5', '-'], {
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
    await writeFile(resolve(input.directory, `${name}-framemd5.txt`), result.stdout);
    const rows = result.stdout.split('\n').filter((line) => line && !line.startsWith('#'));
    assert.equal(rows.length, input.expectedFrames, `${name} decoded frame count differs`);
    return rows;
  };
  const originalFrames = await frames(baseline.baselineVideo, 'baseline');
  const candidateFrames = await frames(input.video, 'candidate');
  // Independently encoded interior shots can differ from a full-film GOP while matching a prior renderer exactly.
  assert.deepEqual(
    candidateFrames,
    originalFrames,
    'Decoded frames differ from the verified same-shot baseline',
  );
  return {
    acceptance: 'verified-same-shot-baseline',
    ssim: input.ssim,
    fullFilmSimilarityFloor: 0.98,
    reason:
      'Independent shot encoding differs from the accepted full-film encoding context; all decoded frames match the verified prior same-shot render.',
    baselineManifest: baseline.baselineManifest,
    baselineSourceHash: manifest.sourceHash,
    baselineVerifiedSourceFiles: manifest.verifiedSourceFiles,
    baselineVideo: baseline.baselineVideo,
    baselineVideoSha256: baseline.baselineVideoSha256,
    candidateVideoSha256: fileHash(candidateBytes),
    videoBytesIdentical: candidateBytes.equals(baselineBytes),
    decodedFrames: candidateFrames.length,
    differentDecodedFrames: 0,
    decodedFrameHashAlgorithm: 'MD5',
    baselineDecodedFrameListSha256: fileHash(originalFrames.join('\n')),
    candidateDecodedFrameListSha256: fileHash(candidateFrames.join('\n')),
    projectContentHash: baseline.projectContentHash,
    renderOptions: baseline.renderOptions,
  };
}
