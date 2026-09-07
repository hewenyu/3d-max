import * as THREE from 'three';
import { ActorRig } from './actor-rig';
import { applyActorConstraints } from './actor-constraints';
import { buildModelGeometry } from './modeling-geometry';
import { distanceTable, gaitDistance, type DistanceTable } from './motion-distance';
import { sampleObject } from './timeline';
import { actorJointNames, type ActorConstraintResult } from './actor-animation';
import type { Project, SceneObject, TimelineSample, Vec3 } from './types';
import { continuityHash } from './continuity-types';
import { sceneFarPlane } from './scene-framing';

interface AnalysisObject {
  root: THREE.Group;
  rig?: ActorRig;
  approximation: boolean;
}
export interface ContinuityObjectState {
  object: SceneObject;
  matrix: THREE.Matrix4;
  position: THREE.Vector3;
  center: THREE.Vector3;
  bounds: THREE.Box3;
  visible: boolean;
  approximation: boolean;
  targets: THREE.Vector3[];
  contacts: ActorConstraintResult[];
  jointPositions: Vec3[];
}
export interface ContinuityFrame {
  sample: TimelineSample;
  project: Project;
  sceneKey: string;
  camera: THREE.PerspectiveCamera;
  objects: Map<string, ContinuityObjectState>;
  axis: string[];
  signatures: Map<string, string>;
}

export function objectEvidenceSignature(frame: ContinuityFrame, ids: string[]) {
  const visited = new Set<string>();
  const visit = (id: string | null | undefined) => {
    if (!id || visited.has(id)) return;
    visited.add(id);
    const object = frame.objects.get(id)?.object;
    if (!object) return;
    visit(object.parentId);
    visit(object.attachment?.objectId);
    visit(object.actor?.lookAtId);
    for (const constraint of object.actor?.animation?.constraints ?? [])
      if (constraint.target.kind === 'object') visit(constraint.target.objectId);
  };
  ids.forEach(visit);
  return [...visited].sort().map((id) => [id, frame.signatures.get(id)]);
}

export class ContinuityScene {
  readonly root = new THREE.Group();
  readonly objects = new Map<string, AnalysisObject>();
  private readonly distances = new Map<string, DistanceTable>();
  private readonly material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  private readonly signatures = new Map<string, string>();

  constructor(
    readonly project: Project,
    readonly sceneKey: string,
  ) {
    for (const object of project.objects) {
      this.signatures.set(object.id, continuityHash(object));
      const root = new THREE.Group();
      root.userData.entityId = object.id;
      const item: AnalysisObject = { root, approximation: false };
      const [w, h, d] = object.dimensions;
      if (object.type === 'actor') {
        item.rig = new ActorRig(object.tone);
        item.rig.root.scale.set(w / 0.5, h / 1.78, d / 0.35);
        root.add(item.rig.root);
        this.distances.set(object.id, distanceTable(object));
      } else if (object.type !== 'group') {
        let geometry: THREE.BufferGeometry;
        if (object.modeling) geometry = buildModelGeometry(object.modeling);
        else if (object.type === 'sphere') {
          geometry = new THREE.SphereGeometry(0.5, 24, 16);
          geometry.scale(w, h, d).translate(0, h / 2, 0);
        } else if (object.type === 'cylinder') {
          geometry = new THREE.CylinderGeometry(w / 2, w / 2, h, 32);
          geometry.scale(1, 1, d / w).translate(0, h / 2, 0);
        } else {
          geometry = new THREE.BoxGeometry(w, h, d);
          if (object.type !== 'phone') geometry.translate(0, h / 2, 0);
          item.approximation =
            !['box', 'plane', 'wall', 'phone'].includes(object.type) || !!object.vehicle || !!object.effect;
        }
        const mesh = new THREE.Mesh(geometry, this.material);
        root.add(mesh);
      }
      this.root.add(root);
      this.objects.set(object.id, item);
    }
  }

  sampleTransforms(time: number, hiddenIds: string[] = []) {
    const sampled = new Map<string, SceneObject>();
    for (const source of this.project.objects) {
      const object = sampleObject(source, time, { render: true });
      sampled.set(object.id, object);
      const item = this.objects.get(object.id)!;
      const parent = object.parentId ? this.objects.get(object.parentId)?.root : this.root;
      (parent ?? this.root).add(item.root);
      item.root.position.fromArray(object.position);
      item.root.rotation.set(...(object.rotation.map(THREE.MathUtils.degToRad) as Vec3));
      item.root.scale.fromArray(object.scale);
      item.root.visible = object.visible && !hiddenIds.includes(object.id);
      if (object.effect)
        item.root.visible &&=
          time >= object.effect.start && time < object.effect.start + object.effect.duration;
      item.rig?.update(
        object,
        time,
        gaitDistance(this.distances.get(object.id), time, object.actor?.speed ?? 1),
      );
    }
    this.root.updateMatrixWorld(true);
    for (const object of sampled.values()) {
      if (!object.attachment) continue;
      const item = this.objects.get(object.id)!;
      const target = this.objects.get(object.attachment.objectId);
      if (!target) continue;
      (target.rig?.getBone(object.attachment.bone) ?? target.root).add(item.root);
      item.root.position.fromArray(object.attachment.offset);
    }
    this.root.updateMatrixWorld(true);
    for (const object of sampled.values()) {
      const item = this.objects.get(object.id)!;
      const target = object.actor?.lookAtId ? this.objects.get(object.actor.lookAtId) : undefined;
      if (item.rig && target)
        item.rig.lookAt(
          target.rig
            ? target.rig.head.getWorldPosition(new THREE.Vector3())
            : new THREE.Box3().setFromObject(target.root).getCenter(new THREE.Vector3()),
          object,
        );
    }
    this.root.updateMatrixWorld(true);
    const contacts = applyActorConstraints(sampled, this.objects, time);
    this.root.updateMatrixWorld(true);
    return { sampled, contacts };
  }

  sample(sample: TimelineSample): ContinuityFrame {
    const { sampled, contacts } = this.sampleTransforms(sample.sourceTime, sample.shot?.hiddenIds);
    const camera = new THREE.PerspectiveCamera(
      sample.camera?.fov ?? 43,
      this.project.settings.aspect === '9:16' ? 9 / 16 : this.project.settings.aspect === '1:1' ? 1 : 16 / 9,
      0.025,
      300,
    );
    if (sample.camera) {
      camera.position.fromArray(sample.camera.position);
      camera.lookAt(new THREE.Vector3(...sample.camera.target));
    }
    camera.far = sceneFarPlane(camera.position, new THREE.Box3().setFromObject(this.root));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const states = new Map<string, ContinuityObjectState>();
    for (const object of sampled.values()) {
      const item = this.objects.get(object.id)!;
      const bounds = new THREE.Box3().setFromObject(item.root);
      const center = bounds.isEmpty()
        ? item.root.getWorldPosition(new THREE.Vector3())
        : bounds.getCenter(new THREE.Vector3());
      const size = bounds.isEmpty() ? new THREE.Vector3() : bounds.getSize(new THREE.Vector3());
      const targets = item.rig
        ? ['head', 'chest', 'hips', 'leftArm', 'rightArm'].map((name) =>
            item
              .rig!.getBone(name as 'head' | 'chest' | 'hips' | 'leftArm' | 'rightArm')
              .getWorldPosition(new THREE.Vector3()),
          )
        : [
            center.clone(),
            ...[
              [-0.3, 0, 0],
              [0.3, 0, 0],
              [0, -0.3, 0],
              [0, 0.3, 0],
            ].map((offset) => center.clone().add(new THREE.Vector3(...offset).multiply(size))),
          ];
      let visible = true;
      for (let node: THREE.Object3D | null = item.root; node; node = node.parent) visible &&= node.visible;
      states.set(object.id, {
        object,
        matrix: item.root.matrixWorld.clone(),
        position: item.root.getWorldPosition(new THREE.Vector3()),
        center,
        bounds,
        visible,
        approximation: item.approximation,
        targets,
        contacts: contacts.get(object.id) ?? [],
        jointPositions: item.rig
          ? actorJointNames.map(
              (name) =>
                item.root
                  .worldToLocal(item.rig!.getBone(name).getWorldPosition(new THREE.Vector3()))
                  .toArray() as Vec3,
            )
          : [],
      });
    }
    return {
      sample,
      project: this.project,
      sceneKey: this.sceneKey,
      camera,
      objects: states,
      axis: this.project.settings.axisActorIds,
      signatures: this.signatures,
    };
  }

  dispose() {
    for (const item of this.objects.values()) {
      item.root.removeFromParent();
      item.rig?.dispose();
      item.root.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          for (const material of Array.isArray(child.material) ? child.material : [child.material])
            if (material !== this.material) material.dispose();
        }
      });
    }
    this.material.dispose();
    this.objects.clear();
    this.root.clear();
  }
}
