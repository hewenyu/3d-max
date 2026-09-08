import type { TopologyMesh } from '../../shared/topology/types';
import { componentSourceTransfers, prepareComponentSource } from './ComponentSourceData';

self.onmessage = (event: MessageEvent<TopologyMesh>) => {
  try {
    const data = prepareComponentSource(event.data);
    self.postMessage({ data }, { transfer: componentSourceTransfers(data) });
  } catch (error) {
    const failure = error as Error & { code?: string; status?: number; details?: Record<string, unknown> };
    self.postMessage({
      error: {
        message: failure.message,
        code: failure.code,
        status: failure.status,
        details: failure.details,
      },
    });
  }
};
