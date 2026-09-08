import * as THREE from 'three';
import type { IdentifiedMesh } from '../../shared/topology/types';
import type { ComponentTransform } from '../../shared/topology/transform';

interface PreviewData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  influences: Float32Array;
}

export class ComponentPreview {
  private worker: Worker;
  private root = new THREE.Group();
  private geometry?: THREE.BufferGeometry;
  private materials: THREE.Material[] = [];
  private hidden: THREE.Mesh[] = [];
  private delta = { value: new THREE.Matrix4() };
  private stopped = false;
  ready = false;

  constructor(
    mesh: IdentifiedMesh,
    transform: ComponentTransform,
    private source: THREE.Object3D,
    scene: THREE.Scene,
    private changed: () => void,
    error: (error: Error) => void,
  ) {
    this.root.matrixAutoUpdate = false;
    this.root.matrix.copy(source.matrixWorld);
    scene.add(this.root);
    this.worker = new Worker(new URL('./ComponentPreviewWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<PreviewData & { ready?: boolean; error?: string }>) => {
      if (this.stopped) return;
      if (event.data.ready) {
        this.worker.postMessage({ mesh, transform });
        return;
      }
      if (event.data.error) {
        error(new Error(event.data.error));
        this.dispose();
        return;
      }
      this.install(event.data);
      this.worker.terminate();
    };
    this.worker.onerror = (event) => {
      error(new Error(event.message));
      this.dispose();
    };
  }

  private install(data: PreviewData) {
    const geometry = (this.geometry = new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('componentInfluence', new THREE.BufferAttribute(data.influences, 1));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    const surface = new THREE.MeshStandardMaterial({
      color: '#e6e9e7',
      roughness: 0.88,
      side: THREE.DoubleSide,
    });
    const wire = new THREE.MeshBasicMaterial({
      color: '#53737a',
      wireframe: true,
      transparent: true,
      opacity: 0.35,
    });
    const points = new THREE.PointsMaterial({ color: '#e17642', size: 5, sizeAttenuation: false });
    for (const material of [surface, wire, points]) {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.componentDelta = this.delta;
        shader.vertexShader =
          'attribute float componentInfluence;\nuniform mat4 componentDelta;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          'vec3 transformed = mix(position, (componentDelta * vec4(position, 1.0)).xyz, componentInfluence);',
        );
      };
    }
    this.materials = [surface, wire, points];
    const body = new THREE.Mesh(geometry, surface);
    const cage = new THREE.Mesh(geometry, wire);
    const vertices = new THREE.Points(geometry, points);
    for (const object of [body, cage, vertices]) object.frustumCulled = false;
    this.root.add(body, cage, vertices);
    this.source.traverse((child) => {
      if (child instanceof THREE.Mesh && child.visible && child.parent === this.source) {
        this.hidden.push(child);
        child.visible = false;
      }
    });
    this.ready = true;
    this.changed();
  }

  update(matrix: THREE.Matrix4) {
    this.delta.value.copy(matrix);
  }

  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.worker.terminate();
    this.hidden.forEach((mesh) => {
      mesh.visible = true;
    });
    this.hidden = [];
    this.root.removeFromParent();
    this.geometry?.dispose();
    this.materials.forEach((material) => material.dispose());
  }
}
