import * as THREE from 'three';
import { CCDIKSolver, type IK } from 'three/addons/animation/CCDIKSolver.js';
import type { SceneObject } from './types';
import { FaceRig } from './face-rig';
import {
  ActorAnimationSampler,
  actorIntervalWeight,
  actorJointNames,
  type ActorAnimation,
  type ActorConstraintResult,
  type ActorConstraintTarget,
  type ActorEffector,
  type ActorJointName,
} from './actor-animation';

const rad = THREE.MathUtils.degToRad;
const limbMaterial = new THREE.MeshStandardMaterial({ color: '#e6e7e5', roughness: 0.87 });
const jointMaterial = new THREE.MeshStandardMaterial({ color: '#969d9a', roughness: 0.84 });
const faceMaterial = new THREE.MeshStandardMaterial({ color: '#eff0ed', roughness: 0.88 });

function part(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  parent: THREE.Object3D,
  position: number[] = [0, 0, 0],
) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function capsule(
  radius: number,
  length: number,
  parent: THREE.Object3D,
  y: number,
  material: THREE.Material = limbMaterial,
) {
  return part(
    new THREE.CapsuleGeometry(radius, Math.max(0.001, length - 2 * radius), 5, 12),
    material,
    parent,
    [0, y, 0],
  );
}

function bone(name: string, parent: THREE.Object3D, x: number, y: number, z = 0) {
  const result = new THREE.Bone();
  result.name = name;
  result.position.set(x, y, z);
  parent.add(result);
  return result;
}

export class ActorRig {
  readonly root = new THREE.Group();
  readonly body: THREE.Bone;
  readonly chest: THREE.Bone;
  readonly head: THREE.Bone;
  readonly leftHand: THREE.Bone;
  readonly rightHand: THREE.Bone;
  readonly leftFoot: THREE.Bone;
  readonly rightFoot: THREE.Bone;
  readonly skeleton: THREE.Skeleton;
  constraintResults: ActorConstraintResult[] = [];
  private readonly leftArm: THREE.Bone;
  private readonly rightArm: THREE.Bone;
  private readonly leftLeg: THREE.Bone;
  private readonly bodyMeshes: THREE.Mesh[] = [];
  private readonly rightLeg: THREE.Bone;
  private readonly joints = new Map<ActorJointName, THREE.Bone>();
  private readonly baseRotations = new Map<ActorJointName, THREE.Quaternion>();
  private readonly ikTargets = new Map<ActorEffector, THREE.Bone>();
  private readonly ikChains = new Map<ActorEffector, IK>();
  private readonly carrier: THREE.SkinnedMesh;
  private readonly solver: CCDIKSolver;
  private sampler = new ActorAnimationSampler();
  private animationSignature = '';
  private faceRig?: FaceRig;

  constructor(tone: string) {
    const torsoMaterial = new THREE.MeshStandardMaterial({ color: tone || '#c8cfcc', roughness: 0.92 });
    this.body = bone('hips', this.root, 0, 0.91);
    const pelvis = part(new THREE.SphereGeometry(1, 20, 14), torsoMaterial, this.body);
    pelvis.scale.set(0.175, 0.145, 0.12);
    const chest = bone('chest', this.body, 0, 0.19);
    this.chest = chest;
    const torso = part(new THREE.CapsuleGeometry(0.18, 0.21, 8, 20), torsoMaterial, chest, [0, 0.11, 0]);
    torso.scale.set(1.04, 1, 0.62);
    capsule(0.055, 0.13, chest, 0.43, jointMaterial);
    this.head = bone('head', chest, 0, 0.49, 0);
    const headMesh = part(new THREE.SphereGeometry(1, 24, 20), faceMaterial, this.head, [0, 0.025, 0]);
    headMesh.scale.set(0.113, 0.147, 0.108);
    const nose = part(new THREE.SphereGeometry(1, 12, 8), faceMaterial, this.head, [0, 0.012, 0.107]);
    nose.scale.set(0.022, 0.027, 0.034);
    for (const side of [-1, 1]) {
      const ear = part(new THREE.SphereGeometry(1, 12, 8), faceMaterial, this.head, [side * 0.111, 0.018, 0]);
      ear.scale.set(0.021, 0.035, 0.023);
      const eye = part(new THREE.SphereGeometry(0.008, 8, 8), jointMaterial, this.head, [
        side * 0.043,
        0.051,
        0.095,
      ]);
      eye.scale.z = 0.45;
      eye.name = `legacy-eye-${side}`;
    }
    this.leftArm = bone('leftArm', chest, 0.222, 0.31);
    this.rightArm = bone('rightArm', chest, -0.222, 0.31);
    const createArm = (upper: THREE.Bone, side: string) => {
      part(new THREE.SphereGeometry(0.063, 14, 10), jointMaterial, upper);
      capsule(0.057, 0.265, upper, -0.135);
      const elbow = bone(`${side}Elbow`, upper, 0, -0.275);
      part(new THREE.SphereGeometry(0.043, 12, 10), jointMaterial, elbow);
      const forearm = capsule(0.046, 0.235, elbow, -0.12);
      forearm.scale.z = 0.85;
      const hand = bone(`${side}Hand`, elbow, 0, -0.24, 0.013);
      const palm = part(new THREE.CapsuleGeometry(0.035, 0.05, 5, 12), faceMaterial, hand, [0, -0.035, 0]);
      palm.scale.z = 0.62;
      return { elbow, hand };
    };
    const left = createArm(this.leftArm, 'left');
    const right = createArm(this.rightArm, 'right');
    this.leftHand = left.hand;
    this.rightHand = right.hand;
    this.leftLeg = bone('leftLeg', this.body, 0.095, -0.025);
    this.rightLeg = bone('rightLeg', this.body, -0.095, -0.025);
    const createLeg = (upper: THREE.Bone, side: string) => {
      part(new THREE.SphereGeometry(0.065, 12, 10), jointMaterial, upper);
      capsule(0.077, 0.41, upper, -0.205);
      const knee = bone(`${side}Knee`, upper, 0, -0.405);
      part(new THREE.SphereGeometry(0.052, 12, 10), jointMaterial, knee);
      capsule(0.057, 0.385, knee, -0.192);
      const foot = bone(`${side}Foot`, knee, 0, -0.405);
      part(new THREE.BoxGeometry(0.105, 0.095, 0.24), torsoMaterial, foot, [0, -0.025, 0.058]);
      return { knee, foot };
    };
    const leftLeg = createLeg(this.leftLeg, 'left');
    const rightLeg = createLeg(this.rightLeg, 'right');
    this.leftFoot = leftLeg.foot;
    this.rightFoot = rightLeg.foot;
    for (const name of actorJointNames) {
      this.joints.set(name, this.root.getObjectByName(name) as THREE.Bone);
      this.baseRotations.set(name, new THREE.Quaternion());
    }
    for (const name of ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'] as const)
      this.ikTargets.set(name, bone(`ik-${name}`, this.root, 0, 0));
    const bones: THREE.Bone[] = [];
    this.root.traverse((child) => {
      if (child instanceof THREE.Bone) bones.push(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.computeBoundingBox();
        this.bodyMeshes.push(child);
      }
    });
    this.skeleton = new THREE.Skeleton(bones);
    this.carrier = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    this.carrier.visible = false;
    this.carrier.bind(this.skeleton);
    const index = (node: THREE.Bone) => bones.indexOf(node);
    for (const name of ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'] as const) {
      const effector = this.joints.get(name)!;
      const hinge = effector.parent as THREE.Bone;
      const upper = hinge.parent as THREE.Bone;
      const leg = name.endsWith('Foot');
      this.ikChains.set(name, {
        target: index(this.ikTargets.get(name)!),
        effector: index(effector),
        iteration: 48,
        maxAngle: 0.4,
        links: [
          {
            index: index(hinge),
            rotationMin: new THREE.Vector3(rad(leg ? 0 : -165), 0, 0),
            rotationMax: new THREE.Vector3(rad(leg ? 165 : 0), 0, 0),
          },
          {
            index: index(upper),
            rotationMin: new THREE.Vector3(rad(-175), rad(-160), rad(-160)),
            rotationMax: new THREE.Vector3(rad(175), rad(160), rad(160)),
          },
        ],
      });
    }
    this.solver = new CCDIKSolver(this.carrier, [...this.ikChains.values()]);
  }

  update(object: SceneObject, time: number, distance: number) {
    const actor = object.actor;
    if (!actor) return;
    if (actor.face?.enabled && !this.faceRig) this.faceRig = new FaceRig(this.head);
    this.faceRig?.update(actor.face, time);
    const animation = (actor as typeof actor & { animation?: ActorAnimation }).animation;
    const signature = animation ? JSON.stringify([animation.clips, animation.jointKeys]) : '';
    if (this.animationSignature !== signature) {
      this.sampler.dispose();
      this.sampler = new ActorAnimationSampler(animation);
      this.animationSignature = signature;
    }
    const sample = this.sampler.sample(time, {
      action: actor.action,
      speed: actor.speed,
      pose: actor.pose,
      distance,
    });
    for (const name of actorJointNames) {
      const node = this.joints.get(name)!;
      node.quaternion.fromArray(sample.rotations[name]);
      this.baseRotations.get(name)!.copy(node.quaternion);
    }
    this.body.position.set(sample.hipsOffset[0], 0.91 + sample.hipsOffset[1], sample.hipsOffset[2]);
    this.constraintResults = [];
    this.root.updateWorldMatrix(true, true);
    const floorWeight = Math.min(
      1,
      sample.activeClips.reduce((total, active) => {
        const clip = animation?.clips.find((item) => item.id === active.id);
        return total + (clip?.action === 'fall' || clip?.action === 'getup' ? active.weight : 0);
      }, 0),
    );
    if (sample.activeClips.length > 0) {
      // Built-in actions use the actor origin as support; floor actions additionally settle onto it.
      const inverse = this.root.matrixWorld.clone().invert();
      const relative = new THREE.Matrix4();
      const bounds = new THREE.Box3();
      let minimum = Infinity;
      for (const mesh of this.bodyMeshes) {
        relative.multiplyMatrices(inverse, mesh.matrixWorld);
        bounds.copy(mesh.geometry.boundingBox!).applyMatrix4(relative);
        minimum = Math.min(minimum, bounds.min.y);
      }
      this.body.position.y -= minimum < 0 ? minimum : minimum * floorWeight;
      this.root.updateWorldMatrix(true, true);
    }
  }

  applyConstraints(
    object: SceneObject,
    time: number,
    resolveTarget: (target: ActorConstraintTarget) => THREE.Vector3 | null,
  ): ActorConstraintResult[] {
    const animation = (
      object.actor as (NonNullable<SceneObject['actor']> & { animation?: ActorAnimation }) | undefined
    )?.animation;
    const constraints = animation?.constraints ?? [];
    for (const name of [
      'leftArm',
      'rightArm',
      'leftElbow',
      'rightElbow',
      'leftLeg',
      'rightLeg',
      'leftKnee',
      'rightKnee',
    ] as const)
      this.joints.get(name)!.quaternion.copy(this.baseRotations.get(name)!);
    this.root.updateWorldMatrix(true, true);
    const states = constraints.map((constraint) => {
      const weight = actorIntervalWeight(constraint, time);
      const point = weight > 0 ? (resolveTarget(constraint.target)?.clone() ?? null) : null;
      const effector = this.joints.get(constraint.effector)!;
      const hinge = effector.parent as THREE.Bone;
      const upper = hinge.parent as THREE.Bone;
      let reachable = false;
      if (point) {
        const distance = upper.parent!.worldToLocal(point.clone()).distanceTo(upper.position);
        const lengths = [hinge.position.length(), effector.position.length()];
        reachable =
          distance <= lengths[0] + lengths[1] + 0.001 &&
          distance >= Math.abs(lengths[0] - lengths[1]) - 0.001;
        const target = this.ikTargets.get(constraint.effector)!;
        target.position.copy(this.root.worldToLocal(point.clone()));
        target.updateWorldMatrix(true, false);
        const chain = this.ikChains.get(constraint.effector)!;
        chain.iteration = constraint.iterations;
        const initial = chain.links.map((link) => this.skeleton.bones[link.index].quaternion.clone());
        chain.blendFactor = 1;
        // A straight hinge is a CCD singularity; seed the anatomical bending side before solving.
        if (Math.abs(hinge.rotation.x) < 0.001) {
          const leg = constraint.effector.endsWith('Foot');
          hinge.rotation.x = rad(leg ? 60 : -30);
          upper.rotation.x += rad(leg ? -30 : 15);
        }
        upper.updateMatrixWorld(true);
        this.solver.updateOne(chain);
        chain.links.forEach((link, index) => {
          const node = this.skeleton.bones[link.index];
          node.quaternion.slerpQuaternions(initial[index], node.quaternion.clone(), weight);
        });
        upper.updateMatrixWorld(true);
      }
      return { constraint, weight, point, reachable };
    });
    this.root.updateWorldMatrix(true, true);
    this.constraintResults = states.map(({ constraint, weight, point, reachable }) => {
      const position = this.joints.get(constraint.effector)!.getWorldPosition(new THREE.Vector3());
      const error = point ? position.distanceTo(point) : null;
      const reached = error !== null && error <= constraint.tolerance;
      return {
        id: constraint.id,
        effector: constraint.effector,
        target: point ? point.toArray() : null,
        position: position.toArray(),
        error,
        reachable,
        reached,
        weight,
        status:
          weight === 0
            ? 'inactive'
            : !point
              ? 'missing-target'
              : !reachable
                ? 'unreachable'
                : reached
                  ? 'solved'
                  : 'partial',
      };
    });
    return this.constraintResults;
  }

  lookAt(target: THREE.Vector3, object: SceneObject) {
    const parent = this.head.parent!;
    const local = parent.worldToLocal(target.clone()).sub(this.head.position);
    const yaw = Math.atan2(local.x, local.z);
    const pitch = -Math.atan2(local.y, Math.hypot(local.x, local.z));
    this.head.rotation.y += THREE.MathUtils.clamp(yaw, -1.15, 1.15);
    this.head.rotation.x += THREE.MathUtils.clamp(pitch, -0.55, 0.55);
    this.head.updateMatrixWorld(true);
    void object;
  }

  getBone(name: ActorJointName | 'root') {
    return name === 'root' ? this.root : this.joints.get(name)!;
  }

  dispose() {
    this.sampler.dispose();
    this.skeleton.dispose();
    this.carrier.geometry.dispose();
    const materials = Array.isArray(this.carrier.material) ? this.carrier.material : [this.carrier.material];
    materials.forEach((material) => material.dispose());
  }
}
