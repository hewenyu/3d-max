import * as THREE from 'three';
import type { Project } from '../../shared/types';
import { sampleCamera } from '../../shared/timeline';

export function rebuildCameraHelpers(group: THREE.Group, project: Project) {
  const aspect = project.settings.aspect === '9:16' ? 9 / 16 : project.settings.aspect === '1:1' ? 1 : 16 / 9;
  for (const source of project.cameras) {
    const sampled = sampleCamera(source, 0, project.settings.aspect);
    const camera = new THREE.PerspectiveCamera(sampled.fov, aspect, 0.12, 0.65);
    camera.position.fromArray(sampled.position);
    camera.lookAt(new THREE.Vector3(...sampled.target));
    camera.updateMatrixWorld(true);
    const helper = new THREE.CameraHelper(camera);
    helper.setColors(
      new THREE.Color('#587f79'),
      new THREE.Color('#587f79'),
      new THREE.Color('#587f79'),
      new THREE.Color('#88a69e'),
      new THREE.Color('#88a69e'),
    );
    helper.userData.entityId = source.id;
    group.add(helper);
    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.11, 0.18),
      new THREE.MeshBasicMaterial({ color: '#587f79' }),
    );
    handle.position.copy(camera.position);
    handle.quaternion.copy(camera.quaternion);
    handle.userData.entityId = source.id;
    group.add(handle);
  }
}

export function updateCameraHelpers(group: THREE.Group, project: Project | null, sourceTime: number) {
  for (const source of project?.cameras ?? []) {
    const sampled = sampleCamera(source, sourceTime, project?.settings.aspect);
    for (const helper of group.children) {
      if (helper.userData.entityId !== source.id) continue;
      if (helper instanceof THREE.CameraHelper) {
        const camera = helper.camera as THREE.PerspectiveCamera;
        camera.position.fromArray(sampled.position);
        camera.lookAt(new THREE.Vector3(...sampled.target));
        camera.fov = sampled.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        helper.update();
      } else {
        helper.position.fromArray(sampled.position);
        helper.lookAt(new THREE.Vector3(...sampled.target));
      }
    }
  }
}
