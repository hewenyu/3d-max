import * as THREE from 'three';
import type { ActorConstraintResult, ActorConstraintTarget } from './actor-animation';
import type { SceneObject } from './types';
import type { ActorRig } from './actor-rig';

export interface ConstraintObject {
  root: THREE.Object3D;
  rig?: ActorRig;
}

export function applyActorConstraints(
  sampled: Map<string, SceneObject>,
  objects: Map<string, ConstraintObject>,
  time: number,
): Map<string, ActorConstraintResult[]> {
  const targets = new Map<string, THREE.Vector3 | null>();
  const keyFor = (target: ActorConstraintTarget) => JSON.stringify(target);
  // Snapshot every target before solving, including targets on other actors.
  for (const object of sampled.values()) {
    for (const constraint of object.actor?.animation?.constraints ?? []) {
      const target = constraint.target;
      const key = keyFor(target);
      if (targets.has(key)) continue;
      if (target.kind === 'world') targets.set(key, new THREE.Vector3(...target.position));
      else {
        const built = objects.get(target.objectId);
        const anchor = target.bone && built?.rig ? built.rig.getBone(target.bone) : built?.root;
        targets.set(key, anchor ? anchor.localToWorld(new THREE.Vector3(...target.offset)) : null);
      }
    }
  }
  const results = new Map<string, ActorConstraintResult[]>();
  for (const object of sampled.values()) {
    const rig = objects.get(object.id)?.rig;
    if (rig)
      results.set(
        object.id,
        rig.applyConstraints(object, time, (target) => targets.get(keyFor(target))?.clone() ?? null),
      );
  }
  return results;
}
