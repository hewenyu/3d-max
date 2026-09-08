import * as THREE from 'three';
import type { ComponentWorkspaceState } from '../../shared/topology-workspace';
import type { ComponentOverlay } from './ComponentOverlay';

export type ScreenPoint = { x: number; y: number };
export interface ComponentView {
  camera: THREE.Camera;
  frame: { x: number; y: number; width: number; height: number };
  occluders: THREE.Object3D[];
}
function inside(point: ScreenPoint, polygon: ScreenPoint[]) {
  let value = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index],
      b = polygon[previous];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x)
      value = !value;
  }
  return value;
}
function visibleObject(object: THREE.Object3D) {
  for (let item: THREE.Object3D | null = object; item; item = item.parent) if (!item.visible) return false;
  return true;
}
export function pickComponents(
  overlay: ComponentOverlay,
  state: ComponentWorkspaceState,
  view: ComponentView,
  path: ScreenPoint[],
): string[] {
  if (state.mode === 'object' || !path.length) return [];
  const { camera, frame } = view;
  camera.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const pointer = path.at(-1)!;
  const cast = (point: ScreenPoint) =>
    ray.setFromCamera(
      new THREE.Vector2(
        ((point.x - frame.x) / frame.width) * 2 - 1,
        (-(point.y - frame.y) / frame.height) * 2 + 1,
      ),
      camera,
    );
  const faces = overlay.picking.geometry.userData.polygonIndices as Uint32Array;
  if (state.tool === 'pick' && state.mode === 'face') {
    cast(pointer);
    const hit = ray.intersectObject(overlay.picking)[0];
    if (!hit || hit.faceIndex === undefined) return [];
    if (!state.xray) {
      const obstruction = ray
        .intersectObjects(view.occluders, true)
        .find((entry) => visibleObject(entry.object));
      if (obstruction && obstruction.distance < hit.distance - Math.max(1e-5, hit.distance * 1e-6)) return [];
    }
    return [overlay.mesh.identity.faceIds[faces[hit.faceIndex!]]];
  }
  const mesh = overlay.mesh;
  const topology = overlay.topology;
  const world = overlay.picking.matrixWorld;
  const points = mesh.vertices.map((point) => new THREE.Vector3(...point).applyMatrix4(world));
  const projected = points.map((point) => {
    const ndc = point.clone().project(camera);
    return {
      x: frame.x + ((ndc.x + 1) / 2) * frame.width,
      y: frame.y + ((1 - ndc.y) / 2) * frame.height,
      z: ndc.z,
    };
  });
  const visible = (point: THREE.Vector3, pixel: ScreenPoint) => {
    if (state.xray) return true;
    cast(pixel);
    const distance = point.clone().sub(ray.ray.origin).dot(ray.ray.direction);
    const own = ray.intersectObject(overlay.picking)[0];
    const other = ray.intersectObjects(view.occluders, true).find((entry) => visibleObject(entry.object));
    const nearest = Math.min(own?.distance ?? Infinity, other?.distance ?? Infinity);
    return distance <= nearest + Math.max(0.00001, distance * 0.00001);
  };
  const polygon =
    state.tool === 'box' && path.length > 1
      ? [path[0], { x: pointer.x, y: path[0].y }, pointer, { x: path[0].x, y: pointer.y }]
      : path;
  const hits: { id: string; distance: number; depth: number }[] = [];
  const candidates =
    state.mode === 'vertex'
      ? mesh.vertices.map((_, index) => ({ id: mesh.identity.vertexIds[index], vertices: [index] }))
      : state.mode === 'edge'
        ? topology.edges.map((edge) => ({ id: edge.id, vertices: [...edge.vertices] }))
        : mesh.faces.map((vertices, index) => ({ id: mesh.identity.faceIds[index], vertices }));
  for (const candidate of candidates) {
    const projectedPoints = candidate.vertices.map((index) => projected[index]);
    if (projectedPoints.some((point) => point.z < -1 || point.z > 1)) continue;
    let position = candidate.vertices
      .reduce((sum, index) => sum.add(points[index]), new THREE.Vector3())
      .multiplyScalar(1 / candidate.vertices.length);
    let pixel = projectedPoints.reduce(
      (sum, point) => ({
        x: sum.x + point.x / projectedPoints.length,
        y: sum.y + point.y / projectedPoints.length,
      }),
      { x: 0, y: 0 },
    );
    if (state.tool === 'pick' && state.mode === 'edge') {
      const [a, b] = projectedPoints;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const t = THREE.MathUtils.clamp(
        ((pointer.x - a.x) * dx + (pointer.y - a.y) * dy) / Math.max(1e-12, dx * dx + dy * dy),
        0,
        1,
      );
      pixel = { x: a.x + dx * t, y: a.y + dy * t };
      cast(pixel);
      const onRay = new THREE.Vector3();
      position = new THREE.Vector3();
      ray.ray.distanceSqToSegment(
        points[candidate.vertices[0]],
        points[candidate.vertices[1]],
        onRay,
        position,
      );
    }
    const distance = Math.hypot(pixel.x - pointer.x, pixel.y - pointer.y);
    const contains =
      state.tool === 'pick' ? distance <= 10 : projectedPoints.every((point) => inside(point, polygon));
    if (contains && visible(position, pixel))
      hits.push({ id: candidate.id, distance, depth: position.distanceTo(camera.position) });
  }
  return (
    state.tool === 'pick'
      ? hits.sort((a, b) => a.distance - b.distance || a.depth - b.depth).slice(0, 1)
      : hits
  ).map((hit) => hit.id);
}
