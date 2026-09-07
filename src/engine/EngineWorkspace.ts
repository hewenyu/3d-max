import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { WorkspaceCommand, WorkspaceObservation } from '../../shared/workspace';
import type { ActorConstraintResult } from '../../shared/actor-animation';
import type { BuiltObject } from './ObjectFactory';
import type { SafeArea } from '../../shared/camera-optics';

export function createSafeOverlay(container: HTMLElement) {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'pointer-events:none;position:absolute;display:none;border:1px solid rgba(255,255,255,.45);box-sizing:border-box;z-index:2';
  for (const fraction of [1 / 3, 2 / 3]) {
    const horizontal = document.createElement('div');
    horizontal.style.cssText = `position:absolute;left:0;right:0;top:${fraction * 100}%;border-top:1px dashed rgba(255,255,255,.24)`;
    const vertical = document.createElement('div');
    vertical.style.cssText = `position:absolute;top:0;bottom:0;left:${fraction * 100}%;border-left:1px dashed rgba(255,255,255,.24)`;
    overlay.append(horizontal, vertical);
  }
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.append(overlay);
  return overlay;
}

export function observationState(
  editor: THREE.PerspectiveCamera,
  editOrbit: OrbitControls,
  top: THREE.OrthographicCamera,
  topOrbit: OrbitControls,
): WorkspaceObservation {
  return {
    edit: { position: editor.position.toArray(), target: editOrbit.target.toArray(), fov: editor.fov },
    top: { position: top.position.toArray(), target: topOrbit.target.toArray(), zoom: top.zoom },
  };
}

export function applyObservation(
  input: Extract<WorkspaceCommand, { type: 'observation' }>,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  orbit: OrbitControls,
) {
  const position = input.position ? new THREE.Vector3(...input.position) : camera.position.clone();
  const target = input.target ? new THREE.Vector3(...input.target) : orbit.target.clone();
  if (input.pan) {
    const delta = new THREE.Vector3(...input.pan);
    position.add(delta);
    target.add(delta);
  }
  if (input.orbit && camera instanceof THREE.PerspectiveCamera) {
    const radius = position.distanceTo(target);
    position
      .copy(target)
      .add(
        new THREE.Vector3().setFromSpherical(
          new THREE.Spherical(
            radius,
            THREE.MathUtils.degToRad(input.orbit.polar),
            THREE.MathUtils.degToRad(input.orbit.azimuth),
          ),
        ),
      );
  }
  if (input.dolly) position.sub(target).multiplyScalar(input.dolly).add(target);
  if (
    ![...position.toArray(), ...target.toArray()].every(
      (value) => Number.isFinite(value) && Math.abs(value) <= 1e12,
    )
  )
    throw new Error('Observation position and target must be finite and within 1e12 meters');
  camera.position.copy(position);
  orbit.target.copy(target);
  if (input.fov !== undefined && camera instanceof THREE.PerspectiveCamera) camera.fov = input.fov;
  if (input.zoom !== undefined && camera instanceof THREE.OrthographicCamera) camera.zoom = input.zoom;
  camera.lookAt(orbit.target);
  camera.updateProjectionMatrix();
  orbit.maxDistance = Math.max(65, camera.position.distanceTo(orbit.target) * 4);
  orbit.update();
}

export function captureCanvas(
  source: HTMLCanvasElement,
  frame: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
  safe?: SafeArea,
) {
  if (!safe) return source.toDataURL('image/png');
  const target = document.createElement('canvas');
  target.width = source.width;
  target.height = source.height;
  const context = target.getContext('2d')!;
  context.drawImage(source, 0, 0);
  context.scale(target.width / size.width, target.height / size.height);
  const x = frame.x + frame.width * safe.left;
  const y = frame.y + frame.height * safe.top;
  const width = frame.width * (1 - safe.left - safe.right);
  const height = frame.height * (1 - safe.top - safe.bottom);
  context.strokeStyle = 'rgba(255,255,255,.45)';
  context.lineWidth = 1;
  context.strokeRect(x, y, width, height);
  if (safe.thirds) {
    context.strokeStyle = 'rgba(255,255,255,.24)';
    context.setLineDash([4, 4]);
    for (const fraction of [1 / 3, 2 / 3]) {
      context.beginPath();
      context.moveTo(x, y + height * fraction);
      context.lineTo(x + width, y + height * fraction);
      context.moveTo(x + width * fraction, y);
      context.lineTo(x + width * fraction, y + height);
      context.stroke();
    }
  }
  return target.toDataURL('image/png');
}

export function inspectRenderedObjects(
  objects: Map<string, BuiltObject>,
  constraints: Map<string, ActorConstraintResult[]>,
  ids?: string[],
) {
  const wanted = ids ? new Set(ids) : null;
  return {
    objects: [...objects]
      .filter(([id]) => !wanted || wanted.has(id))
      .map(([id, built]) => {
        built.root.updateWorldMatrix(true, true);
        const bounds = new THREE.Box3().setFromObject(built.root);
        return {
          id,
          name: built.root.name,
          visible: built.root.visible,
          worldPosition: built.root.getWorldPosition(new THREE.Vector3()).toArray(),
          worldQuaternion: built.root.getWorldQuaternion(new THREE.Quaternion()).toArray(),
          worldScale: built.root.getWorldScale(new THREE.Vector3()).toArray(),
          bounds: bounds.isEmpty() ? null : { min: bounds.min.toArray(), max: bounds.max.toArray() },
        };
      }),
    constraints: [...constraints]
      .filter(([id]) => !wanted || wanted.has(id))
      .map(([objectId, results]) => ({ objectId, results })),
  };
}
