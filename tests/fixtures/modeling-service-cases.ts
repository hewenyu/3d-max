import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ModelingJob } from '../../shared/modeling-jobs';
import type { CommandResponse, Project } from '../../shared/types';
import type { inspectMesh } from '../../server/modeling-service';
import type { exportModelAsset, planModelConversion } from '../../server/modeling-assets';
import { topologyCube } from './topology-command-cases';

export type ModelingCall = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
export type ModelingHttp = <T>(path: string, body?: Record<string, unknown>, method?: string) => Promise<T>;
export const modelingServiceNames = [
  'modeling_job_start',
  'modeling_inspect_start',
  'modeling_job_status',
  'modeling_job_list',
  'modeling_job_cancel',
  'mesh_inspect',
  'mesh_selection_query',
  'model_conversion_plan',
  'model_export',
  'model_conversion_start',
  'model_export_start',
];
export const modelingGuard = (project: Project) => ({
  projectId: project.id,
  expectedRevision: project.revision,
  expectedContext: {
    sceneId: project.production?.activeSceneId ?? null,
    performanceId: project.production?.activePerformanceId ?? null,
  },
});
export const terminalModelingJob = (job: ModelingJob) =>
  ['completed', 'failed', 'cancelled'].includes(job.status);
export async function waitModelingJob(
  call: ModelingCall,
  id: string,
  predicate = terminalModelingJob,
  timeout = 20000,
) {
  const deadline = Date.now() + timeout;
  let current = await call<ModelingJob>('modeling_job_status', { id });
  while (!predicate(current) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await call<ModelingJob>('modeling_job_status', { id });
  }
  assert.ok(predicate(current), `Timed out waiting for modeling job: ${JSON.stringify(current)}`);
  return current;
}

export async function modelingServiceSeed(call: ModelingCall) {
  const project = await call<Project>('project_new', { name: 'Modeling services', template: 'empty' });
  return (
    await call<CommandResponse>('edit_batch', {
      ...modelingGuard(project),
      commands: [
        { type: 'object.create', payload: { id: 'target', name: 'Service mesh', type: 'box' } },
        { type: 'mesh.set', payload: { id: 'target', mesh: topologyCube() } },
      ],
    })
  ).project;
}

export async function exerciseModelingCatalog(call: ModelingCall, http?: ModelingHttp) {
  let project = await modelingServiceSeed(call);
  const source = structuredClone(project);
  const inspectRequest = { ...modelingGuard(project), objectId: 'target', kind: 'face', limit: 2 };
  const inspected = await call<ReturnType<typeof inspectMesh>>('mesh_inspect', inspectRequest);
  assert.equal(inspected.total, 6);
  assert.equal(inspected.elements.length, 2);
  assert.equal(inspected.nextOffset, 2);
  assert.equal(inspected.editable, true);
  if (http) assert.deepEqual(await http('/api/modeling/inspect', inspectRequest), inspected);
  const selectionRequest = {
    ...modelingGuard(project),
    objectId: 'target',
    selection: {
      namespace: inspected.namespace,
      kind: 'face',
      ids: [inspected.elements[0].id],
      operation: 'connected',
    },
  };
  const selected = await call<{ selection: { ids: string[] } }>('mesh_selection_query', selectionRequest);
  assert.equal(selected.selection.ids.length, 6);
  if (http) assert.deepEqual(await http('/api/modeling/selection', selectionRequest), selected);
  const inspectJob = await call<ModelingJob>('modeling_inspect_start', {
    ...modelingGuard(project),
    requestId: randomUUID(),
    kind: 'inspect',
    objectId: 'target',
    stage: 'source',
    componentKind: 'face',
    limit: 2,
  });
  const inspection = await waitModelingJob(call, inspectJob.id);
  assert.equal(inspection.status, 'completed', JSON.stringify(inspection.error));
  assert.ok(inspection.result && 'elements' in inspection.result);
  assert.deepEqual(inspection.result.elements, inspected.elements);
  assert.deepEqual(await call<Project>('project_get'), project);
  if (http) assert.deepEqual(await http(`/api/modeling/jobs/${inspection.id}`), inspection);

  const editRequest = {
    ...modelingGuard(project),
    requestId: randomUUID(),
    commands: [{ type: 'topology.bevel', payload: { id: 'target', width: 0.15, segments: 3 } }],
  };
  const editJob = await call<ModelingJob>('modeling_job_start', editRequest);
  if (http) assert.equal((await http<ModelingJob>('/api/modeling/jobs', editRequest)).id, editJob.id);
  const edited = await waitModelingJob(call, editJob.id);
  assert.equal(edited.status, 'completed', JSON.stringify(edited.error));
  project = await call<Project>('project_get');
  assert.equal(project.revision, source.revision + 1);
  assert.ok(project.objects[0].modeling?.kind === 'mesh' && project.objects[0].modeling.faces.length > 6);
  if (http) assert.deepEqual(await http('/api/project'), project);
  const listed = await call<ModelingJob[]>('modeling_job_list', { projectId: project.id });
  assert.ok(listed.some((job) => job.id === edited.id && job.status === 'completed'));
  if (http) assert.deepEqual(await http(`/api/modeling/jobs?projectId=${project.id}`), listed);

  const cancelRequest = {
    ...modelingGuard(project),
    requestId: randomUUID(),
    commands: [{ type: 'object.update', payload: { id: 'target', patch: { name: 'Never published' } } }],
  };
  const pending = await call<ModelingJob>('modeling_job_start', cancelRequest);
  const cancelled = await call<ModelingJob>('modeling_job_cancel', { id: pending.id });
  assert.equal(cancelled.status, 'cancelled');
  if (http) assert.deepEqual(await http(`/api/modeling/jobs/${pending.id}/cancel`, {}), cancelled);
  assert.deepEqual(await call<Project>('project_get'), project);

  const exportRequest = {
    ...modelingGuard(project),
    scope: 'selection',
    objectIds: ['target'],
    name: 'service-mesh.glb',
  };
  const exported = await call<Awaited<ReturnType<typeof exportModelAsset>>>('model_export', exportRequest);
  assert.ok(exported.bytes > 100 && exported.vertices > 8 && exported.triangles > 12);
  assert.equal(exported.sourcePreserved, true);
  if (http) {
    const viaHttp = await http<Awaited<ReturnType<typeof exportModelAsset>>>(
      '/api/modeling/export',
      exportRequest,
    );
    assert.equal(viaHttp.sha256, exported.sha256);
    assert.equal(viaHttp.triangles, exported.triangles);
    assert.deepEqual(viaHttp.objectIds, exported.objectIds);
  }
  project = (
    await call<CommandResponse>('edit_batch', {
      ...modelingGuard(project),
      commands: [
        {
          type: 'object.create',
          payload: {
            id: 'imported',
            type: 'model',
            assetUrl: exported.url,
            position: [4, 0, 0],
          },
        },
      ],
    })
  ).project;
  const conversionRequest = { ...modelingGuard(project), objectId: 'imported' };
  const conversion = await call<Awaited<ReturnType<typeof planModelConversion>>>(
    'model_conversion_plan',
    conversionRequest,
  );
  assert.equal(conversion.sourcePreserved, true);
  assert.ok(conversion.mesh.vertices.length > 8 && conversion.mesh.faces.length > 12);
  if (http) assert.deepEqual(await http('/api/modeling/conversion', conversionRequest), conversion);
  assert.deepEqual(await call<Project>('project_get'), project);
  const conversionJobRequest = { ...conversionRequest, requestId: randomUUID(), kind: 'conversion' };
  const conversionJob = await call<ModelingJob>('model_conversion_start', conversionJobRequest);
  if (http)
    assert.equal((await http<ModelingJob>('/api/modeling/jobs', conversionJobRequest)).id, conversionJob.id);
  const converted = await waitModelingJob(call, conversionJob.id);
  assert.equal(converted.status, 'completed', JSON.stringify(converted.error));
  assert.deepEqual(converted.result, conversion);
  const exportJobRequest = {
    ...exportRequest,
    ...modelingGuard(project),
    requestId: randomUUID(),
    kind: 'export',
  };
  const exportJob = await call<ModelingJob>('model_export_start', exportJobRequest);
  if (http) assert.equal((await http<ModelingJob>('/api/modeling/jobs', exportJobRequest)).id, exportJob.id);
  const exportedJob = await waitModelingJob(call, exportJob.id);
  assert.equal(exportedJob.status, 'completed', JSON.stringify(exportedJob.error));
  const exportedResult = exportedJob.result as Awaited<ReturnType<typeof exportModelAsset>>;
  assert.equal(exportedResult.sha256, exported.sha256);
  assert.equal(exportedResult.triangles, exported.triangles);
  assert.deepEqual(exportedResult.objectIds, exported.objectIds);
  assert.deepEqual(await call<Project>('project_get'), project);
  if (http) {
    assert.deepEqual(await http(`/api/modeling/jobs/${converted.id}`), converted);
    assert.deepEqual(await http(`/api/modeling/jobs/${exportedJob.id}`), exportedJob);
  }
  return {
    projectId: project.id,
    inspectionId: inspection.id,
    editedId: edited.id,
    cancelledId: cancelled.id,
    exportedAssetId: exported.id,
    exportedSha256: exported.sha256,
    conversionJobId: converted.id,
    exportJobId: exportedJob.id,
    services: modelingServiceNames,
  };
}
