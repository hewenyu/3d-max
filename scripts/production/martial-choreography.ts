import {
  actorActionCatalog,
  actorAnimationSchema,
  type ActorActionName,
  type ActorClip,
  type ActorConstraint,
} from '../../shared/actor-animation';
import type { ObjectKeyframe, Vec3 } from '../../shared/types';

export const martialDuration = 128;
type Fighter = 'qing' | 'lan';
interface Exchange {
  time: number;
  attacker: Fighter;
  action: ActorActionName;
  response: ActorActionName;
  duration: number;
  contact: boolean;
}
export const exchanges: Exchange[] = [
  { time: 13, attacker: 'qing', action: 'punch', response: 'block', duration: 1.1, contact: false },
  { time: 16.5, attacker: 'lan', action: 'punch', response: 'dodge', duration: 1.2, contact: false },
  { time: 20, attacker: 'qing', action: 'punch', response: 'hit', duration: 1.1, contact: true },
  { time: 24, attacker: 'lan', action: 'kick', response: 'block', duration: 1.4, contact: false },
  { time: 28, attacker: 'qing', action: 'punch', response: 'dodge', duration: 1.2, contact: false },
  { time: 31.5, attacker: 'lan', action: 'punch', response: 'block', duration: 1.1, contact: false },
  { time: 35, attacker: 'qing', action: 'kick', response: 'dodge', duration: 1.5, contact: false },
  { time: 39, attacker: 'lan', action: 'punch', response: 'hit', duration: 1.3, contact: true },
  { time: 43.5, attacker: 'qing', action: 'punch', response: 'hit', duration: 1.2, contact: true },
  { time: 46, attacker: 'qing', action: 'kick', response: 'fall', duration: 1.4, contact: false },
  { time: 63, attacker: 'qing', action: 'weapon', response: 'block', duration: 1.6, contact: false },
  { time: 67, attacker: 'lan', action: 'weapon', response: 'dodge', duration: 1.5, contact: false },
  { time: 71, attacker: 'qing', action: 'weapon', response: 'block', duration: 1.4, contact: false },
  { time: 75, attacker: 'lan', action: 'weapon', response: 'hit', duration: 1.5, contact: false },
  { time: 79, attacker: 'qing', action: 'weapon', response: 'dodge', duration: 1.5, contact: false },
  { time: 83, attacker: 'lan', action: 'weapon', response: 'block', duration: 1.6, contact: false },
  { time: 86.5, attacker: 'qing', action: 'punch', response: 'dodge', duration: 1.2, contact: false },
  { time: 90, attacker: 'lan', action: 'weapon', response: 'block', duration: 2.1, contact: false },
  { time: 94, attacker: 'qing', action: 'weapon', response: 'dodge', duration: 1.5, contact: false },
  { time: 98, attacker: 'lan', action: 'punch', response: 'block', duration: 1.1, contact: false },
  { time: 101.5, attacker: 'qing', action: 'weapon', response: 'hit', duration: 1.6, contact: false },
  { time: 106, attacker: 'lan', action: 'weapon', response: 'dodge', duration: 1.5, contact: false },
  { time: 110, attacker: 'qing', action: 'punch', response: 'fall', duration: 1.3, contact: false },
];
const centers: { time: number; x: number; z: number; angle: number }[] = [
  { time: 0, x: 0, z: 1.4, angle: 0 },
  { time: 12, x: 0, z: 0.8, angle: 0 },
  { time: 24, x: 0.8, z: 0.2, angle: 12 },
  { time: 36, x: 1.4, z: -0.3, angle: -12 },
  { time: 46, x: 1.1, z: -0.7, angle: 0 },
  { time: 52, x: 0, z: -2.6, angle: 0 },
  { time: 59, x: 0, z: -2.6, angle: 0 },
  { time: 64, x: 0, z: -0.5, angle: 0 },
  { time: 78, x: -1.1, z: 0.5, angle: 15 },
  { time: 87, x: 0, z: 0, angle: 0 },
  { time: 97, x: 0, z: 0, angle: 0 },
  { time: 110, x: 1, z: 1.1, angle: 0 },
  { time: 119, x: 1, z: 1.1, angle: 0 },
  { time: 128, x: 0, z: 1.4, angle: 0 },
];
export function arenaCenter(time: number) {
  const rightIndex = centers.findIndex((value) => value.time >= time);
  const right = centers[rightIndex < 0 ? centers.length - 1 : rightIndex]!;
  const left = centers[Math.max(0, rightIndex - 1)]!;
  const fraction =
    right.time === left.time ? 0 : Math.max(0, Math.min(1, (time - left.time) / (right.time - left.time)));
  return {
    x: left.x + (right.x - left.x) * fraction,
    z: left.z + (right.z - left.z) * fraction,
    angle: left.angle + (right.angle - left.angle) * fraction,
  };
}
function stance(time: number, fighter: Fighter, separation: number): ObjectKeyframe {
  const center = arenaCenter(time);
  const sign = fighter === 'qing' ? -1 : 1;
  const angle = (center.angle * Math.PI) / 180;
  return {
    id: `${fighter}-root-${time.toFixed(3)}`,
    time,
    position: [
      center.x + (sign * Math.cos(angle) * separation) / 2,
      0,
      center.z + (sign * Math.sin(angle) * separation) / 2,
    ],
    rotation: [0, 90 - center.angle + (fighter === 'lan' ? 180 : 0), 0],
    easing: 'smooth',
  };
}
function action(fighter: Fighter, name: ActorActionName, start: number, end: number, id: string): ActorClip {
  const definition = actorActionCatalog.find((item) => item.action === name)!;
  const loop = ['walk', 'run', 'gesture'].includes(name);
  return {
    id: `${fighter}-${id}`,
    action: name,
    start,
    end,
    weight: 1,
    fadeIn: 0.08,
    fadeOut: 0.08,
    sourceOffset: 0,
    speed: loop ? 1 : definition.duration / (end - start),
    loop,
    mirror: false,
  };
}

export function choreography(fighter: Fighter) {
  const roots = new Map<number, ObjectKeyframe>();
  const put = (time: number, separation: number) => {
    const at = Number(time.toFixed(3));
    roots.set(at, stance(at, fighter, separation));
  };
  const clips: ActorClip[] = [
    action(fighter, 'walk', 0, 7.8, 'approach'),
    action(fighter, 'gesture', fighter === 'qing' ? 8 : 9, fighter === 'qing' ? 10 : 11, 'salute'),
    action(fighter, 'walk', fighter === 'lan' ? 52 : 50, 54.8, 'rack-approach'),
    action(fighter, 'gesture', 55, 57.8, 'grip-staff'),
    action(fighter, 'walk', 58, 62, 'return-with-staff'),
    action(fighter, 'gesture', 121, 124, 'closing-salute'),
    action(fighter, 'walk', 124.2, 128, 'leave-court'),
  ];
  if (fighter === 'lan') clips.push(action(fighter, 'getup', 49.4, 51.8, 'first-recovery'));
  const constraints: ActorConstraint[] = [];
  for (const [time, separation] of [
    [0, 7],
    [4, 4],
    [8, 2.2],
    [12, 1.7],
    [49, 2.4],
    [52, 4],
    [55, 5.3],
    [58, 5.3],
    [62, 2],
    [114, 2.4],
    [119, 2.4],
    [123, 2.8],
    [128, 6],
  ] as const)
    put(time, separation);
  for (const [index, exchange] of exchanges.entries()) {
    const attacking = exchange.attacker === fighter;
    const peak = exchange.time + exchange.duration * 0.47;
    const gap =
      exchange.action === 'weapon' ? 1.7 : exchange.action === 'kick' ? 1.1 : exchange.contact ? 0.58 : 1.1;
    put(exchange.time - 0.6, exchange.action === 'weapon' ? 2.2 : 1.65);
    put(peak, gap);
    put(exchange.time + exchange.duration + 0.7, exchange.response === 'fall' ? 2.3 : 1.75);
    const start = attacking
      ? exchange.time
      : exchange.time +
        (exchange.response === 'block' || exchange.response === 'dodge' ? 0.08 : exchange.duration * 0.4);
    const length = !attacking && exchange.response === 'fall' ? 1.8 : exchange.duration;
    const clip = action(
      fighter,
      attacking ? exchange.action : exchange.response,
      start,
      start + length,
      `exchange-${index}`,
    );
    if (index % 3 === 1 && exchange.action !== 'weapon') clip.mirror = true;
    clips.push(clip);
    if (attacking && exchange.contact) {
      constraints.push({
        id: `${fighter}-hit-contact-${index}`,
        effector: clip.mirror ? 'leftHand' : 'rightHand',
        start: peak - 0.05,
        end: peak + 0.11,
        weight: 1,
        fadeIn: 0.025,
        fadeOut: 0.025,
        target: {
          kind: 'object',
          objectId: fighter === 'qing' ? 'lan' : 'qing',
          bone: 'chest',
          offset: [0, -0.02, 0.16],
        },
        iterations: 80,
        tolerance: 0.02,
      });
    }
  }
  if (fighter === 'lan') clips.push(action(fighter, 'getup', 116, 118.8, 'final-recovery'));
  clips.sort((left, right) => left.start - right.start);
  const filled: ActorClip[] = [];
  let previousEnd = 0;
  let previousAction: ActorActionName = 'block';
  for (const clip of clips) {
    if (clip.start > previousEnd + 0.001) {
      const hold = action(
        fighter,
        previousAction === 'fall' ? 'fall' : 'block',
        previousEnd,
        clip.start,
        `hold-${filled.length}`,
      );
      hold.sourceOffset = previousAction === 'fall' ? 1.6 : 0.9;
      hold.speed = 1;
      hold.fadeIn = 0;
      hold.fadeOut = 0;
      filled.push(hold);
    }
    filled.push(clip);
    previousEnd = Math.max(previousEnd, clip.end);
    previousAction = clip.action;
  }
  const gripTime = fighter === 'qing' ? 56 : 57;
  constraints.push({
    id: `${fighter}-grasp`,
    effector: 'rightHand',
    start: gripTime - 0.8,
    end: gripTime + 0.35,
    weight: 1,
    fadeIn: 0.2,
    fadeOut: 0.3,
    target: {
      kind: 'world',
      position: [fighter === 'qing' ? -2.3 : 2.3, 1.12, fighter === 'qing' ? -2.32 : -2.88],
    },
    iterations: 80,
    tolerance: 0.025,
  });
  const sortedRoots = [...roots.values()].sort((left, right) => left.time - right.time);
  return {
    keyframes: sortedRoots,
    animation: actorAnimationSchema.parse({ clips: filled, constraints, jointKeys: [] }),
  };
}

export function pointAt(fighter: Fighter, time: number): Vec3 {
  const values = choreography(fighter).keyframes;
  const next = values.findIndex((frame) => frame.time >= time);
  const right = values[next < 0 ? values.length - 1 : next]!;
  const left = values[Math.max(0, next - 1)]!;
  let f = right.time === left.time ? 0 : (time - left.time) / (right.time - left.time);
  f = Math.max(0, Math.min(1, f));
  f = f * f * (3 - 2 * f);
  return left.position!.map((value, axis) => value + (right.position![axis]! - value) * f) as Vec3;
}
