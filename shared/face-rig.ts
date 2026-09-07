import * as THREE from 'three';
import { sampleFace, type FaceAnimation, type FaceValues } from './face-animation';

export class FaceRig {
  readonly root = new THREE.Group();
  readonly mouth: THREE.Mesh;
  readonly jaw: THREE.Mesh;
  readonly upperLip: THREE.Mesh;
  readonly lowerLip: THREE.Mesh;
  readonly brows: THREE.Mesh[] = [];
  readonly lids: THREE.Mesh[] = [];
  readonly pupils: THREE.Mesh[] = [];
  private readonly legacyEyes: THREE.Object3D[];
  constructor(head: THREE.Object3D) {
    this.root.name = 'face-expression-rig';
    this.legacyEyes = head.children.filter((child) => child.name.startsWith('legacy-eye-'));
    const pale = new THREE.MeshStandardMaterial({ color: '#eff0ed', roughness: 0.88 });
    const dark = new THREE.MeshStandardMaterial({ color: '#66716b', roughness: 0.9 });
    const interior = new THREE.MeshStandardMaterial({ color: '#47504b', roughness: 1 });
    const lip = new THREE.MeshStandardMaterial({ color: '#acb5ae', roughness: 0.92 });
    const add = (name: string, material: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), material);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      return mesh;
    };
    this.jaw = add('face-jaw', pale);
    this.mouth = add('face-mouth-opening', interior);
    this.upperLip = add('face-upper-lip', lip);
    this.lowerLip = add('face-lower-lip', lip);
    for (const side of [-1, 1]) {
      const eye = add(`face-eye-${side}`, pale);
      eye.position.set(side * 0.043, 0.051, 0.099);
      eye.scale.set(0.023, 0.014, 0.009);
      const pupil = add(`face-pupil-${side}`, dark);
      this.pupils.push(pupil);
      pupil.scale.set(0.007, 0.009, 0.003);
      const lid = add(`face-eyelid-${side}`, pale);
      this.lids.push(lid);
      const brow = add(`face-brow-${side}`, dark);
      this.brows.push(brow);
    }
    head.add(this.root);
  }
  update(face: FaceAnimation | undefined, time: number): void {
    this.root.visible = Boolean(face?.enabled);
    for (const eye of this.legacyEyes) eye.visible = !this.root.visible;
    if (!this.root.visible) return;
    this.pose(sampleFace(face, time).values);
  }
  private pose(value: FaceValues) {
    const open = 0.002 + value.jawOpen * 0.035;
    const width = 0.034 + value.mouthWide * 0.016 + value.smile * 0.012 - value.pucker * 0.021;
    const forward = value.pucker * 0.023;
    const mouthY = -0.045 - value.jawOpen * 0.008;
    this.jaw.position.set(0, -0.078 - value.jawOpen * 0.012, 0.025);
    this.jaw.scale.set(0.076, 0.04, 0.068);
    this.mouth.position.set(0, mouthY, 0.099 + forward);
    this.mouth.scale.set(width, open, 0.006);
    this.upperLip.position.set(0, mouthY + open + value.upperLipRaise * 0.009, 0.104 + forward);
    this.lowerLip.position.set(0, mouthY - open - value.lowerLipDown * 0.008, 0.103 + forward);
    this.upperLip.scale.set(width, 0.003, 0.004);
    this.lowerLip.scale.set(width, 0.0035, 0.005);
    // Lip curvature is geometry deformation, preserving the same topology across all sampled frames.
    for (const mesh of [this.upperLip, this.lowerLip]) {
      const attribute = mesh.geometry.getAttribute('position');
      const rest = mesh.userData.rest as Float32Array | undefined;
      const original = rest ?? new Float32Array(attribute.array);
      mesh.userData.rest = original;
      for (let i = 0; i < attribute.count; i++) {
        const x = original[i * 3]!;
        attribute.setXYZ(
          i,
          x,
          original[i * 3 + 1]! + x * x * (value.smile - value.frown) * 2.2,
          original[i * 3 + 2]!,
        );
      }
      attribute.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    }
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const blink = i === 0 ? value.blinkRight : value.blinkLeft;
      const pupil = this.pupils[i]!;
      pupil.position.set(side * 0.043 + value.gazeX * 0.011, 0.051 + value.gazeY * 0.005, 0.109);
      pupil.scale.y = 0.009 * (1 + value.eyeWide * 0.2) * Math.max(0.015, 1 - blink);
      const lid = this.lids[i]!;
      lid.position.set(side * 0.043, 0.067 - blink * 0.016, 0.109);
      lid.scale.set(0.024, 0.004 + blink * 0.011, 0.003);
      lid.visible = blink > 0.01;
      const brow = this.brows[i]!;
      brow.position.set(
        side * 0.043,
        0.08 + value.browOuterUp * 0.018 + value.browInnerUp * 0.01 - value.browDown * 0.012,
        0.097,
      );
      brow.scale.set(0.026, 0.003, 0.004);
      brow.rotation.z = side * (value.browDown * 0.4 - value.browInnerUp * 0.45 + value.browOuterUp * 0.1);
    }
  }
}
