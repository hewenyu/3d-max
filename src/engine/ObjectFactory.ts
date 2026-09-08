import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { SceneObject } from '../../shared/types';
import { ActorRig } from './ActorRig';
import { buildModelGeometry } from '../../shared/modeling-geometry';
import { meshToGeometry } from '../../shared/mesh-geometry';
import type { MeshData } from '../../shared/modeling';
import type { MotionObject } from '../../shared/motion';
import { VehicleRig } from './VehicleRig';
import { EffectRig } from './EffectRig';
import { ModelMorphRig } from '../../shared/model-morph';

export interface BuiltObject {
  root: THREE.Group;
  rig?: ActorRig;
  vehicleRig?: VehicleRig;
  effectRig?: EffectRig;
  mixer?: THREE.AnimationMixer;
  morphRig?: ModelMorphRig;
  asset?: THREE.Object3D;
}

const assets = new Map<string, Promise<GLTF>>();

function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  parent: THREE.Object3D,
  x = 0,
  y = 0,
  z = 0,
) {
  const result = new THREE.Mesh(geometry, material);
  result.position.set(x, y, z);
  result.castShadow = true;
  result.receiveShadow = true;
  parent.add(result);
  return result;
}

export async function buildObject(
  object: SceneObject,
  evaluated?: MeshData | Promise<MeshData>,
): Promise<BuiltObject> {
  const root = new THREE.Group();
  root.name = object.name;
  root.userData.entityId = object.id;
  if ((object as MotionObject).vehicle) {
    const vehicleRig = new VehicleRig(object);
    root.add(vehicleRig.root);
    return { root, vehicleRig };
  }
  if ((object as MotionObject).effect) {
    const effectRig = new EffectRig(object);
    root.add(effectRig.root);
    return { root, effectRig };
  }
  const [w, h, d] = object.dimensions.map((value) => Math.max(0.001, value));
  const material = new THREE.MeshStandardMaterial({
    color: object.tone || '#dddeda',
    roughness: 0.89,
    metalness: 0.015,
  });
  if (object.modeling) {
    let geometry: THREE.BufferGeometry | undefined;
    try {
      // Allocate materials in project order before asynchronous geometry can change render sorting.
      const resolved = evaluated ? await evaluated : undefined;
      geometry = resolved ? meshToGeometry(resolved) : buildModelGeometry(object.modeling);
      if (resolved) geometry.userData.smooth = resolved.smooth;
      material.flatShading =
        (object.modeling.kind === 'mesh' ||
          object.modeling.kind === 'stack' ||
          object.modeling.kind === 'surface') &&
        !geometry.userData.smooth;
      mesh(geometry, material, root);
      return { root };
    } catch (error) {
      geometry?.dispose();
      material.dispose();
      throw error;
    }
  }
  const dark = new THREE.MeshStandardMaterial({ color: '#818b87', roughness: 0.82 });
  const pale = new THREE.MeshStandardMaterial({ color: '#e8eae7', roughness: 0.95 });
  const box = (
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material = material,
  ) => mesh(new THREE.BoxGeometry(width, height, depth), mat, root, x, y, z);
  const leg = (x: number, z: number, height: number, thickness = 0.055) =>
    box(thickness, height, thickness, x, height / 2, z, dark);
  switch (object.type) {
    case 'actor': {
      const rig = new ActorRig(object.tone);
      rig.root.scale.set(w / 0.5, h / 1.78, d / 0.35);
      root.add(rig.root);
      return { root, rig };
    }
    case 'group':
      break;
    case 'sphere': {
      const sphere = mesh(new THREE.SphereGeometry(0.5, 32, 24), material, root, 0, h / 2, 0);
      sphere.scale.set(w, h, d);
      break;
    }
    case 'cylinder': {
      const cylinder = mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 32), material, root, 0, h / 2, 0);
      cylinder.scale.set(w, h, d);
      break;
    }
    case 'plane':
      box(w, h, d, 0, h / 2, 0);
      break;
    case 'wall':
      box(w, h, d, 0, h / 2, 0);
      box(w, 0.09, d + 0.012, 0, 0.045, 0, pale);
      break;
    case 'door': {
      const trim = Math.min(0.09, w * 0.07);
      box(trim, h, d, -w / 2 + trim / 2, h / 2, 0, pale);
      box(trim, h, d, w / 2 - trim / 2, h / 2, 0, pale);
      box(w, trim, d, 0, h - trim / 2, 0, pale);
      box(w - trim * 2, h - trim, Math.min(0.045, d), 0, (h - trim) / 2, 0);
      const handle = mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.12, 12),
        dark,
        root,
        w * 0.29,
        h * 0.46,
        d / 2 + 0.028,
      );
      handle.rotation.z = Math.PI / 2;
      break;
    }
    case 'window': {
      const trim = Math.min(0.07, w * 0.055);
      box(w, trim, d, 0, trim / 2, 0, pale);
      box(w, trim, d, 0, h - trim / 2, 0, pale);
      for (const x of [-w / 2 + trim / 2, 0, w / 2 - trim / 2]) box(trim, h, d, x, h / 2, 0, pale);
      box(w, h * 0.04, d, 0, h / 2, 0, pale);
      const glass = new THREE.MeshStandardMaterial({
        color: '#dce9e7',
        roughness: 0.35,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
      });
      box(w - trim, h - trim, 0.006, 0, h / 2, 0, glass).castShadow = false;
      break;
    }
    case 'sofa': {
      const base = Math.max(0.12, h * 0.23);
      const seat = h * 0.48;
      for (const x of [-w * 0.4, w * 0.4]) for (const z of [-d * 0.34, d * 0.34]) leg(x, z, base, 0.07);
      box(w, h * 0.25, d, 0, base + h * 0.125, 0);
      box(w, h * 0.6, d * 0.19, 0, h * 0.69, -d * 0.405);
      for (const x of [-w * 0.465, w * 0.465]) box(w * 0.07, h * 0.42, d * 0.91, x, seat + h * 0.1, d * 0.02);
      const seats = w > 1.9 ? 3 : 2;
      for (let i = 0; i < seats; i++) {
        const cushionW = (w * 0.85) / seats;
        const x = (i - (seats - 1) / 2) * cushionW;
        box(cushionW - 0.02, h * 0.13, d * 0.77, x, seat, d * 0.075, pale);
        const back = box(cushionW - 0.02, h * 0.35, d * 0.16, x, h * 0.74, -d * 0.27, pale);
        back.rotation.x = -0.1;
      }
      break;
    }
    case 'table': {
      box(w, 0.065, d, 0, h - 0.0325, 0);
      for (const x of [-w * 0.41, w * 0.41]) for (const z of [-d * 0.39, d * 0.39]) leg(x, z, h - 0.065);
      if (h < 0.65) box(w * 0.8, 0.035, d * 0.75, 0, h * 0.25, 0, dark);
      break;
    }
    case 'chair': {
      const seat = h * 0.51;
      box(w, 0.065, d, 0, seat, 0);
      for (const x of [-w * 0.38, w * 0.38])
        for (const z of [-d * 0.38, d * 0.38]) leg(x, z, seat - 0.025, 0.04);
      for (const x of [-w * 0.38, w * 0.38]) box(0.04, h - seat, 0.04, x, (seat + h) / 2, -d * 0.4, dark);
      box(w * 0.9, h * 0.27, 0.065, 0, h * 0.85, -d * 0.4);
      break;
    }
    case 'phone': {
      box(w, h, d, 0, 0, 0, dark);
      box(
        w * 0.86,
        h * 0.88,
        0.002,
        0,
        0,
        d / 2 + 0.001,
        new THREE.MeshStandardMaterial({ color: '#34413d', roughness: 0.3 }),
      );
      box(w * 0.22, h * 0.018, 0.002, 0, h * 0.46, d / 2 + 0.002, pale);
      break;
    }
    case 'model': {
      if (!object.assetUrl) throw new Error(`Model ${object.name} has no asset URL`);
      let pending = assets.get(object.assetUrl);
      if (!pending) {
        pending = new GLTFLoader().loadAsync(object.assetUrl);
        assets.set(object.assetUrl, pending);
        pending.catch(() => assets.delete(object.assetUrl!));
      }
      const gltf = await pending;
      gltf.scene.traverse((child) => {
        const association = gltf.parser.associations.get(child) as
          { meshes?: number; primitives?: number } | undefined;
        if (child instanceof THREE.Mesh && association?.meshes !== undefined)
          child.userData.whiteframeMorphMeshKey = `mesh:${association.meshes}/primitive:${association.primitives ?? 0}`;
      });
      const asset = clone(gltf.scene);
      asset.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (!child.geometry.hasAttribute('normal')) child.geometry.computeVertexNormals();
          child.material = material;
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      const bounds = new THREE.Box3().setFromObject(asset);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      const scale = Math.min(
        w / Math.max(0.001, size.x),
        h / Math.max(0.001, size.y),
        d / Math.max(0.001, size.z),
      );
      asset.scale.multiplyScalar(scale);
      asset.position.add(new THREE.Vector3(-center.x * scale, -bounds.min.y * scale, -center.z * scale));
      root.add(asset);
      const morphRig = new ModelMorphRig(asset);
      if (gltf.animations.length && object.animationIndex !== null) {
        const mixer = new THREE.AnimationMixer(asset);
        const clip =
          object.animationIndex !== undefined
            ? gltf.animations[object.animationIndex]
            : object.animationName !== undefined
              ? gltf.animations.find((item) => item.name === object.animationName)
              : gltf.animations[0];
        if (!clip) throw new Error(`Model animation not found: ${object.name}`);
        mixer.clipAction(clip).play();
        return { root, asset, mixer, morphRig };
      }
      return { root, asset, morphRig };
    }
    default:
      box(w, h, d, 0, h / 2, 0);
  }
  return { root };
}

export function disposeBuiltObject(built: BuiltObject) {
  built.rig?.dispose();
  if (built.mixer && built.asset) {
    built.mixer.stopAllAction();
    built.mixer.uncacheRoot(built.asset);
  }
  const materials = new Set<THREE.Material>();
  built.root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      if (!built.asset) child.geometry.dispose();
      const list = Array.isArray(child.material) ? child.material : [child.material];
      list.forEach((item) => materials.add(item));
    }
  });
  materials.forEach((material) => material.dispose());
  built.root.removeFromParent();
}
