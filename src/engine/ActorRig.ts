import * as THREE from 'three';
import type { SceneObject } from '../../shared/types';

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
  readonly head: THREE.Bone;
  readonly leftHand: THREE.Bone;
  readonly rightHand: THREE.Bone;
  readonly skeleton: THREE.Skeleton;
  private readonly leftArm: THREE.Bone;
  private readonly rightArm: THREE.Bone;
  private readonly leftElbow: THREE.Bone;
  private readonly rightElbow: THREE.Bone;
  private readonly leftLeg: THREE.Bone;
  private readonly rightLeg: THREE.Bone;
  private readonly leftKnee: THREE.Bone;
  private readonly rightKnee: THREE.Bone;
  private readonly mixer: THREE.AnimationMixer;
  private readonly walk: THREE.AnimationAction;

  constructor(tone: string) {
    const torsoMaterial = new THREE.MeshStandardMaterial({ color: tone || '#c8cfcc', roughness: 0.92 });
    this.body = bone('hips', this.root, 0, 0.91);
    const pelvis = part(new THREE.SphereGeometry(1, 20, 14), torsoMaterial, this.body);
    pelvis.scale.set(0.175, 0.145, 0.12);
    const chest = bone('chest', this.body, 0, 0.19);
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
    this.leftElbow = left.elbow;
    this.rightElbow = right.elbow;
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
      part(new THREE.BoxGeometry(0.105, 0.095, 0.24), torsoMaterial, knee, [0, -0.43, 0.058]);
      return knee;
    };
    this.leftKnee = createLeg(this.leftLeg, 'left');
    this.rightKnee = createLeg(this.rightLeg, 'right');
    const bones: THREE.Bone[] = [];
    this.root.traverse((child) => {
      if (child instanceof THREE.Bone) bones.push(child);
    });
    this.skeleton = new THREE.Skeleton(bones);
    this.mixer = new THREE.AnimationMixer(this.root);
    const times = [0, 0.25, 0.5, 0.75, 1];
    const tracks = [
      new THREE.NumberKeyframeTrack('leftLeg.rotation[x]', times, [-0.4, 0, 0.4, 0, -0.4]),
      new THREE.NumberKeyframeTrack('rightLeg.rotation[x]', times, [0.4, 0, -0.4, 0, 0.4]),
      new THREE.NumberKeyframeTrack('leftKnee.rotation[x]', times, [0.05, 0, 0.1, 0.65, 0.05]),
      new THREE.NumberKeyframeTrack('rightKnee.rotation[x]', times, [0.1, 0.65, 0.05, 0, 0.1]),
      new THREE.NumberKeyframeTrack('leftArm.rotation[x]', times, [0.3, 0, -0.3, 0, 0.3]),
      new THREE.NumberKeyframeTrack('rightArm.rotation[x]', times, [-0.3, 0, 0.3, 0, -0.3]),
    ];
    this.walk = this.mixer.clipAction(new THREE.AnimationClip('walk', 1, tracks));
    this.walk.play();
  }

  update(object: SceneObject, time: number, distance: number) {
    const actor = object.actor;
    if (!actor) return;
    const walking = actor.action === 'walk';
    this.walk.enabled = walking;
    for (const node of [
      this.leftArm,
      this.rightArm,
      this.leftElbow,
      this.rightElbow,
      this.leftLeg,
      this.rightLeg,
      this.leftKnee,
      this.rightKnee,
    ]) {
      node.rotation.set(0, 0, 0);
    }
    this.body.position.y = 0.91;
    this.leftArm.rotation.z = 0.1;
    this.rightArm.rotation.z = -0.1;
    this.leftElbow.rotation.x = -0.08;
    this.rightElbow.rotation.x = -0.08;
    if (walking) {
      this.mixer.setTime(distance / 1.22);
      this.body.position.y += Math.sin((distance / 1.22) * Math.PI * 4) * 0.012;
    }
    if (actor.action === 'sit') {
      this.body.position.y -= 0.45;
      this.leftLeg.rotation.x = this.rightLeg.rotation.x = -Math.PI / 2;
      this.leftKnee.rotation.x = this.rightKnee.rotation.x = Math.PI / 2;
      this.leftElbow.rotation.x = this.rightElbow.rotation.x = -0.65;
    }
    if (actor.action === 'talk') {
      this.leftElbow.rotation.x -= 0.32 + Math.sin(time * 2.8) * 0.16;
      this.leftArm.rotation.x -= 0.12;
      this.head.rotation.z = Math.sin(time * 1.7) * 0.023;
    } else this.head.rotation.z = 0;
    const pose = actor.pose;
    this.leftArm.rotation.x += rad(pose.leftArm);
    this.rightArm.rotation.x += rad(pose.rightArm);
    this.leftLeg.rotation.x += rad(pose.leftLeg);
    this.rightLeg.rotation.x += rad(pose.rightLeg);
    this.head.rotation.x = rad(pose.headPitch);
    this.head.rotation.y = rad(pose.headYaw);
    this.root.updateMatrixWorld(true);
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

  getBone(name: 'leftHand' | 'rightHand' | 'head' | 'root') {
    return name === 'root' ? this.root : this[name];
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.skeleton.dispose();
  }
}
