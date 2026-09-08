import * as THREE from 'three';
import type { BuiltObject } from './ObjectFactory';
import type { SceneObject } from '../../shared/types';

export class DirectorHelpers {
  readonly root = new THREE.Group();
  update(axisIds: string[], objects: Map<string, BuiltObject>, sampled: Map<string, SceneObject>) {
    this.clear();
    const points = axisIds
      .slice(0, 2)
      .map((id) => objects.get(id)?.root.getWorldPosition(new THREE.Vector3()));
    if (points.length === 2 && points.every(Boolean)) {
      const [a, b] = points as [THREE.Vector3, THREE.Vector3];
      a.y = b.y = 0.016;
      const direction = b.clone().sub(a).normalize();
      a.addScaledVector(direction, -1.7);
      b.addScaledVector(direction, 1.7);
      this.line(a, b, '#b78f58', 0.16, 0.08, 0.65);
    }
    for (const object of sampled.values()) {
      const rig = objects.get(object.id)?.rig;
      if (!rig || !object.actor?.lookAtId) continue;
      const target = objects.get(object.actor.lookAtId);
      if (!target) continue;
      const a = rig.head.getWorldPosition(new THREE.Vector3());
      const b =
        target.rig?.head.getWorldPosition(new THREE.Vector3()) ??
        target.root.getWorldPosition(new THREE.Vector3());
      this.line(a, b, '#94a3a9', 0.045, 0.065, 0.5);
    }
  }
  private line(
    a: THREE.Vector3,
    b: THREE.Vector3,
    color: string,
    dashSize: number,
    gapSize: number,
    opacity: number,
  ) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineDashedMaterial({ color, dashSize, gapSize, transparent: true, opacity }),
    );
    line.computeLineDistances();
    this.root.add(line);
  }
  private clear() {
    this.root.traverse((child) => {
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
    this.root.clear();
  }
}
