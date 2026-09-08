import type { Project, SceneObject } from '../../shared/types';
import type { MeshData } from '../../shared/modeling';
import { evaluateModelObject } from '../../shared/object-modeling';
import { referencedOperandIds } from '../../shared/modifiers/dependencies';
import type { GeometryRequest, GeometryResponse } from './GeometryWorker';

interface Task {
  input: GeometryRequest;
  bytes: number;
  signal: AbortSignal;
  resolve(value: MeshData): void;
  reject(error: Error): void;
  abort(): void;
}
let active: { worker: Worker; task: Task; timeout: ReturnType<typeof setTimeout> } | null = null;
const queue: Task[] = [];
export const GEOMETRY_QUEUE_LIMITS = {
  snapshotBytes: 64 * 1024 * 1024,
  reservedBytes: 256 * 1024 * 1024,
  requests: 2048,
} as const;
let reservedBytes = 0;
const cancelled = () => new DOMException('Geometry evaluation cancelled', 'AbortError');
function finish(error?: Error, mesh?: MeshData) {
  if (!active) return;
  const { worker, task, timeout } = active;
  active = null;
  reservedBytes -= task.bytes;
  clearTimeout(timeout);
  worker.terminate();
  task.signal.removeEventListener('abort', task.abort);
  if (error) task.reject(error);
  else task.resolve(mesh!);
  startNext();
}
function startNext() {
  if (active) return;
  const task = queue.shift();
  if (!task) return;
  if (task.signal.aborted) {
    reservedBytes -= task.bytes;
    task.signal.removeEventListener('abort', task.abort);
    task.reject(cancelled());
    startNext();
    return;
  }
  try {
    const worker = new Worker(new URL('./GeometryWorker.ts', import.meta.url), {
      type: 'module',
      name: 'whiteframe-geometry',
    });
    active = {
      worker,
      task,
      timeout: setTimeout(
        () => finish(new Error('Geometry exceeded the 120-second evaluation limit')),
        120000,
      ),
    };
    worker.onmessage = (event: MessageEvent<GeometryResponse | { ready: true }>) => {
      if (active?.worker !== worker) return;
      if ('ready' in event.data) {
        try {
          worker.postMessage(task.input);
        } catch (error) {
          finish(error as Error);
        }
        return;
      }
      if ('error' in event.data) finish(Object.assign(new Error(event.data.error.message), event.data.error));
      else finish(undefined, event.data.mesh);
    };
    worker.onerror = (event) => {
      if (active?.worker === worker) finish(new Error(event.message || 'Geometry worker failed to load'));
    };
  } catch (error) {
    reservedBytes -= task.bytes;
    task.signal.removeEventListener('abort', task.abort);
    task.reject(error as Error);
    startNext();
  }
}
function dependencyObjects(project: Pick<Project, 'objects'>, object: SceneObject) {
  const lookup = new Map(project.objects.map((candidate) => [candidate.id, candidate]));
  const included = new Set<string>();
  const visit = (id: string) => {
    if (included.has(id)) return;
    included.add(id);
    const candidate = lookup.get(id);
    if (!candidate) return;
    if (candidate.parentId) visit(candidate.parentId);
    referencedOperandIds(candidate).forEach(visit);
  };
  visit(object.id);
  return [...included].flatMap((id) => (lookup.has(id) ? [lookup.get(id)!] : []));
}
export function evaluateGeometry(
  project: Pick<Project, 'objects'>,
  object: SceneObject,
  signal: AbortSignal,
): Promise<MeshData> {
  if (signal.aborted) return Promise.reject(cancelled());
  if (typeof Worker === 'undefined') return Promise.resolve(evaluateModelObject(project, object));
  const input = { objects: dependencyObjects(project, object), objectId: object.id };
  const bytes = JSON.stringify(input).length * 2;
  if (bytes > GEOMETRY_QUEUE_LIMITS.snapshotBytes)
    return Promise.reject(new Error('Geometry dependency snapshot exceeds 64 MiB'));
  if (
    reservedBytes + bytes > GEOMETRY_QUEUE_LIMITS.reservedBytes ||
    queue.length + Number(Boolean(active)) >= GEOMETRY_QUEUE_LIMITS.requests
  )
    return Promise.reject(
      new Error('Geometry queue exceeds 256 MiB or 2048 requests; reduce scene complexity'),
    );
  return new Promise((resolve, reject) => {
    const task: Task = {
      input,
      bytes,
      signal,
      resolve,
      reject,
      abort: () => {
        if (active?.task === task) finish(cancelled());
        else {
          const index = queue.indexOf(task);
          if (index >= 0) {
            queue.splice(index, 1);
            reservedBytes -= task.bytes;
          }
          signal.removeEventListener('abort', task.abort);
          reject(cancelled());
        }
      },
    };
    signal.addEventListener('abort', task.abort, { once: true });
    reservedBytes += bytes;
    queue.push(task);
    startNext();
  });
}
