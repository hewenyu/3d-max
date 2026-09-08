import { buildTopology } from '../../shared/topology/adjacency';
import { componentTransformWeights, type ComponentTransform } from '../../shared/topology/transform';
import type { IdentifiedMesh } from '../../shared/topology/types';
import { meshToGeometry } from '../../shared/mesh-geometry';

self.onmessage = (event: MessageEvent<{ mesh: IdentifiedMesh; transform: ComponentTransform }>) => {
  try {
    const { mesh, transform } = event.data;
    const { weights } = componentTransformWeights(buildTopology(mesh), transform);
    const geometry = meshToGeometry(mesh);
    const positions = new Float32Array(geometry.getAttribute('position').array);
    const normals = new Float32Array(geometry.getAttribute('normal').array);
    const indices = new Uint32Array(geometry.getIndex()!.array);
    const influences = new Float32Array(weights);
    geometry.dispose();
    self.postMessage(
      { positions, normals, indices, influences },
      { transfer: [positions.buffer, normals.buffer, indices.buffer, influences.buffer] },
    );
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
self.postMessage({ ready: true });
