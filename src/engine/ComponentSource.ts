import { TopologyError, type TopologyMesh } from '../../shared/topology/types';
import type { ComponentSourceData } from './ComponentSourceData';

export interface PreparedComponentSource {
  input: TopologyMesh;
  fingerprint: string;
  data: ComponentSourceData;
  topology: ComponentSourceData['topology'];
  source: ComponentSourceData['topology']['mesh'];
}

export class ComponentSource {
  private input: TopologyMesh | null = null;
  private fingerprint = '';
  private result: Promise<PreparedComponentSource> | null = null;
  private cancelPending: (() => void) | null = null;
  private disposed = false;

  prepare(input: TopologyMesh): Promise<PreparedComponentSource> {
    if (this.disposed)
      return Promise.reject(new TopologyError('Component source has been disposed', 'SOURCE_CANCELLED', 409));
    if (input === this.input && this.result) return this.result;
    const fingerprint = JSON.stringify(input);
    if (fingerprint === this.fingerprint && this.result) {
      this.input = input;
      return this.remember(this.result.then((prepared) => ({ ...prepared, input })));
    }
    this.cancelPending?.();
    this.input = input;
    this.fingerprint = fingerprint;
    const result = new Promise<PreparedComponentSource>((resolve, reject) => {
      const worker = new Worker(new URL('./ComponentSourceWorker.ts', import.meta.url), { type: 'module' });
      const finish = () => {
        worker.terminate();
        if (this.cancelPending === cancel) this.cancelPending = null;
      };
      const cancel = () => {
        finish();
        reject(new TopologyError('Component source preparation was superseded', 'SOURCE_CANCELLED', 409));
      };
      this.cancelPending = cancel;
      worker.onmessage = (
        event: MessageEvent<{
          data?: ComponentSourceData;
          error?: { message: string; code?: string; status?: number; details?: Record<string, unknown> };
        }>,
      ) => {
        finish();
        if (event.data.error) {
          const error = event.data.error;
          reject(new TopologyError(error.message, error.code, error.status, error.details));
        } else if (event.data.data) {
          const data = event.data.data;
          resolve({ input, fingerprint, data, topology: data.topology, source: data.topology.mesh });
        } else reject(new TopologyError('Component source worker returned no data'));
      };
      worker.onerror = (event) => {
        finish();
        reject(
          new TopologyError(event.message || 'Component source worker failed', 'SOURCE_WORKER_FAILED', 500),
        );
      };
      worker.onmessageerror = () => {
        finish();
        reject(new TopologyError('Component source transfer failed', 'SOURCE_WORKER_FAILED', 500));
      };
      try {
        worker.postMessage(input);
      } catch (error) {
        finish();
        reject(error);
      }
    });
    return this.remember(result);
  }

  private remember(result: Promise<PreparedComponentSource>) {
    this.result = result;
    void result.catch(() => {
      if (this.result !== result) return;
      this.input = null;
      this.fingerprint = '';
      this.result = null;
    });
    return result;
  }

  reset() {
    this.cancelPending?.();
    this.input = null;
    this.result = null;
    this.fingerprint = '';
  }
  dispose() {
    this.disposed = true;
    this.reset();
  }
}
