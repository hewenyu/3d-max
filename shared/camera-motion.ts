import { Vector3 } from 'three';
import { z } from 'zod';
import { identifier, timeSchema } from './schema';
import { sampleCamera } from './timeline';
import type { CameraKeyframe, Project, ShotCamera, Vec3 } from './types';
import { id } from './project';
import { createCameraSubjectSampler } from './camera-subject';
import { cameraMotionTiming } from './camera-motion-time';

export const cameraMotionSchema = z
  .object({
    id: identifier,
    shotId: identifier.optional(),
    sequenceId: identifier.optional(),
    clipId: identifier.optional(),
    aspect: z.enum(['16:9', '9:16', '1:1']).optional(),
    motion: z.enum(['hold', 'dolly_in', 'dolly_out', 'pan', 'truck', 'pedestal', 'orbit', 'follow']),
    start: timeSchema,
    end: timeSchema,
    distance: z.number().finite().min(-100).max(100).default(1),
    angle: z.number().finite().min(-360).max(360).default(35),
    subjectId: identifier.optional(),
    rotateWithSubject: z.boolean().default(false),
    easing: z.enum(['linear', 'smooth']).default('smooth'),
  })
  .strict();

export type CameraMotion = z.infer<typeof cameraMotionSchema>;

export function buildCameraMotion(
  project: Project,
  camera: ShotCamera,
  input: CameraMotion,
): CameraKeyframe[] {
  if (input.end <= input.start) throw new Error('运镜结束时间必须晚于开始时间');
  if (input.motion === 'follow' && !input.subjectId) throw new Error('跟随镜头需要指定主体');
  const timing = cameraMotionTiming(project, camera, input);
  if (input.subjectId && !timing.project.objects.some((object) => object.id === input.subjectId))
    throw new Error('运镜主体不存在');
  const subject = input.subjectId ? createCameraSubjectSampler(timing.project, input.subjectId) : null;
  try {
    const initial = sampleCamera(camera, timing.initialTime);
    const initialSourceTime = timing.sourceTime(timing.initialTime);
    const origin = new Vector3(...initial.position);
    const target = subject ? subject.position(initialSourceTime) : new Vector3(...initial.target);
    const direction = target.clone().sub(origin);
    if (direction.length() < 0.01) throw new Error('摄影机不能与朝向目标重合');
    const forward = direction.clone().normalize();
    const right = forward
      .clone()
      .cross(new Vector3(0, 1, 0))
      .normalize();
    const up = new Vector3(0, 1, 0);
    const movingSubject = subject ? subject.position(initialSourceTime) : null;
    const mounted = input.motion === 'follow' && input.rotateWithSubject && input.subjectId;
    const initialInverse = mounted ? subject!.matrix(initialSourceTime).invert() : null;
    const mountPosition = initialInverse ? origin.clone().applyMatrix4(initialInverse) : null;
    const mountTarget = initialInverse ? new Vector3(...initial.target).applyMatrix4(initialInverse) : null;
    const count = Math.max(24, Math.ceil(timing.duration * project.settings.fps));
    if (count > 36000) throw new Error('单次运镜生成不能超过 36000 个关键帧');
    const times = new Set(
      Array.from({ length: count + 1 }, (_, index) =>
        Math.max(input.start, Math.min(input.end, timing.sampleTime(index / count))),
      ),
    );
    times.add(input.start);
    times.add(input.end);
    const eventSourceTimes = new Map<number, number>();
    const stepTimes = new Set<number>();
    if (input.motion === 'follow')
      for (const sourceTime of subject?.attachmentTimes ?? []) {
        const time = timing.cameraTime(sourceTime);
        if (time > input.start && time < input.end) {
          const adjacent = timing.reverse
            ? Math.min(input.end, time + 1e-7)
            : Math.max(input.start, time - 1e-7);
          times.add(adjacent);
          times.add(time);
          eventSourceTimes.set(time, sourceTime);
          stepTimes.add(timing.reverse ? adjacent : time);
        }
      }
    if (times.size > 36001) throw new Error('单次运镜生成不能超过 36000 个关键帧');
    const frames: CameraKeyframe[] = [];
    for (const time of [...times].sort((left, right) => left - right)) {
      const fraction = timing.fraction(time);
      const sourceTime = eventSourceTimes.get(time) ?? timing.sourceTime(time);
      const eased = input.easing === 'smooth' ? fraction * fraction * (3 - 2 * fraction) : fraction;
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
        if (mounted && mountPosition && mountTarget) {
          const transform = subject!.matrix(sourceTime);
          position.copy(mountPosition).applyMatrix4(transform);
          aim.copy(mountTarget).applyMatrix4(transform);
        } else {
          const current = subject!.position(sourceTime);
          position.add(current.clone().sub(movingSubject));
          aim.copy(current);
        }
      }
      frames.push({
        id: id('camera-key'),
        time,
        position: position.toArray() as Vec3,
        target: aim.toArray() as Vec3,
        fov: initial.fov,
        easing: stepTimes.has(time) ? 'step' : 'linear',
      });
    }
    return [
      ...camera.keyframes.filter((frame) => frame.time < input.start || frame.time > input.end),
      ...frames,
    ].sort((a, b) => a.time - b.time);
  } finally {
    subject?.dispose();
  }
}
