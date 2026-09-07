import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { ContinuityScene } from './continuity-scene';
import { sampleObject } from './object-sampling';
import type { Project, SceneObject, Vec3 } from './types';

export function createCameraSubjectSampler(project: Project, subjectId: string) {
  const objects = new Map(project.objects.map((object) => [object.id, object]));
  const subject = objects.get(subjectId);
  if (!subject) throw new Error('运镜主体不存在');
  const visited = new Set<string>();
  const needsRig = (object: SceneObject): boolean => {
    if (visited.has(object.id)) return false;
    visited.add(object.id);
    if (object.attachment || object.keyframes.some((key) => key.attachment)) return true;
    const parent = object.parentId ? objects.get(object.parentId) : undefined;
    return parent ? needsRig(parent) : false;
  };
  const rig = needsRig(subject) ? new ContinuityScene(project, 'camera-motion') : null;
  const attachmentTimes = new Set<number>();
  const dependencies = new Set<string>();
  const collectAttachments = (object: SceneObject) => {
    if (dependencies.has(object.id)) return;
    dependencies.add(object.id);
    const ids = [object.parentId, object.attachment?.objectId];
    for (const key of object.keyframes) {
      if (key.attachment !== undefined) attachmentTimes.add(key.time);
      ids.push(key.attachment?.objectId);
    }
    for (const id of ids) {
      const target = id ? objects.get(id) : undefined;
      if (target) collectAttachments(target);
    }
  };
  if (rig) collectAttachments(subject);
  const localWorld = (object: SceneObject, time: number): Matrix4 => {
    const sampled = sampleObject(object, time, { render: true });
    const local = new Matrix4().compose(
      new Vector3(...sampled.position),
      new Quaternion().setFromEuler(
        new Euler(...(sampled.rotation.map((angle) => (angle * Math.PI) / 180) as Vec3)),
      ),
      new Vector3(...sampled.scale),
    );
    const parent = sampled.parentId ? objects.get(sampled.parentId) : undefined;
    return parent ? localWorld(parent, time).multiply(local) : local;
  };
  let previousTime = Number.NaN;
  let previousMatrix = new Matrix4();
  const matrix = (time: number) => {
    if (time !== previousTime) {
      if (rig) {
        rig.sampleTransforms(time);
        previousMatrix = rig.objects.get(subjectId)!.root.matrixWorld.clone();
      } else previousMatrix = localWorld(subject, time);
      previousTime = time;
    }
    return previousMatrix.clone();
  };
  return {
    matrix,
    attachmentTimes,
    position(time: number) {
      const height =
        subject.type === 'actor'
          ? subject.dimensions[1] * 0.78
          : subject.type === 'phone'
            ? 0
            : subject.dimensions[1] / 2;
      return new Vector3(0, height, 0).applyMatrix4(matrix(time));
    },
    dispose() {
      rig?.dispose();
    },
  };
}
