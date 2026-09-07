import * as THREE from 'three';
import type { SceneObject } from '../../shared/types';
import type { MotionObject } from '../../shared/motion';

export class EffectRig {
  readonly root = new THREE.Group();
  private readonly parts: THREE.Object3D[] = [];

  constructor(input: SceneObject) {
    const object = input as MotionObject;
    const effect = object.effect!;
    const material = new THREE.MeshStandardMaterial({ color: object.tone, roughness: 0.9 });
    if (effect.kind === 'projectile') {
      const trail = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.018, 1, 8), material);
      trail.rotation.x = Math.PI / 2;
      this.root.add(trail);
      this.parts.push(trail);
    } else {
      const wire = new THREE.MeshStandardMaterial({ color: '#737f79', wireframe: true });
      const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), wire);
      this.root.add(sphere);
      this.parts.push(sphere);
      for (const axis of [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 1),
      ]) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2, 6), material);
        bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        this.root.add(bar);
        this.parts.push(bar);
      }
    }
  }

  update(input: SceneObject, time: number): void {
    const effect = (input as MotionObject).effect!;
    const fraction = (time - effect.start) / effect.duration;
    this.root.visible = fraction >= 0 && fraction < 1;
    if (!this.root.visible) return;
    const radius =
      effect.radius * (effect.kind === 'projectile' ? 1 : Math.max(0.04, Math.sin((fraction * Math.PI) / 2)));
    this.root.scale.setScalar(radius);
    if (effect.kind !== 'projectile')
      this.parts.forEach((part, index) => {
        part.visible = index === 0 || fraction < 0.75;
      });
  }
}
