import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Project } from '../../shared/types';
import { sampleSummary } from './benchmark-browser';

interface Operation {
  started: string;
  finished: string;
  name: string;
  arguments: Record<string, unknown>;
  isError: boolean;
}
const { values } = parseArgs({
  options: {
    directory: { type: 'string', multiple: true },
    output: { type: 'string', default: '.data/advanced-modeling/performance/works-performance.json' },
  },
});
assert.ok(values.directory?.length, 'Supply one or more --directory paths containing final work journals');
const samples = [];
for (const input of values.directory) {
  const directory = resolve(input);
  const name = basename(dirname(directory));
  const sources: { path: string; sha256: string; bytes: number }[] = [];
  const read = async (file: string) => {
    const path = resolve(directory, file);
    const bytes = await readFile(path);
    sources.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    return bytes.toString('utf8');
  };
  const operations = (await read('mcp-operations.jsonl'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Operation);
  const glb = JSON.parse(await read(`${name}-glb.json`)) as {
    revision: number;
    vertices: number;
    triangles: number;
    bytes: number;
  };
  const render = JSON.parse(await read(`${name}-render-job.json`)) as {
    id: string;
    status: string;
    totalFrames: number;
    options: { fps: number; resolution: number };
  };
  const project = JSON.parse(await read(`${name}-render-project.json`)) as Project;
  assert.equal(render.status, 'completed');
  const calls = (tool: string) =>
    operations.filter((operation) => operation.name === tool && !operation.isError);
  const summary = (tool: string) =>
    sampleSummary(
      calls(tool).map((operation) => Date.parse(operation.finished) - Date.parse(operation.started)),
    );
  const renderStart = calls('render_start');
  const renderStatuses = calls('render_status').filter((operation) => operation.arguments.id === render.id);
  assert.equal(renderStart.length, 1, 'A final work journal must identify one video export');
  assert.ok(renderStatuses.length > 0);
  const modifiers: Record<string, number> = {};
  const surfaces: Record<string, number> = {};
  let sourceVertices = 0,
    sourceFaces = 0;
  for (const object of project.objects) {
    const modeling = object.modeling;
    if (modeling?.kind === 'stack')
      for (const modifier of modeling.modifiers)
        modifiers[modifier.type] = (modifiers[modifier.type] ?? 0) + 1;
    const source = modeling?.kind === 'stack' ? modeling.base : modeling;
    if (source?.kind === 'mesh') {
      sourceVertices += source.vertices.length;
      sourceFaces += source.faces.length;
    }
    if (source?.kind === 'surface') surfaces[source.operation] = (surfaces[source.operation] ?? 0) + 1;
  }
  samples.push({
    name,
    directory,
    projectId: project.id,
    revision: glb.revision,
    workload: {
      objects: project.objects.length,
      explicitSourceVertices: sourceVertices,
      explicitSourceFaces: sourceFaces,
      modifiers,
      surfaces,
      exportedVertices: glb.vertices,
      exportedTriangles: glb.triangles,
      glbBytes: glb.bytes,
    },
    calls: {
      inspectionMs: summary('mesh_inspect'),
      previewCaptureMs: summary('preview_capture'),
      glbExportMs: summary('model_export'),
      packageExportMs: summary('project_package_export'),
    },
    video: {
      observedRequestThroughLastStatusMs:
        Date.parse(renderStatuses.at(-1)!.finished) - Date.parse(renderStart[0].started),
      frames: render.totalFrames,
      fps: render.options.fps,
      resolution: render.options.resolution,
      statusPolls: renderStatuses.length,
    },
    failedCalls: operations.filter((operation) => operation.isError).length,
    sources,
  });
}
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      method:
        'Read-only extraction from final production MCP journals and completed render/GLB metadata; each work has one final export observation. Video duration is request start through last successful status acknowledgement, including polling and concurrent machine load; it is not isolated renderer CPU time. Empty operation groups remain null.',
      samples,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ output, samples: samples.length }));
