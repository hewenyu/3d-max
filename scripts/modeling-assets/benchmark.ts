import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, freemem, platform, release, arch, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import type { Command, CommandResponse, Project, Vec3 } from '../../shared/types';
import type { ModelingJob } from '../../shared/modeling-jobs';
import type { ComponentSelection } from '../../shared/topology';
import { ModelingAssetClient, type MeshInspection } from './client';
import { ModelingBrowserBenchmark, sampleSummary } from './benchmark-browser';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4221' },
    web: { type: 'string' },
    output: { type: 'string', default: '.data/advanced-modeling/performance' },
    grades: { type: 'string', default: 'small,medium,large' },
    'edit-vertices': { type: 'string' },
    'expect-edit-error': { type: 'string' },
    'self-host': { type: 'boolean', default: false },
    port: { type: 'string', default: '4225' },
    'node-only': { type: 'boolean', default: false },
    data: { type: 'string' },
    dist: { type: 'string', default: 'dist' },
    conditions: { type: 'string', default: 'Concurrent external workloads were not controlled.' },
  },
});
const grades = [
  { name: 'small', segments: 16, profileSegments: 8, vertices: 512 },
  { name: 'medium', segments: 100, profileSegments: 25, vertices: 10000 },
  { name: 'large', segments: 200, profileSegments: 50, vertices: 40000 },
  { name: 'near-limit', segments: 45000, profileSegments: 1, vertices: 90000 },
].filter((grade) => values.grades.split(',').includes(grade.name));
assert.ok(grades.length && grades.length === values.grades.split(',').length, 'Unknown benchmark grade');
let apiUrl = values.api;
let shutdown = async () => {};
if (values['self-host']) {
  const { createApp } = await import('../../server/app');
  const port = Number(values.port);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid self-host port');
  apiUrl = `http://127.0.0.1:${port}`;
  const dataDir = values.data
    ? resolve(values.data)
    : await mkdtemp(join(tmpdir(), 'whiteframe-modeling-benchmark-'));
  const config = { port, dataDir, distDir: resolve(values.dist), appUrl: apiUrl, apiUrl };
  const service = createApp(config);
  const listener = service.app.listen(port, '127.0.0.1');
  await new Promise<void>((done) => listener.once('listening', done));
  apiUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  config.apiUrl = apiUrl;
  config.appUrl = apiUrl;
  shutdown = async () => {
    await new Promise<void>((done, reject) => listener.close((error) => (error ? reject(error) : done())));
    await service.close();
    if (!values.data) await rm(dataDir, { recursive: true, force: true });
  };
}
const client = new ModelingAssetClient(
  values['self-host'] ? 'node-server' : 'browser-server',
  apiUrl,
  values.output,
);
const browser = values['node-only'] ? undefined : new ModelingBrowserBenchmark(client, values.web ?? apiUrl);
const unfinished = new Set<string>();
const samples: unknown[] = [];
let partial: Record<string, unknown> = {};
let stopProbe: ReturnType<typeof probe> | undefined;
const host = {
  time: new Date().toISOString(),
  node: process.version,
  v8: process.versions.v8,
  platform: platform(),
  release: release(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  totalMemoryBytes: totalmem(),
  freeMemoryBytes: freemem(),
  loadAverage: loadavg(),
  measurementProcess: values['self-host']
    ? 'MCP client and server main thread in one Node process; RSS includes worker threads'
    : 'MCP client runner only; remote server heap is not exposed',
  workerLimits: { heapMb: 512, timeoutMs: 120000, unfinishedJobs: 8 },
  conditions: values.conditions,
  apiUrl,
};
async function timed<T>(run: () => Promise<T>) {
  const before = performance.now();
  const value = await run();
  return { ms: performance.now() - before, value };
}
function probe() {
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  const initial = process.memoryUsage();
  let peak = initial;
  const sample = () => {
    const current = process.memoryUsage();
    peak = {
      rss: Math.max(peak.rss, current.rss),
      heapTotal: Math.max(peak.heapTotal, current.heapTotal),
      heapUsed: Math.max(peak.heapUsed, current.heapUsed),
      external: Math.max(peak.external, current.external),
      arrayBuffers: Math.max(peak.arrayBuffers, current.arrayBuffers),
    };
    return current;
  };
  const interval = setInterval(sample, 20);
  return () => {
    clearInterval(interval);
    histogram.disable();
    const final = sample();
    return {
      initial,
      peak,
      final,
      eventLoopDelayMs: {
        p50: histogram.percentile(50) / 1e6,
        p95: histogram.percentile(95) / 1e6,
        max: histogram.max / 1e6,
        mean: histogram.mean / 1e6,
      },
    };
  };
}
async function waitJob(id: string, started: number, expectedError?: string) {
  const phaseFirstSeenMs: Record<string, number> = {};
  const requests: number[] = [];
  let job!: ModelingJob;
  const deadline = Date.now() + 180000;
  do {
    const response = await timed(() => client.call<ModelingJob>('modeling_job_status', { id }));
    requests.push(response.ms);
    job = response.value;
    phaseFirstSeenMs[`${job.status}:${job.progress.phase}:${job.progress.stage ?? ''}`] ??=
      performance.now() - started;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) break;
    assert.ok(Date.now() < deadline, `Job ${id} exceeded 180 seconds`);
    await new Promise((done) => setTimeout(done, 25));
  } while (true);
  unfinished.delete(id);
  await client.save(`job-${id}.json`, job);
  if (expectedError) {
    assert.equal(job.status, 'failed', 'Expected near-limit edit to reach its recorded resource boundary');
    assert.equal(job.error?.code, expectedError);
  } else assert.equal(job.status, 'completed', JSON.stringify(job.error));
  if (job.result && 'project' in job.result) client.project = (job.result as CommandResponse).project;
  return {
    job,
    elapsedMs: performance.now() - started,
    statusRequestMs: sampleSummary(requests),
    phaseFirstSeenMs,
    serverQueueMs: job.startedAt ? Date.parse(job.startedAt) - Date.parse(job.createdAt) : null,
    serverRunThroughCommitMs:
      job.startedAt && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : null,
  };
}
async function edit(commands: Command[], expectedError?: string) {
  const started = performance.now();
  const accepted = await timed(() =>
    client.call<ModelingJob>('modeling_job_start', { ...client.guard(), requestId: randomUUID(), commands }),
  );
  unfinished.add(accepted.value.id);
  const { job, ...result } = await waitJob(accepted.value.id, started, expectedError);
  return {
    acceptedMs: accepted.ms,
    ...result,
    jobId: job.id,
    revision: client.project.revision,
    status: job.status,
    error: job.error,
  };
}
async function inspection() {
  const started = performance.now();
  const accepted = await client.call<ModelingJob>('modeling_inspect_start', {
    ...client.guard(),
    requestId: randomUUID(),
    kind: 'inspect',
    objectId: 'benchmark-mesh',
    stage: 'source',
    componentKind: 'vertex',
    offset: 0,
    limit: 1,
  });
  unfinished.add(accepted.id);
  const { job, ...timing } = await waitJob(accepted.id, started);
  const result = job.result as unknown as MeshInspection;
  assert.ok(result.namespace && result.elements.length === 1);
  return { result, timing };
}
async function cancellations(commands: Command[]) {
  const before = structuredClone(client.project);
  const source = client.project.objects.find((object) => object.id === 'benchmark-mesh')?.modeling;
  assert.ok(source?.kind === 'mesh');
  const repetitions = source.vertices.length < 1000 ? 16 : source.vertices.length < 20000 ? 4 : 2;
  const request = {
    ...client.guard(),
    requestId: randomUUID(),
    commands: Array.from({ length: repetitions }, () => commands).flat(),
  };
  const active = await client.call<ModelingJob>('modeling_job_start', request);
  unfinished.add(active.id);
  const queued = await client.call<ModelingJob>('modeling_job_start', {
    ...request,
    requestId: randomUUID(),
  });
  unfinished.add(queued.id);
  assert.equal(queued.status, 'queued', 'Second real worker job must wait in the queue');
  const queue = await timed(() => client.call<ModelingJob>('modeling_job_cancel', { id: queued.id }));
  assert.equal(queue.value.status, 'cancelled');
  unfinished.delete(queued.id);
  let observed = await client.call<ModelingJob>('modeling_job_status', { id: active.id });
  const deadline = Date.now() + 30000;
  while (observed.status === 'running' && observed.progress.stage !== 'computing' && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 10));
    observed = await client.call<ModelingJob>('modeling_job_status', { id: active.id });
  }
  assert.equal(observed.status, 'running');
  assert.equal(observed.progress.stage, 'computing', 'Cancellation must interrupt actual computation');
  const mainThreadRead = await timed(() => client.call<Project>('project_get'));
  assert.deepEqual(mainThreadRead.value, before);
  const running = await timed(() => client.call<ModelingJob>('modeling_job_cancel', { id: active.id }));
  assert.equal(running.value.status, 'cancelled');
  unfinished.delete(active.id);
  await client.refresh();
  assert.deepEqual(client.project, before);
  return {
    queuedCancelMs: queue.ms,
    activeCancelMs: running.ms,
    observedPhase: observed.progress,
    projectReadWhileActiveMs: mainThreadRead.ms,
    activeJobId: active.id,
    queuedJobId: queued.id,
    exactProjectPreserved: true,
  };
}
try {
  await client.connect();
  await client.save('conditions.json', host);
  for (const grade of grades) {
    await client.create(`Modeling benchmark ${grade.vertices} vertices`);
    partial = { grade: grade.name, projectId: client.project.id };
    stopProbe = probe();
    const commands: Command[] = [
      {
        type: 'object.create',
        payload: { id: 'benchmark-mesh', type: 'box', name: `${grade.vertices} vertex surface` },
      },
    ];
    if (grade.name === 'near-limit') {
      const vertices: Vec3[] = [];
      const faces: number[][] = [];
      for (let ring = 0; ring < grade.segments; ring++) {
        const angle = (ring / grade.segments) * Math.PI * 2;
        const x = 2 * Math.cos(angle),
          z = 2 * Math.sin(angle);
        vertices.push([x, 0, z], [x, 3, z]);
        const next = ((ring + 1) % grade.segments) * 2;
        faces.push([ring * 2, ring * 2 + 1, next + 1, next]);
      }
      commands.push({
        type: 'mesh.set',
        payload: { id: 'benchmark-mesh', mesh: { vertices, faces, smooth: false } },
      });
    } else
      commands.push(
        {
          type: 'surface.set',
          payload: {
            id: 'benchmark-mesh',
            surface: {
              kind: 'surface',
              operation: 'revolve',
              segments: grade.segments,
              profileSegments: grade.profileSegments,
              profile: {
                closed: true,
                points: [
                  [1.2, 0],
                  [2, 0],
                  [2, 3],
                  [1.2, 3],
                ].map((position) => ({ position })),
              },
            },
          },
        },
        { type: 'mesh.convert', payload: { id: 'benchmark-mesh' } },
      );
    const generated = await edit(commands);
    partial.generated = generated;
    const generatedMesh = client.project.objects.find((object) => object.id === 'benchmark-mesh')?.modeling;
    assert.ok(generatedMesh?.kind === 'mesh');
    const meshStructure = {
      kind: grade.name === 'near-limit' ? 'connected open quad cylinder' : 'baked hollow revolved surface',
      vertices: generatedMesh.vertices.length,
      faces: generatedMesh.faces.length,
      triangles: generatedMesh.faces.reduce((sum, face) => sum + face.length - 2, 0),
      quads: generatedMesh.faces.filter((face) => face.length === 4).length,
    };
    assert.ok(meshStructure.triangles <= 150000);
    const inspected = await inspection();
    partial.inspection = inspected.timing;
    partial.meshStructure = meshStructure;
    assert.equal(inspected.result.total, grade.vertices);
    const select = await timed(() =>
      client.call<{ selection: ComponentSelection }>('mesh_selection_query', {
        ...client.guard(),
        objectId: 'benchmark-mesh',
        selection: {
          namespace: inspected.result.namespace,
          kind: 'vertex',
          ids: [],
          operation: 'invert',
        },
      }),
    );
    assert.equal(select.value.selection.ids.length, grade.vertices);
    const source = structuredClone(client.project.objects);
    const opened = await browser?.open();
    partial.opened = opened;
    partial.selectionQueryMs = select.ms;
    const editCount =
      values['edit-vertices'] === undefined ? grade.vertices : Number(values['edit-vertices']);
    assert.ok(
      Number.isInteger(editCount) && editCount > 0 && editCount <= grade.vertices,
      'Invalid edit vertex count',
    );
    partial.editVertices = editCount;
    await browser?.startSampling();
    const transformCommands: Command[] = [
      {
        type: 'topology.transform',
        payload: {
          id: 'benchmark-mesh',
          selection: {
            namespace: select.value.selection.namespace,
            kind: select.value.selection.kind,
            ids: select.value.selection.ids.slice(0, editCount),
          },
          translation: [0.03, 0, 0],
        },
      },
    ];
    const editRevision = client.project.revision;
    const edited = await edit(transformCommands, values['expect-edit-error']);
    partial.edited = edited;
    if (edited.status === 'failed') {
      await client.refresh();
      assert.deepEqual(client.project.objects, source);
      assert.equal(client.project.revision, editRevision);
    } else assert.notDeepEqual(client.project.objects, source);
    const frameSampling = await browser?.finishSampling();
    partial.frameSampling = frameSampling;
    const history =
      edited.status === 'failed'
        ? { ms: null, value: client.project }
        : await timed(() =>
            client.call<Project>('history_undo', {
              projectId: client.project.id,
              expectedRevision: client.project.revision,
            }),
          );
    client.project = history.value;
    assert.deepEqual(client.project.objects, source);
    const cancelled = await cancellations(transformCommands);
    const browserSelection = await browser?.inspectSelection(grade.name);
    const saved = await timed(() =>
      client.call<{ url: string; size: number }>('project_package_export', {
        projectId: client.project.id,
        expectedRevision: client.project.revision,
        includeVideos: false,
      }),
    );
    const archive = await client.download(saved.value.url, `${grade.name}.whiteframe`);
    let capture: unknown = { skipped: true, reason: 'Node-only run' };
    if (browser) {
      const imageResult = await timed(() =>
        client.raw('scene_view_capture', {
          projectId: client.project.id,
          expectedRevision: client.project.revision,
          context: { kind: 'source', sourceTime: 0 },
          view: 'edit',
          width: 960,
          height: 640,
          observation: { position: [6, 4, 8], target: [0, 1.5, 0], fov: 43 },
        }),
      );
      const image = imageResult.value.content.find((item) => item.type === 'image');
      assert.ok(image?.type === 'image');
      const imagePixels = await browser.verifyCapture(image.data);
      assert.ok(imagePixels.distinctColors > 30, 'Headless capture is blank');
      const file = await client.writeArtifact(
        `${grade.name}-headless.png`,
        Buffer.from(image.data, 'base64'),
      );
      capture = { ms: imageResult.ms, pixels: imagePixels, file };
    }
    const memory = stopProbe();
    stopProbe = undefined;
    const result = {
      grade: grade.name,
      vertices: inspected.result.total,
      meshStructure,
      editVertices: editCount,
      projectId: client.project.id,
      generated,
      inspection: inspected.timing,
      selectionQueryMs: select.ms,
      edited,
      undoMs: history.ms,
      undoSkipped:
        edited.status === 'failed'
          ? 'The geometry edit failed atomically; no geometry history entry was created'
          : undefined,
      cancellations: cancelled,
      saveMs: saved.ms,
      archive,
      opened,
      frameSampling,
      browserSelection,
      capture,
      memory,
    };
    samples.push(result);
    await client.save(`${grade.name}-project.json`, client.project);
    await client.save(`${grade.name}-report.json`, result);
    await client.save('report.json', { status: 'running', host, samples });
    console.log(
      JSON.stringify({
        grade: grade.name,
        vertices: grade.vertices,
        editMs: edited.elapsedMs,
        saveMs: saved.ms,
        undoMs: history.ms,
        directory: client.directory,
      }),
    );
  }
  const status = values['expect-edit-error'] ? 'completed-with-limit' : 'completed';
  await client.save('report.json', {
    status,
    completedAt: new Date().toISOString(),
    host,
    samples,
  });
  console.log(JSON.stringify({ status, directory: client.directory }));
} catch (error) {
  await client
    .save('report.json', {
      status: 'failed',
      host,
      samples,
      partial,
      error: error instanceof Error ? error.stack : String(error),
    })
    .catch(() => {});
  throw error;
} finally {
  stopProbe?.();
  for (const id of unfinished) await client.call('modeling_job_cancel', { id }).catch(() => {});
  await browser?.close();
  await client.close();
  await shutdown();
}
