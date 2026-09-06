import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { z } from 'zod';
import { identifier, timeSchema } from './schema';
import { sampleCamera, sampleObject } from './timeline';
import type { CameraKeyframe, Project, ShotCamera, Vec3 } from './types';
import { id } from './project';

export const cameraMotionSchema = z
  .object({
    id: identifier,
    motion: z.enum(['hold', 'dolly_in', 'dolly_out', 'pan', 'truck', 'pedestal', 'orbit', 'follow']),
    start: timeSchema,
    end: timeSchema,
    distance: z.number().finite().min(-100).max(100).default(1),
    angle: z.number().finite().min(-360).max(360).default(35),
    subjectId: identifier.optional(),
    easing: z.enum(['linear', 'smooth']).default('smooth'),
  })
  .strict();

export type CameraMotion = z.infer<typeof cameraMotionSchema>;

function objectWorldMatrix(project: Project, objectId: string, time: number): Matrix4 {
  const object = project.objects.find((item) => item.id === objectId);
  if (!object) throw new Error('运镜主体不存在');
  const sampled = sampleObject(object, time);
  if (sampled.attachment) throw new Error('跟随预设暂不支持附着道具，请使用摄影机关键帧');
  const rotation = new Quaternion().setFromEuler(
    new Euler(...(sampled.rotation.map((n) => (n * Math.PI) / 180) as Vec3)),
  );
  const local = new Matrix4().compose(
    new Vector3(...sampled.position),
    rotation,
    new Vector3(...sampled.scale),
  );
  return sampled.parentId ? objectWorldMatrix(project, sampled.parentId, time).multiply(local) : local;
}

function subjectPosition(project: Project, objectId: string, time: number): Vector3 {
  const object = project.objects.find((item) => item.id === objectId)!;
  return new Vector3(
    0,
    object.type === 'actor' ? object.dimensions[1] * 0.78 : object.dimensions[1] / 2,
    0,
  ).applyMatrix4(objectWorldMatrix(project, objectId, time));
}

export function buildCameraMotion(
  project: Project,
  camera: ShotCamera,
  input: CameraMotion,
): CameraKeyframe[] {
  if (input.end <= input.start) throw new Error('运镜结束时间必须晚于开始时间');
  if (input.motion === 'follow' && !input.subjectId) throw new Error('跟随镜头需要指定主体');
  if (input.subjectId && !project.objects.some((object) => object.id === input.subjectId))
    throw new Error('运镜主体不存在');
  const initial = sampleCamera(camera, input.start);
  const origin = new Vector3(...initial.position);
  const target = input.subjectId
    ? subjectPosition(project, input.subjectId, input.start)
    : new Vector3(...initial.target);
  const direction = target.clone().sub(origin);
  if (direction.length() < 0.01) throw new Error('摄影机不能与朝向目标重合');
  const forward = direction.clone().normalize();
  const right = forward
    .clone()
    .cross(new Vector3(0, 1, 0))
    .normalize();
  const up = new Vector3(0, 1, 0);
  const movingSubject = input.subjectId ? subjectPosition(project, input.subjectId, input.start) : null;
  const count = ['orbit', 'follow', 'pan'].includes(input.motion) ? 48 : 24;
  const frames: CameraKeyframe[] = [];
  for (let index = 0; index <= count; index++) {
    const fraction = index / count;
    const eased = input.easing === 'smooth' ? fraction * fraction * (3 - 2 * fraction) : fraction;
    const time = input.start + (input.end - input.start) * fraction;
    const position = origin.clone();
    const aim = target.clone();
    if (input.motion === 'dolly_in')
      position.addScaledVector(
        forward,
        Math.min(Math.abs(input.distance), direction.length() * 0.85) * eased,
      );
    if (input.motion === 'dolly_out') position.addScaledVector(forward, -Math.abs(input.distance) * eased);
    if (input.motion === 'truck') {
      position.addScaledVector(right, input.distance * eased);
      aim.addScaledVector(right, input.distance * eased);
    }
    if (input.motion === 'pedestal') {
      position.addScaledVector(up, input.distance * eased);
      aim.addScaledVector(up, input.distance * eased);
    }
    if (input.motion === 'pan')
      aim
        .copy(direction)
        .applyAxisAngle(up, ((input.angle * Math.PI) / 180) * eased)
        .add(origin);
    if (input.motion === 'orbit')
      position
        .sub(target)
        .applyAxisAngle(up, ((input.angle * Math.PI) / 180) * eased)
        .add(target);
    if (input.motion === 'follow' && input.subjectId && movingSubject) {
      const current = subjectPosition(project, input.subjectId, time);
      position.add(current.clone().sub(movingSubject));
      aim.copy(current);
    }
    frames.push({
      id: id('camera-key'),
      time,
      position: position.toArray() as Vec3,
      target: aim.toArray() as Vec3,
      fov: initial.fov,
      easing: 'linear',
    });
  }
  return [
    ...camera.keyframes.filter((frame) => frame.time < input.start || frame.time > input.end),
    ...frames,
  ].sort((a, b) => a.time - b.time);
}
