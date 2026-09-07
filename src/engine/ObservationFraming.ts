import { Box3, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';

export function fitPerspectiveObservation(
  bounds: Box3,
  camera: PerspectiveCamera,
  target: Vector3,
  padding = 1.15,
) {
  const center = bounds.getCenter(new Vector3());
  const backward = camera.position.clone().sub(target);
  if (backward.lengthSq() < 1e-12) backward.set(1, 0.8, 1);
  backward.normalize();
  if (new Vector3().crossVectors(camera.up, backward).lengthSq() < 1e-12) {
    const offset = Math.abs(backward.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
    backward.addScaledVector(offset, 0.0001).normalize();
  }
  const right = new Vector3().crossVectors(camera.up, backward).normalize();
  const up = new Vector3().crossVectors(backward, right).normalize();
  const tanVertical = Math.tan((camera.getEffectiveFOV() * Math.PI) / 360);
  const tanHorizontal = tanVertical * camera.aspect;
  let distance = 0.25;
  const corner = new Vector3();
  // Depth matters: the nearest corner has less usable frustum area than the center.
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) {
        corner.set(x, y, z).sub(center);
        const depth = corner.dot(backward);
        distance = Math.max(
          distance,
          depth + (padding * Math.abs(corner.dot(right))) / tanHorizontal,
          depth + (padding * Math.abs(corner.dot(up))) / tanVertical,
          depth + camera.near + 0.1,
        );
      }
  return { center, position: center.clone().addScaledVector(backward, distance), distance };
}

export function fitTopObservation(bounds: Box3, camera: OrthographicCamera, padding = 1.15) {
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const position = new Vector3(center.x, bounds.max.y + Math.max(1, size.length() * 0.1), center.z);
  const zoom = Math.min(
    6,
    (camera.right - camera.left) / (Math.max(size.x, 0.001) * padding),
    (camera.top - camera.bottom) / (Math.max(size.z, 0.001) * padding),
  );
  return { center, position, zoom, distance: position.distanceTo(center) };
}
