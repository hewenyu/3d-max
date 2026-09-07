import * as THREE from 'three';
import { z } from 'zod';
import type { Action, ActorPose, Vec3 } from './types';

export const actorJointNames = [
  'hips',
  'chest',
  'head',
  'leftArm',
  'rightArm',
  'leftElbow',
  'rightElbow',
  'leftHand',
  'rightHand',
  'leftLeg',
  'rightLeg',
  'leftKnee',
  'rightKnee',
  'leftFoot',
  'rightFoot',
] as const;
export type ActorJointName = (typeof actorJointNames)[number];
export const actorActionNames = [
  'idle',
  'walk',
  'run',
  'sit',
  'stand',
  'punch',
  'kick',
  'block',
  'dodge',
  'hit',
  'fall',
  'getup',
  'weapon',
  'gesture',
] as const;
export type ActorActionName = (typeof actorActionNames)[number];
const coordinate = z.number().finite().min(-100000).max(100000);
const vector = z.tuple([coordinate, coordinate, coordinate]);
const angle = z.number().finite().min(-360).max(360);
const rotation = z.tuple([angle, angle, angle]);
const identifier = z.string().min(1).max(200);
const time = z.number().finite().min(0).max(86400);
const interval = {
  start: time,
  end: time,
  weight: z.number().min(0).max(1).default(1),
  fadeIn: time.default(0),
  fadeOut: time.default(0),
};
export const actorClipSchema = z
  .object({
    id: identifier,
    action: z.enum(actorActionNames),
    ...interval,
    sourceOffset: time.default(0),
    speed: z
      .number()
      .finite()
      .min(-16)
      .max(16)
      .refine((value) => Math.abs(value) >= 0.01, 'Speed must be nonzero')
      .default(1),
    loop: z.boolean().default(false),
    mirror: z.boolean().default(false),
  })
  .strict();
export const actorConstraintTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('world'), position: vector }).strict(),
  z
    .object({
      kind: z.literal('object'),
      objectId: identifier,
      bone: z.enum(['root', ...actorJointNames]).optional(),
      offset: vector.default([0, 0, 0]),
    })
    .strict(),
]);
export const actorConstraintSchema = z
  .object({
    id: identifier,
    effector: z.enum(['leftHand', 'rightHand', 'leftFoot', 'rightFoot']),
    ...interval,
    target: actorConstraintTargetSchema,
    iterations: z.number().int().min(1).max(128).default(48),
    tolerance: z.number().positive().max(1).default(0.02),
  })
  .strict();
export const actorJointKeySchema = z
  .object({
    id: identifier,
    time,
    joint: z.enum(actorJointNames),
    rotation,
    hipsOffset: vector.optional(),
    easing: z.enum(['linear', 'smooth']).default('linear'),
  })
  .strict();
export const actorAnimationSchema = z
  .object({
    clips: z.array(actorClipSchema).max(512).default([]),
    constraints: z.array(actorConstraintSchema).max(256).default([]),
    jointKeys: z.array(actorJointKeySchema).max(8192).default([]),
  })
  .strict()
  .superRefine((animation, context) => {
    const ids = new Set<string>();
    for (const name of ['clips', 'constraints', 'jointKeys'] as const) {
      animation[name].forEach((item, index) => {
        if (ids.has(item.id))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name, index, 'id'],
            message: 'Actor animation IDs must be unique',
          });
        ids.add(item.id);
      });
    }
    for (const name of ['clips', 'constraints'] as const) {
      animation[name].forEach((item, index) => {
        if (item.end <= item.start)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name, index, 'end'],
            message: 'End must follow start',
          });
        if (item.fadeIn + item.fadeOut > item.end - item.start + 1e-8)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name, index, 'fadeIn'],
            message: 'Fade durations must fit inside the interval',
          });
      });
    }
    const keys = new Set<string>();
    animation.jointKeys.forEach((key, index) => {
      const channelTime = `${key.joint}:${key.time}`;
      if (keys.has(channelTime))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['jointKeys', index, 'time'],
          message: 'A joint can have only one key at each time',
        });
      keys.add(channelTime);
      if (key.hipsOffset && key.joint !== 'hips')
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['jointKeys', index, 'hipsOffset'],
          message: 'Body translation belongs to the hips joint',
        });
    });
  });
export type ActorAnimation = z.infer<typeof actorAnimationSchema>;
export type ActorClip = z.infer<typeof actorClipSchema>;
export type ActorConstraint = z.infer<typeof actorConstraintSchema>;
export type ActorJointKey = z.infer<typeof actorJointKeySchema>;
export type ActorConstraintTarget = z.infer<typeof actorConstraintTargetSchema>;
export type ActorEffector = ActorConstraint['effector'];
export interface ActorConstraintResult {
  id: string;
  effector: ActorEffector;
  target: Vec3 | null;
  position: Vec3;
  error: number | null;
  reachable: boolean;
  reached: boolean;
  weight: number;
  status: 'inactive' | 'missing-target' | 'unreachable' | 'solved' | 'partial';
}

export const actorActionCatalog: {
  action: ActorActionName;
  label: string;
  duration: number;
  loop: boolean;
}[] = [
  { action: 'idle', label: '站立', duration: 4, loop: true },
  { action: 'walk', label: '行走', duration: 1, loop: true },
  { action: 'run', label: '跑步', duration: 0.7, loop: true },
  { action: 'sit', label: '坐下', duration: 1.2, loop: false },
  { action: 'stand', label: '起立', duration: 1.2, loop: false },
  { action: 'punch', label: '出拳', duration: 0.7, loop: false },
  { action: 'kick', label: '踢击', duration: 1, loop: false },
  { action: 'block', label: '格挡', duration: 0.9, loop: false },
  { action: 'dodge', label: '闪避', duration: 1.1, loop: false },
  { action: 'hit', label: '受击', duration: 0.8, loop: false },
  { action: 'fall', label: '倒地', duration: 1.6, loop: false },
  { action: 'getup', label: '起身', duration: 2.1, loop: false },
  { action: 'weapon', label: '持械挥击', duration: 1.1, loop: false },
  { action: 'gesture', label: '手势', duration: 2, loop: true },
];
export const actorJointLabels: Record<ActorJointName, string> = {
  hips: '骨盆',
  chest: '躯干',
  head: '头部',
  leftArm: '左肩',
  rightArm: '右肩',
  leftElbow: '左肘',
  rightElbow: '右肘',
  leftHand: '左腕',
  rightHand: '右腕',
  leftLeg: '左髋',
  rightLeg: '右髋',
  leftKnee: '左膝',
  rightKnee: '右膝',
  leftFoot: '左踝',
  rightFoot: '右踝',
};
type Rotations = Partial<Record<ActorJointName, Vec3>>;
interface PoseFrame {
  time: number;
  rotations: Rotations;
  offset?: Vec3;
}
const rest: Rotations = {
  leftArm: [-5, 0, 6],
  rightArm: [-5, 0, -6],
  leftElbow: [-6, 0, 0],
  rightElbow: [-6, 0, 0],
};
const guard: Rotations = {
  chest: [8, -10, 0],
  head: [-4, 10, 0],
  leftArm: [-45, 0, 15],
  rightArm: [-55, 0, -14],
  leftElbow: [-90, 0, 0],
  rightElbow: [-90, 0, 0],
  leftLeg: [-12, 0, -5],
  rightLeg: [-8, 0, 5],
  leftKnee: [18, 0, 0],
  rightKnee: [14, 0, 0],
};
const sitting: Rotations = {
  chest: [8, 0, 0],
  leftLeg: [-80, 0, 0],
  rightLeg: [-80, 0, 0],
  leftKnee: [95, 0, 0],
  rightKnee: [95, 0, 0],
  leftElbow: [-65, 0, 0],
  rightElbow: [-65, 0, 0],
};
const lying: Rotations = {
  hips: [-88, 0, 0],
  chest: [0, 0, 0],
  head: [8, 0, 0],
  leftArm: [-30, 0, 40],
  rightArm: [-40, 0, -55],
  leftLeg: [-6, 0, -6],
  rightLeg: [8, 0, 10],
  leftKnee: [12, 0, 0],
  rightKnee: [20, 0, 0],
};
function frame(time: number, rotations: Rotations = {}, offset: Vec3 = [0, 0, 0]): PoseFrame {
  return { time, rotations: { ...rest, ...rotations }, offset };
}
function combat(time: number, rotations: Rotations = {}, offset: Vec3 = [0, -0.035, 0]): PoseFrame {
  return frame(time, { ...guard, ...rotations }, offset);
}
function actionFrames(action: ActorActionName): PoseFrame[] {
  switch (action) {
    case 'idle':
      return [
        frame(0),
        frame(1, { chest: [-1, 0, 0] }, [0, 0.004, 0]),
        frame(2),
        frame(3, { chest: [1, 0, 0] }, [0, -0.003, 0]),
        frame(4),
      ];
    case 'walk':
      return [0, 0.25, 0.5, 0.75, 1].map((time, index) =>
        frame(
          time,
          {
            leftLeg: [[-28, 0, 28, 0, -28][index], 0, 0],
            rightLeg: [[28, 0, -28, 0, 28][index], 0, 0],
            leftKnee: [[8, 6, 12, 60, 8][index], 0, 0],
            rightKnee: [[12, 60, 8, 6, 12][index], 0, 0],
            leftArm: [[18, 0, -18, 0, 18][index], 0, 6],
            rightArm: [[-18, 0, 18, 0, -18][index], 0, -6],
            chest: [3, [0, 3, 0, -3, 0][index], 0],
          },
          [0, index % 2 ? 0.018 : 0, 0],
        ),
      );
    case 'run':
      return [0, 0.175, 0.35, 0.525, 0.7].map((time, index) =>
        frame(
          time,
          {
            chest: [15, 0, 0],
            head: [-8, 0, 0],
            leftLeg: [[-52, 0, 48, 0, -52][index], 0, 0],
            rightLeg: [[48, 0, -52, 0, 48][index], 0, 0],
            leftKnee: [[22, 15, 38, 105, 22][index], 0, 0],
            rightKnee: [[38, 105, 22, 15, 38][index], 0, 0],
            leftArm: [[40, -5, -50, -5, 40][index], 0, 8],
            rightArm: [[-50, -5, 40, -5, -50][index], 0, -8],
            leftElbow: [-80, 0, 0],
            rightElbow: [-80, 0, 0],
          },
          [0, index % 2 ? 0.09 : 0.025, 0],
        ),
      );
    case 'sit':
      return [
        frame(0),
        frame(0.3, { chest: [22, 0, 0], leftKnee: [20, 0, 0], rightKnee: [20, 0, 0] }, [0, -0.06, 0]),
        frame(0.9, sitting, [0, -0.43, -0.07]),
        frame(1.2, sitting, [0, -0.43, -0.07]),
      ];
    case 'stand':
      return actionFrames('sit')
        .map((value) => ({ ...value, time: 1.2 - value.time }))
        .reverse();
    case 'punch':
      return [
        combat(0),
        combat(0.18, { chest: [-3, -25, 0], rightArm: [-60, -20, -10], rightElbow: [-120, 0, 0] }),
        combat(
          0.33,
          { chest: [12, 20, 0], rightArm: [-90, 10, 0], rightElbow: [-5, 0, 0], rightHand: [0, 0, -8] },
          [0, -0.035, 0.08],
        ),
        combat(
          0.44,
          { chest: [8, 10, 0], rightArm: [-85, 6, 0], rightElbow: [-15, 0, 0] },
          [0, -0.035, 0.05],
        ),
        combat(0.7),
      ];
    case 'kick':
      return [
        combat(0),
        combat(0.25, { rightLeg: [-85, 5, -10], rightKnee: [110, 0, 0], chest: [-8, 0, 0] }),
        combat(
          0.48,
          {
            rightLeg: [-90, 0, -10],
            rightKnee: [5, 0, 0],
            chest: [-20, 0, 0],
            leftArm: [-30, 0, 35],
            rightArm: [-20, 0, -45],
          },
          [0, 0, 0.04],
        ),
        combat(0.7, { rightLeg: [-70, 0, -10], rightKnee: [90, 0, 0], chest: [-8, 0, 0] }),
        combat(1),
      ];
    case 'block':
      return [
        combat(0),
        combat(0.22, {
          leftArm: [-110, 10, 30],
          leftElbow: [-85, 0, 0],
          rightArm: [-95, -10, -25],
          rightElbow: [-85, 0, 0],
          head: [12, 0, 0],
        }),
        combat(
          0.62,
          {
            leftArm: [-110, 10, 30],
            leftElbow: [-85, 0, 0],
            rightArm: [-95, -10, -25],
            rightElbow: [-85, 0, 0],
            chest: [12, 0, 0],
          },
          [0, -0.05, -0.04],
        ),
        combat(0.9),
      ];
    case 'dodge':
      return [
        combat(0),
        combat(
          0.3,
          {
            chest: [25, 0, -25],
            leftLeg: [-20, 0, -20],
            rightLeg: [-20, 0, 20],
            leftKnee: [60, 0, 0],
            rightKnee: [60, 0, 0],
          },
          [-0.25, -0.24, -0.12],
        ),
        combat(
          0.7,
          {
            chest: [15, 20, -15],
            leftLeg: [-15, 0, -15],
            rightLeg: [-15, 0, 15],
            leftKnee: [40, 0, 0],
            rightKnee: [40, 0, 0],
          },
          [-0.2, -0.14, -0.08],
        ),
        combat(1.1),
      ];
    case 'hit':
      return [
        combat(0),
        combat(
          0.16,
          { chest: [-25, 10, 12], head: [-18, 0, 15], leftArm: [-30, 0, 30], rightArm: [-40, 0, -30] },
          [0, -0.09, -0.12],
        ),
        combat(0.42, { chest: [20, 0, 5], head: [15, 0, 5] }, [0, -0.06, -0.07]),
        combat(0.8),
      ];
    case 'fall':
      return [
        combat(0),
        combat(
          0.3,
          { chest: [-35, 0, 0], head: [-15, 0, 0], leftKnee: [55, 0, 0], rightKnee: [55, 0, 0] },
          [0, -0.25, -0.1],
        ),
        frame(0.85, { ...lying, hips: [-60, 0, 0] }, [0, -0.55, -0.25]),
        frame(1.2, lying, [0, -0.68, -0.35]),
        frame(1.6, lying, [0, -0.68, -0.35]),
      ];
    case 'getup':
      return [
        frame(0, lying, [0, -0.68, -0.35]),
        frame(
          0.5,
          {
            ...lying,
            hips: [-60, 0, 35],
            rightArm: [-60, 0, -60],
            rightElbow: [-40, 0, 0],
            leftLeg: [-50, 0, 0],
            leftKnee: [90, 0, 0],
          },
          [0, -0.59, -0.25],
        ),
        frame(
          1.15,
          {
            chest: [40, 0, 0],
            leftLeg: [-55, 0, 0],
            rightLeg: [-55, 0, 0],
            leftKnee: [105, 0, 0],
            rightKnee: [105, 0, 0],
            leftArm: [-40, 0, 0],
            rightArm: [-40, 0, 0],
          },
          [0, -0.32, -0.1],
        ),
        combat(1.8),
        combat(2.1),
      ];
    case 'weapon':
      return [
        combat(0),
        combat(0.3, {
          rightArm: [-145, -25, -25],
          rightElbow: [-60, 0, 0],
          chest: [-15, -30, 0],
          head: [5, 25, 0],
        }),
        combat(
          0.57,
          {
            rightArm: [-65, 30, -50],
            rightElbow: [-15, 0, 0],
            rightHand: [0, 0, 20],
            chest: [25, 45, 0],
            head: [-10, -25, 0],
          },
          [0, -0.07, 0.06],
        ),
        combat(0.78, { rightArm: [-30, 20, -40], rightElbow: [-25, 0, 0], chest: [15, 20, 0] }),
        combat(1.1),
      ];
    case 'gesture':
      return [
        frame(0),
        frame(0.5, {
          rightArm: [-45, 0, -25],
          rightElbow: [-80, 0, 0],
          rightHand: [0, 0, -20],
          head: [0, -8, 0],
        }),
        frame(1, {
          rightArm: [-38, 0, -40],
          rightElbow: [-90, 0, 0],
          rightHand: [0, 0, 15],
          head: [2, 10, 0],
        }),
        frame(1.5, { rightArm: [-50, 0, -20], rightElbow: [-70, 0, 0], head: [-2, -5, 0] }),
        frame(2),
      ];
  }
}

function quaternion(degrees: Vec3): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...(degrees.map(THREE.MathUtils.degToRad) as Vec3), 'XYZ'),
  );
}
function mirroredJoint(joint: ActorJointName): ActorJointName {
  return (
    joint.startsWith('left')
      ? joint.replace('left', 'right')
      : joint.startsWith('right')
        ? joint.replace('right', 'left')
        : joint
  ) as ActorJointName;
}
export function createActorActionClip(action: ActorActionName, mirror = false): THREE.AnimationClip {
  const frames = actionFrames(action);
  const times = frames.map((value) => value.time);
  const tracks: THREE.KeyframeTrack[] = actorJointNames.map((joint) => {
    const values = frames.flatMap((value) => {
      const source = value.rotations[mirror ? mirroredJoint(joint) : joint] ?? [0, 0, 0];
      return quaternion(mirror ? [source[0], -source[1], -source[2]] : source).toArray();
    });
    return new THREE.QuaternionKeyframeTrack(`${joint}.quaternion`, times, values);
  });
  tracks.push(
    new THREE.VectorKeyframeTrack(
      'hips.position',
      times,
      frames.flatMap((value) => {
        const offset = value.offset ?? [0, 0, 0];
        return [mirror ? -offset[0] : offset[0], 0.91 + offset[1], offset[2]];
      }),
    ),
  );
  return new THREE.AnimationClip(`${action}${mirror ? '-mirrored' : ''}`, times.at(-1)!, tracks);
}

export function actorIntervalWeight(
  value: Pick<ActorClip, 'start' | 'end' | 'weight' | 'fadeIn' | 'fadeOut'>,
  at: number,
): number {
  if (at < value.start || at >= value.end) return 0;
  const fade = (fraction: number) => THREE.MathUtils.smoothstep(fraction, 0, 1);
  const enter = value.fadeIn > 0 ? fade((at - value.start) / value.fadeIn) : 1;
  const leave = value.fadeOut > 0 ? fade((value.end - at) / value.fadeOut) : 1;
  return value.weight * enter * leave;
}

function jointKeysClip(keys: ActorJointKey[]): THREE.AnimationClip | null {
  if (!keys.length) return null;
  const tracks: THREE.KeyframeTrack[] = [];
  for (const joint of actorJointNames) {
    const channel = keys.filter((key) => key.joint === joint).sort((a, b) => a.time - b.time);
    if (!channel.length) continue;
    const times: number[] = [];
    const rotations: number[] = [];
    const offsets: number[] = [];
    let previousOffset: Vec3 = [0, 0, 0];
    const positions = channel.map((key) => (previousOffset = key.hipsOffset ?? previousOffset));
    channel.forEach((key, index) => {
      const previous = channel[index - 1];
      if (previous && key.easing === 'smooth') {
        const from = quaternion(previous.rotation);
        const to = quaternion(key.rotation);
        for (let step = 1; step < 16; step++) {
          const fraction = step / 16;
          const weight = THREE.MathUtils.smoothstep(fraction, 0, 1);
          times.push(THREE.MathUtils.lerp(previous.time, key.time, fraction));
          rotations.push(...from.clone().slerp(to, weight).toArray());
          offsets.push(
            ...new THREE.Vector3(...positions[index - 1])
              .lerp(new THREE.Vector3(...positions[index]), weight)
              .toArray(),
          );
        }
      }
      times.push(key.time);
      rotations.push(...quaternion(key.rotation).toArray());
      offsets.push(...positions[index]);
    });
    tracks.push(new THREE.QuaternionKeyframeTrack(`${joint}.quaternion`, times, rotations));
    if (joint === 'hips') tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, offsets));
  }
  return new THREE.AnimationClip(
    'custom-joints',
    Math.max(0.001, ...keys.map((key) => key.time)),
    tracks,
    THREE.AdditiveAnimationBlendMode,
  );
}

export interface ActorAnimationSample {
  rotations: Record<ActorJointName, [number, number, number, number]>;
  hipsOffset: Vec3;
  activeClips: { id: string; time: number; weight: number }[];
}
export interface ActorAnimationFallback {
  action?: Action;
  distance?: number;
  speed?: number;
  pose?: ActorPose;
}

export class ActorAnimationSampler {
  private readonly root = new THREE.Group();
  private readonly joints = new Map<ActorJointName, THREE.Object3D>();
  private readonly mixer = new THREE.AnimationMixer(this.root);
  private readonly actions: { clip: ActorClip; action: THREE.AnimationAction; duration: number }[];
  private readonly fallback = new Map<ActorActionName, THREE.AnimationAction>();
  private readonly custom: THREE.AnimationAction | null;

  constructor(readonly animation?: ActorAnimation) {
    for (const name of actorJointNames) {
      const node = new THREE.Object3D();
      node.name = name;
      if (name === 'hips') node.position.y = 0.91;
      this.root.add(node);
      this.joints.set(name, node);
    }
    const makeAction = (clip: THREE.AnimationClip) => {
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      action.enabled = false;
      return action;
    };
    this.actions = (animation?.clips ?? []).map((clip) => {
      const source = createActorActionClip(clip.action, clip.mirror);
      return { clip, action: makeAction(source), duration: source.duration };
    });
    for (const name of ['idle', 'walk', 'sit', 'gesture'] as const)
      this.fallback.set(name, makeAction(createActorActionClip(name)));
    const custom = jointKeysClip(animation?.jointKeys ?? []);
    this.custom = custom ? makeAction(custom) : null;
  }

  sample(at: number, fallback: ActorAnimationFallback = {}): ActorAnimationSample {
    const activeClips: ActorAnimationSample['activeClips'] = [];
    let total = 0;
    for (const entry of this.actions) {
      const weight = actorIntervalWeight(entry.clip, at);
      const source = entry.clip.sourceOffset + (at - entry.clip.start) * entry.clip.speed;
      const time = entry.clip.loop
        ? THREE.MathUtils.euclideanModulo(source, entry.duration)
        : THREE.MathUtils.clamp(source, 0, entry.duration);
      this.setAction(entry.action, time, weight);
      if (weight > 0) activeClips.push({ id: entry.clip.id, time, weight });
      total += weight;
    }
    const name = fallback.action === 'talk' ? 'gesture' : (fallback.action ?? 'idle');
    for (const [kind, action] of this.fallback) {
      const phase =
        kind === 'walk'
          ? (fallback.distance ?? at * (fallback.speed ?? 1)) / 1.22
          : at * (fallback.speed ?? 1);
      const time =
        kind === 'sit'
          ? action.getClip().duration
          : THREE.MathUtils.euclideanModulo(phase, action.getClip().duration);
      this.setAction(action, time, kind === name ? Math.max(0, 1 - total) : 0);
    }
    if (this.custom)
      this.setAction(this.custom, THREE.MathUtils.clamp(at, 0, this.custom.getClip().duration), 1);
    // Explicit action time and zero delta make seeks independent of playback order and frame rate.
    this.mixer.update(0);
    const rotations = {} as ActorAnimationSample['rotations'];
    for (const joint of actorJointNames) rotations[joint] = this.joints.get(joint)!.quaternion.toArray();
    if (fallback.pose) {
      const pose = fallback.pose;
      const legacy: Rotations = {
        head: [pose.headPitch, pose.headYaw, 0],
        leftArm: [pose.leftArm, 0, 0],
        rightArm: [pose.rightArm, 0, 0],
        leftLeg: [pose.leftLeg, 0, 0],
        rightLeg: [pose.rightLeg, 0, 0],
      };
      for (const [joint, degrees] of Object.entries(legacy))
        rotations[joint as ActorJointName] = new THREE.Quaternion(...rotations[joint as ActorJointName])
          .multiply(quaternion(degrees))
          .toArray();
    }
    const hips = this.joints.get('hips')!.position;
    return { rotations, hipsOffset: [hips.x, hips.y - 0.91, hips.z], activeClips };
  }

  private setAction(action: THREE.AnimationAction, time: number, weight: number) {
    action.reset();
    action.paused = true;
    action.enabled = weight > 0;
    action.time = time;
    action.setEffectiveWeight(weight);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}

export function sampleActorAnimation(
  animation: ActorAnimation | undefined,
  at: number,
  fallback: ActorAnimationFallback = {},
): ActorAnimationSample {
  const sampler = new ActorAnimationSampler(animation);
  try {
    return sampler.sample(at, fallback);
  } finally {
    sampler.dispose();
  }
}
