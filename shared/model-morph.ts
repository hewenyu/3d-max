import * as THREE from 'three';
import { sampleFace, type FaceChannel, type ModelMorph, type Viseme } from './face-animation';

export class ModelMorphRig {
  readonly meshes: THREE.Mesh[] = [];
  private readonly applied = new Map<THREE.Mesh, Map<number, number>>();
  constructor(root: THREE.Object3D) {
    root.traverse((child) => {
      if (child instanceof THREE.Mesh && child.morphTargetDictionary && child.morphTargetInfluences) {
        this.meshes.push(child);
      }
    });
  }
  reset() {
    for (const [mesh, weights] of this.applied)
      for (const [index, weight] of weights) mesh.morphTargetInfluences![index] = weight;
    this.applied.clear();
  }
  update(morph: ModelMorph | undefined, time: number) {
    if (!morph?.face.enabled) return;
    const sample = sampleFace(morph.face, time);
    for (const mesh of this.meshes) {
      const sums = new Map<number, number>();
      for (const binding of morph.bindings) {
        if (
          binding.mesh &&
          binding.mesh !== mesh.name &&
          binding.mesh !== mesh.userData.whiteframeMorphMeshKey
        )
          continue;
        const index = mesh.morphTargetDictionary![binding.target];
        if (index === undefined) continue;
        const value = binding.channel.startsWith('viseme:')
          ? sample.visemes[binding.channel.slice(7) as Viseme]
          : sample.values[binding.channel as FaceChannel];
        sums.set(index, (sums.get(index) ?? 0) + value * binding.scale + binding.offset);
      }
      const previous = new Map<number, number>();
      for (const [index, value] of sums) {
        previous.set(index, mesh.morphTargetInfluences![index]!);
        mesh.morphTargetInfluences![index] = Math.max(0, Math.min(1, value));
      }
      this.applied.set(mesh, previous);
    }
  }
}
