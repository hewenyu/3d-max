import { createHash } from 'node:crypto';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { applyCommands } from '../shared/commands';
import { inspectModelGeometry } from '../shared/modeling-inspection';
import { diagnoseMesh } from '../shared/topology/diagnostics';
import { MODELING_JOB_LIMITS, modelingJobRequestSchema } from '../shared/modeling-jobs';
import type { Project } from '../shared/types';
import { errorBody, errorStatus } from './errors';
import type { AssetRecord } from './store';
import type { ModelingWorkerInput } from './modeling-jobs-protocol';
import { planModelConversion, prepareModelExport } from './modeling-assets';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function runModelingWorker() {
  if (isMainThread || !parentPort) throw new Error('Modeling computation requires a worker thread');
  const port = parentPort;
  try {
    const data = workerData as ModelingWorkerInput;
    if (digest(data.snapshot) !== data.snapshotHash || digest(data.request) !== data.requestHash)
      throw Object.assign(new Error('Worker input digest does not match its immutable snapshot'), {
        code: 'INPUT_DIGEST_MISMATCH',
      });
    const snapshot = JSON.parse(data.snapshot) as Project;
    const request = modelingJobRequestSchema.parse(JSON.parse(data.request));
    const cancellation = new Int32Array(data.cancellation);
    const assets = data.assets ?? '[]';
    if (data.assetSnapshotHash && digest(assets) !== data.assetSnapshotHash)
      throw Object.assign(new Error('Worker asset manifest digest does not match its snapshot'), {
        code: 'INPUT_DIGEST_MISMATCH',
      });
    const assetByUrl = new Map((JSON.parse(assets) as AssetRecord[]).map((asset) => [asset.url, asset]));
    port.postMessage({
      type: 'progress',
      phase: 'computing',
      completed: 0,
      total: request.kind === 'commands' ? request.commands.length : 0,
    });
    let result: unknown;
    let bytes: ArrayBuffer | undefined;
    if (request.kind === 'commands')
      result = applyCommands(snapshot, request.commands, (progress) =>
        port.postMessage({ type: 'progress', ...progress }),
      );
    else if (request.kind === 'inspect') {
      const object = snapshot.objects.find((item) => item.id === request.objectId);
      if (!object)
        throw Object.assign(new Error('The object is not in the selected snapshot'), { code: 'NOT_FOUND' });
      const { mesh, page } = inspectModelGeometry(
        object,
        { ...request, kind: request.componentKind },
        snapshot,
      );
      result = {
        projectId: snapshot.id,
        revision: snapshot.revision,
        context: request.expectedContext,
        objectId: object.id,
        ...page,
        diagnostics: diagnoseMesh(mesh, { tolerance: request.tolerance }),
      };
    } else {
      const source = { project: () => snapshot, assetByUrl: (url: string) => assetByUrl.get(url) };
      const options = {
        signal: {
          get aborted() {
            return Atomics.load(cancellation, 0) !== 0;
          },
        },
        onProgress: (progress: import('../shared/model-assets').ModelingAssetProgress) =>
          port.postMessage({ type: 'asset-progress', progress }),
      };
      const { kind, requestId: _requestId, ...input } = request;
      if (kind === 'conversion') result = await planModelConversion(source, input, options);
      else {
        const prepared = await prepareModelExport(source, input, options);
        result = prepared.metadata;
        bytes = Uint8Array.from(prepared.bytes).buffer;
      }
    }
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) + (bytes?.byteLength ?? 0) > MODELING_JOB_LIMITS.resultBytes)
      throw Object.assign(new Error('Computed modeling result exceeds the result byte limit'), {
        code: 'MODELING_RESULT_LIMIT',
      });
    port.postMessage(
      {
        type: 'result',
        snapshotHash: data.snapshotHash,
        requestHash: data.requestHash,
        response: encoded,
        responseHash: digest(encoded),
        assetSnapshotHash: data.assetSnapshotHash,
        ...(bytes ? { bytes } : {}),
      },
      bytes ? [bytes] : [],
    );
  } catch (error) {
    port.postMessage({ type: 'error', error: { ...errorBody(error).error, status: errorStatus(error) } });
  } finally {
    port.close();
  }
}
