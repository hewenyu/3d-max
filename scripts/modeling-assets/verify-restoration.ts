import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readPackageRecords } from '../../server/package-codec';
import { validateProject } from '../../shared/schema';
import type { Project, RenderJob } from '../../shared/types';
import { ModelingAssetClient } from './client';
import { digest } from './design';
import { createHash } from 'node:crypto';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4224' },
    name: { type: 'string' },
    source: { type: 'string' },
    state: { type: 'string' },
    phase: { type: 'string', default: 'import' },
  },
});
if (!values.name || !values.source || !['import', 'restart'].includes(values.phase))
  throw new Error('Supply --name, --source artifact directory, and --phase import or restart');
if (values.phase === 'restart' && !values.state)
  throw new Error('Restart verification requires the saved --state file');
assert.match(values.name, /^[a-z0-9-]+$/);
const author = new ModelingAssetClient(`${values.name}-${values.phase}`, values.api);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const content = (project: Project) => {
  const { id: _id, revision: _revision, updatedAt: _updated, ...rest } = project;
  return rest;
};

async function packageFacts(bytes: Buffer) {
  let project: Project | undefined;
  let cursor = -1;
  const history: string[] = [];
  const assets: { id: string; url: string; sha256: string }[] = [];
  for await (const record of readPackageRecords(bytes)) {
    if (record.type === 'header') {
      project = validateProject(record.value.project);
      cursor = record.value.cursor;
    }
    if (record.type === 'history') history.push(digest(content(validateProject(record.value.snapshot))));
    if (record.type === 'asset') {
      assert.equal(hash(Buffer.from(record.value.file.data, 'base64')), record.value.file.sha256);
      assets.push({ id: record.value.id, url: record.value.url, sha256: record.value.file.sha256 });
    }
  }
  assert.ok(project);
  assert.ok(history.length > 1);
  return { project, cursor, history, assets };
}
async function bytes(url: string) {
  const address = new URL(url, values.api);
  assert.equal(address.origin, new URL(values.api).origin);
  const response = await fetch(address);
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}
async function historyFacts() {
  const exported = await author.call<{ downloadUrl: string }>('project_package_export', {
    projectId: author.project.id,
    includeHistory: true,
    includeVideos: false,
  });
  return packageFacts(await bytes(exported.downloadUrl));
}

try {
  const packagePath = resolve(values.source, `${values.name}.whiteframe`);
  const input = await readFile(packagePath);
  const source = await packageFacts(input);
  const sourceVideo = hash(await readFile(resolve(values.source, `${values.name}.mp4`)));
  const baselineGlb = hash(await readFile(resolve(values.source, `${values.name}.glb`)));
  let baselinePath = resolve(values.source, 'angle-1.png');
  const baseline = await readFile(baselinePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    baselinePath = resolve(values.source!, 'overall.png');
    return readFile(baselinePath);
  });
  const shot =
    source.project.shots.find((shot) => shot.id === 'inspection-shot-0') ?? source.project.shots[0];
  assert.ok(shot, 'The source package must include an inspection shot');
  await author.connect();
  const catalog = JSON.parse(await readFile(resolve(author.directory, 'mcp-capabilities.json'), 'utf8')) as {
    tools: { name: string }[];
  };
  for (const name of [
    'project_list',
    'project_open',
    'project_package_export',
    'render_status',
    'model_export',
    'preview_capture',
    'object_update',
    'history_undo',
    'history_redo',
    'render_start',
    'render_cancel',
    'transfer_begin',
    'transfer_chunk',
    'transfer_status',
    'transfer_commit',
  ])
    assert.ok(
      catalog.tools.some((tool) => tool.name === name),
      `The connected MCP catalog is missing ${name}`,
    );
  let projectId: string;
  if (values.phase === 'import') {
    const before = await author.call<{ id: string }[]>('project_list');
    await author.restorePackage(packagePath);
    projectId = author.project.id;
    const after = await author.call<{ id: string }[]>('project_list');
    assert.equal(after.length, before.length + 1);
    assert.ok(before.every((project) => after.some((candidate) => candidate.id === project.id)));
    assert.ok(!before.some((project) => project.id === projectId));
  } else {
    const state = JSON.parse(await readFile(values.state!, 'utf8')) as {
      projectId: string;
      packageHash: string;
      phase: string;
      passed: boolean;
    };
    assert.equal(state.phase, 'import');
    assert.equal(state.passed, true);
    assert.equal(state.packageHash, hash(input));
    projectId = state.projectId;
    author.project = await author.call<Project>('project_open', { id: projectId });
  }
  assert.deepEqual(content(author.project), content(source.project));
  const restored = await historyFacts();
  assert.equal(restored.cursor, source.cursor);
  assert.deepEqual(restored.history, source.history);
  for (const asset of source.assets) assert.equal(hash(await bytes(asset.url)), asset.sha256);
  const jobs = await author.call<RenderJob[]>('render_status');
  let preservedVideo: string | undefined;
  for (const job of jobs.filter((job) => job.options.projectId === projectId && job.status === 'completed')) {
    const encoded = await bytes(job.url ?? `/api/renders/${job.id}/file`);
    if (hash(encoded) === sourceVideo) preservedVideo = job.id;
  }
  assert.ok(preservedVideo, 'The authored video must remain available after package restoration');
  const glb = await author.exportGlb(`${values.name}-${values.phase}`);
  assert.equal(glb.sha256, baselineGlb, 'Restored geometry must re-export exactly');
  const preview = await author.preview('restored-angle.png', shot.id, 3);
  assert.equal(
    preview.sha256,
    hash(baseline),
    'Restored source and dependencies must reproduce the same pixels',
  );
  let editHistory: { before: number; after: number; originalCursor: number; finalCursor: number } | undefined;
  let reexport: Awaited<ReturnType<ModelingAssetClient['exportVideo']>> | undefined;
  let playback: Awaited<ReturnType<ModelingAssetClient['reviewVideo']>> | undefined;
  if (values.phase === 'restart') {
    const original = structuredClone(author.project.objects);
    const subject = author.project.objects.find(
      (object) => object.visible && !object.locked && object.modeling,
    )!;
    assert.ok(subject);
    await author.command('object_update', {
      id: subject.id,
      patch: { position: [subject.position[0], subject.position[1] + 0.075, subject.position[2]] },
    });
    assert.notEqual(digest(author.project.objects), digest(original));
    const edited = structuredClone(author.project.objects);
    author.project = await author.call<Project>('history_undo', {
      projectId,
      expectedRevision: author.project.revision,
    });
    assert.deepEqual(author.project.objects, original);
    author.project = await author.call<Project>('history_redo', {
      projectId,
      expectedRevision: author.project.revision,
    });
    assert.deepEqual(author.project.objects, edited);
    author.project = await author.call<Project>('history_undo', {
      projectId,
      expectedRevision: author.project.revision,
    });
    assert.deepEqual(author.project.objects, original);
    assert.deepEqual(content(author.project), content(source.project));
    const exercised = await historyFacts();
    assert.equal(exercised.cursor, source.cursor);
    assert.deepEqual(
      exercised.history.slice(0, source.cursor + 1),
      source.history.slice(0, source.cursor + 1),
    );
    assert.equal(
      exercised.history.length,
      source.cursor + 2,
      'The undone verification edit must remain available for redo',
    );
    editHistory = {
      before: restored.history.length,
      after: exercised.history.length,
      originalCursor: source.cursor,
      finalCursor: exercised.cursor,
    };
    reexport = await author.exportVideo(`${values.name}-restart`, 24);
    playback = await author.reviewVideo(`${values.name}-restart`);
  }
  await author.save('restoration-state.json', {
    phase: values.phase,
    projectId,
    revision: author.project.revision,
    packagePath,
    packageHash: hash(input),
    sourceDirectory: resolve(values.source),
    objectsHash: digest(author.project.objects),
    historyHashes: source.history,
    historyCursor: source.cursor,
    assetCount: source.assets.length,
    preservedVideo,
    sourceVideo,
    glbHash: glb.sha256,
    previewHash: preview.sha256,
    previewBaselinePath: baselinePath,
    previewShotId: shot.id,
    previewTime: 3,
    editHistory,
    reexport,
    playback,
    sameProjectContent: true,
    restoredHistoryMatchesSource: true,
    sameAssets: true,
    passed: true,
    directory: author.directory,
  });
  console.log(JSON.stringify({ phase: values.phase, projectId, directory: author.directory, passed: true }));
} catch (error) {
  await author
    .save('restoration-failure.json', {
      phase: values.phase,
      api: values.api,
      source: values.source,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      passed: false,
    })
    .catch(() => {});
  throw error;
} finally {
  await author.close();
}
