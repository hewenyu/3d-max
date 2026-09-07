import { Box3, Vector3 } from 'three';

export function sceneFarPlane(position: Vector3, bounds: Box3): number {
  if (bounds.isEmpty()) return 300;
  const farthest = new Vector3(
    Math.max(Math.abs(bounds.min.x - position.x), Math.abs(bounds.max.x - position.x)),
    Math.max(Math.abs(bounds.min.y - position.y), Math.abs(bounds.max.y - position.y)),
    Math.max(Math.abs(bounds.min.z - position.z), Math.abs(bounds.max.z - position.z)),
  );
  return Math.max(300, Math.ceil(farthest.length() * 1.1));
}
