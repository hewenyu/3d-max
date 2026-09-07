import * as THREE from 'three';
import type { ContinuityFinding, ContinuityRule } from './continuity-types';
import {
  objectEvidenceSignature,
  type ContinuityFrame,
  type ContinuityObjectState,
  type ContinuityScene,
} from './continuity-scene';
import type { Vec3 } from './types';
import { continuityHash } from './continuity-types';

export type FindingInput = Pick<
  ContinuityFinding,
  'rule' | 'severity' | 'objectIds' | 'message' | 'evidence'
> & { otherShotId?: string };
type Emit = (finding: FindingInput) => void;
const vector = (value: THREE.Vector3): Vec3 =>
  value.toArray().map((item) => Math.round(item * 10000) / 10000) as Vec3;
const rounded = (value: number) => Math.round(value * 10000) / 10000;
const projection = (frame: ContinuityFrame) =>
  new THREE.Matrix4().multiplyMatrices(frame.camera.projectionMatrix, frame.camera.matrixWorldInverse);

function visibleHit(hit: THREE.Intersection): string | null {
  if (hit.object instanceof THREE.Mesh) {
    const materials = Array.isArray(hit.object.material) ? hit.object.material : [hit.object.material];
    if (materials.every((material) => material.transparent && material.opacity < 0.8)) return null;
  }
  let id: string | null = null;
  for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
    if (!node.visible) return null;
    id ??= node.userData.entityId ?? null;
  }
  return id;
}

export function inspectFrame(
  frame: ContinuityFrame,
  scene: ContinuityScene,
  emit: Emit,
  previous?: ContinuityFrame,
) {
  const frustum = new THREE.Frustum().setFromProjectionMatrix(projection(frame));
  const ray = new THREE.Raycaster();
  const cameraPosition = frame.camera.position;
  const previousCamera =
    previous && previous.sample.clip?.id === frame.sample.clip?.id ? previous.camera.position : null;
  for (const [id, state] of frame.objects) {
    if (!state.visible) continue;
    if (
      !state.object.actor &&
      state.object.type !== 'group' &&
      !state.object.effect &&
      !state.object.attachment
    ) {
      const item = scene.objects.get(id)!;
      let inside = state.bounds.containsPoint(cameraPosition);
      if (inside && !state.approximation) {
        ray.set(cameraPosition, new THREE.Vector3(0.9187, 0.327, 0.225).normalize());
        ray.near = 0.000001;
        ray.far = Infinity;
        const distances = ray
          .intersectObject(item.root, true)
          .filter((hit) => visibleHit(hit))
          .map((hit) => Math.round(hit.distance * 100000));
        inside = new Set(distances).size % 2 === 1;
      }
      let swept = false;
      if (!inside && previousCamera && previousCamera.distanceTo(cameraPosition) > 0.0001) {
        ray.set(previousCamera, cameraPosition.clone().sub(previousCamera).normalize());
        ray.near = 0.0001;
        ray.far = previousCamera.distanceTo(cameraPosition);
        swept = ray.intersectObject(item.root, true).some((hit) => visibleHit(hit));
      }
      if (inside || swept)
        emit({
          rule: 'camera-collision',
          severity: state.approximation ? 'warning' : 'error',
          objectIds: [id],
          message: inside ? '摄影机位于物体内部' : '摄影机在相邻采样点之间穿过物体表面',
          evidence: {
            cameraPosition: vector(cameraPosition),
            previousCameraPosition: previousCamera ? vector(previousCamera) : null,
            test: inside ? 'inside-volume' : 'swept-segment',
            geometry: state.approximation ? 'proxy-bounds' : 'mesh',
          },
        });
    }
    for (const contact of state.contacts) {
      if (contact.weight <= 0 || ['inactive', 'solved'].includes(contact.status)) continue;
      emit({
        rule: 'contact-error',
        severity: contact.status === 'missing-target' || !contact.reachable ? 'error' : 'warning',
        objectIds: [id],
        message: '接触约束未达到指定目标',
        evidence: {
          constraintId: contact.id,
          effector: contact.effector,
          status: contact.status,
          errorMeters: contact.error === null ? null : rounded(contact.error),
          target: contact.target,
          position: contact.position,
          reachable: contact.reachable,
        },
      });
    }
  }
  for (const id of frame.sample.shot?.subjectIds ?? []) {
    const state = frame.objects.get(id);
    if (!state) continue;
    if (!state.visible || state.bounds.isEmpty() || !frustum.intersectsBox(state.bounds)) {
      emit({
        rule: 'subject-out-of-frame',
        severity: 'warning',
        objectIds: [id],
        message: state.visible ? '镜头主体的包围盒完全位于视锥外' : '镜头主体在当前时间不可见',
        evidence: {
          visible: state.visible,
          projectedCenter: vector(state.center.clone().project(frame.camera)),
          geometry: state.approximation ? 'proxy-bounds' : 'world-bounds',
        },
      });
      continue;
    }
    const targets = state.targets.filter((point) => frustum.containsPoint(point));
    let blocked = 0;
    const occluders = new Set<string>();
    let approximation = state.approximation;
    for (const target of targets) {
      const distance = cameraPosition.distanceTo(target);
      ray.set(cameraPosition, target.clone().sub(cameraPosition).normalize());
      ray.near = 0.025;
      ray.far = Math.max(0.025, distance - 0.03);
      const hitId = ray.intersectObject(scene.root, true).map(visibleHit).find(Boolean);
      if (hitId && hitId !== id && frame.objects.get(hitId)?.object.attachment?.objectId !== id) {
        blocked++;
        occluders.add(hitId);
        approximation ||= frame.objects.get(hitId)?.approximation ?? false;
      }
    }
    if (targets.length >= 2 && blocked / targets.length >= 0.8)
      emit({
        rule: 'subject-occluded',
        severity: 'warning',
        objectIds: [id, ...occluders],
        message: '主体至少八成画内采样点被其他物体遮挡',
        evidence: {
          blockedSamples: blocked,
          testedSamples: targets.length,
          occluderIds: [...occluders],
          geometry: approximation ? 'sampled-rays-with-proxy-bounds' : 'sampled-mesh-rays',
        },
      });
  }
}

function axisSide(frame: ContinuityFrame) {
  const first = frame.objects.get(frame.axis[0])?.position;
  const second = frame.objects.get(frame.axis[1])?.position;
  if (!first || !second) return 0;
  const axis = second.clone().sub(first);
  const camera = frame.camera.position.clone().sub(first);
  return (axis.x * camera.z - axis.z * camera.x) / Math.max(0.001, Math.hypot(axis.x, axis.z));
}

function screenMovement(
  frame: ContinuityFrame,
  object: ContinuityObjectState,
  adjacent: ContinuityFrame | undefined,
  backwards: boolean,
): number {
  const other = adjacent?.objects.get(object.object.id);
  if (!other) return 0;
  const first = (backwards ? other.position : object.position).clone().project(frame.camera);
  const second = (backwards ? object.position : other.position).clone().project(frame.camera);
  return (
    (second.x - first.x) / Math.max(1e-6, Math.abs(frame.sample.sequenceTime - adjacent!.sample.sequenceTime))
  );
}

export function inspectCut(
  before: ContinuityFrame,
  after: ContinuityFrame,
  emit: Emit,
  beforeNeighbor?: ContinuityFrame,
  afterNeighbor?: ContinuityFrame,
) {
  if (before.sceneKey !== after.sceneKey) return;
  const issue = (
    rule: ContinuityRule,
    objectIds: string[],
    message: string,
    evidence: ContinuityFinding['evidence'],
  ) =>
    emit({
      rule,
      severity: 'warning',
      objectIds,
      message,
      evidence: {
        ...evidence,
        beforeState: continuityHash([
          before.sample.shot,
          before.project.cameras.find((camera) => camera.id === before.sample.shot?.cameraId),
          objectEvidenceSignature(before, objectIds),
        ]),
      },
      otherShotId: before.sample.shot?.id,
    });
  const a = axisSide(before),
    b = axisSide(after);
  if (Math.abs(a) > 0.15 && Math.abs(b) > 0.15 && a * b < 0 && before.axis.join() === after.axis.join())
    issue('axis-crossing', [...after.axis], '相邻镜头的摄影机位于人物轴线两侧', {
      beforeSideMeters: rounded(a),
      afterSideMeters: rounded(b),
    });
  for (const [id, current] of after.objects) {
    const previous = before.objects.get(id);
    if (!previous) continue;
    const beforeMotion = screenMovement(before, previous, beforeNeighbor, true);
    const afterMotion = screenMovement(after, current, afterNeighbor, false);
    if (
      previous.visible &&
      current.visible &&
      Math.abs(beforeMotion) > 0.035 &&
      Math.abs(afterMotion) > 0.035 &&
      beforeMotion * afterMotion < 0
    )
      issue('screen-direction', [id], '对象在相邻镜头中的水平运动方向发生反转', {
        beforeNdcPerSecond: rounded(beforeMotion),
        afterNdcPerSecond: rounded(afterMotion),
      });
    if (previous.object.actor && current.object.actor) {
      if (previous.object.actor.lookAtId !== current.object.actor.lookAtId)
        issue('eyeline-switch', [id], '角色在切点处更换注视目标', {
          beforeTargetId: previous.object.actor.lookAtId,
          afterTargetId: current.object.actor.lookAtId,
        });
      const delta = Math.max(
        0,
        ...current.jointPositions.map((point, index) =>
          new THREE.Vector3(...point).distanceTo(
            new THREE.Vector3(...(previous.jointPositions[index] ?? [0, 0, 0])),
          ),
        ),
      );
      if (delta > current.object.dimensions[1] * 0.12)
        issue('action-phase', [id], '角色关节在切点处出现明显姿势跳变', {
          maxJointDisplacementMeters: rounded(delta),
          beforeSourceTime: before.sample.sourceTime,
          afterSourceTime: after.sample.sourceTime,
          beforeAction: previous.object.actor.action,
          afterAction: current.object.actor.action,
        });
    }
    const oldAttachment = previous.object.attachment;
    const attachment = current.object.attachment;
    if (
      (oldAttachment || attachment) &&
      (oldAttachment?.objectId !== attachment?.objectId ||
        oldAttachment?.bone !== attachment?.bone ||
        previous.object.visible !== current.object.visible)
    )
      issue(
        'prop-state',
        [id, ...new Set([oldAttachment?.objectId, attachment?.objectId].filter(Boolean) as string[])],
        '道具的持有人、附着骨骼或可见状态在切点处改变',
        {
          beforeOwnerId: oldAttachment?.objectId ?? null,
          afterOwnerId: attachment?.objectId ?? null,
          beforeBone: oldAttachment?.bone ?? null,
          afterBone: attachment?.bone ?? null,
          beforeVisible: previous.object.visible,
          afterVisible: current.object.visible,
        },
      );
  }
}
