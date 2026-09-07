import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { IcosahedronGeometry, Quaternion, Vector3 } from 'three';
import { ProductionMcp, camera } from './production-mcp';
import { compilePath, motionPathSchema, quaternionFor, rotationFor } from '../../shared/motion';
import { geometryToMesh } from '../../shared/modeling-geometry';
import { sampleObject } from '../../shared/timeline';
import type { Command, Project, SequenceClip, Vec3 } from '../../shared/types';

const film = new ProductionMcp('space');
const duration = 120;
const flight: Vec3[] = [
  [0, 100, 0],
  [0, 110, 120],
  [30, 120, 260],
  [70, 170, 340],
  [100, 225, 380],
  [130, 170, 420],
  [150, 110, 380],
  [170, 165, 340],
  [190, 225, 390],
  [230, 160, 490],
  [180, 130, 650],
  [80, 150, 820],
  [0, 170, 1020],
  [-50, 190, 1240],
];
const arrivals = [0, 12, 24, 32, 38, 43, 48, 54, 60, 68, 80, 92, 106, 120];
const roll = [0, 0, -8, 0, 35, 120, 250, 360, 360, 375, 365, 360, 360, 360];
const shipIds = ['flight-lead', 'flight-left', 'flight-right', 'hostile-one', 'hostile-two'];
const create = (payload: Record<string, unknown>): Command => ({ type: 'object.create', payload });
const pointAt = (id: string, time: number) =>
  sampleObject(
    film.project.objects.find((object) => object.id === id)!,
    time,
    { render: true },
  );

try {
  await film.connect();
  if (process.argv.includes('--resume')) {
    const id = (await readFile(resolve(film.directory, 'project-id.txt'), 'utf8')).trim();
    film.project = await film.call<Project>('project_open', { id });
  } else await film.create('白模太空战 / 碎星突围');
  await film.edit([
    { type: 'project.update', payload: { sceneName: '碎星航道 · 太空外景' } },
    {
      type: 'project.settings',
      payload: {
        fps: 24,
        aspect: '16:9',
        resolution: 720,
        lighting: { intensity: 2.1, ambient: 0.65, azimuth: 130, elevation: 35 },
        environment: { ground: false, background: '#b7c2c7', groundTone: '#a8b4b7' },
      },
    },
  ]);
  for (const [index, id] of shipIds.entries()) {
    if (film.project.objects.some((object) => object.id === id)) continue;
    const points = flight.map(([x, y, z], i) => {
      const fraction = i / (flight.length - 1);
      const offsets: Vec3[] = [
        [0, 0, 0],
        [-22, 10, -16],
        [24, -10, -30],
        [16 + Math.sin(fraction * Math.PI * 2) * 8, 22, -48 + fraction * 92],
        [-30, -24, -65 + fraction * 118],
      ];
      const offset = offsets[index]!;
      return {
        position: [x + offset[0], y + offset[1], z + offset[2]] as Vec3,
        roll: roll[i]! + (index === 0 ? 0 : Math.sin(fraction * Math.PI * 4) * 12),
      };
    });
    const path = motionPathSchema.parse({
      points,
      speed: [{ duration, fromSpeed: 10, toSpeed: 10, easing: 'constant' }],
      lookAhead: 1,
      bankStrength: 0.12,
    });
    const compiled = compilePath(path);
    path.speed = arrivals.slice(1).map((arrival, i) => {
      const from = i / (points.length - 1);
      const to = (i + 1) / (points.length - 1);
      let distance = 0;
      let previous = compiled.curve.getPoint(from);
      for (let step = 1; step <= 100; step++) {
        const next = compiled.curve.getPoint(from + ((to - from) * step) / 100);
        distance += previous.distanceTo(next);
        previous = next;
      }
      const seconds = arrival - arrivals[i]!;
      return {
        duration: seconds,
        fromSpeed: distance / seconds,
        toSpeed: distance / seconds,
        easing: 'constant',
      };
    });
    await film.edit([
      {
        type: 'vehicle.create',
        payload: {
          id,
          name: ['领航机 / 白翼', '左翼护航机', '右翼护航机', '敌方截击一号', '敌方截击二号'][index],
          kind: 'spacecraft',
          dimensions: index < 3 ? [8, 2.8, 12] : [11, 2.1, 10],
          position: points[0]!.position,
        },
      },
      {
        type: 'object.update',
        payload: { id, patch: { tone: ['#edf0ed', '#d7dfdc', '#d0d8d9', '#879a9f', '#96a6ac'][index] } },
      },
      { type: 'motion.path.set', payload: { id, path } },
      { type: 'motion.path.fit', payload: { id, duration } },
      { type: 'motion.path.bake', payload: { id, fps: 24 } },
    ]);
  }
  const scenery: Command[] = [
    create({
      id: 'planet',
      name: '远方行星',
      type: 'sphere',
      dimensions: [400, 400, 400],
      position: [-500, -270, 1180],
      tone: '#d5dcda',
    }),
    create({
      id: 'moon',
      name: '卫星',
      type: 'sphere',
      dimensions: [65, 65, 65],
      position: [280, 420, 550],
      tone: '#d8dddb',
    }),
  ];
  const asteroids: { id: string; position: Vec3; radius: number }[] = [];
  for (let index = 0; index < 30; index++) {
    const ship = pointAt('flight-lead', 63 + (index % 10) * 3);
    const layer = Math.floor(index / 10);
    const angle = ((index * 137.5 + layer * 29) * Math.PI) / 180;
    const radius = 5 + (index % 5) * 1.4;
    let distance = 75 + layer * 25;
    let position: Vec3 = [0, 0, 0];
    for (let attempt = 0; attempt < 12; attempt++) {
      position = [
        ship.position[0] + Math.cos(angle) * distance,
        ship.position[1] + Math.sin(angle) * distance,
        ship.position[2] + (layer - 1) * 25,
      ];
      const safe = shipIds.every((id) =>
        Array.from({ length: 241 }, (_, i) => pointAt(id, i * 0.5)).every(
          (sample) => new Vector3(...sample.position).distanceTo(new Vector3(...position)) > radius + 14,
        ),
      );
      if (safe) break;
      distance += 18;
    }
    const geometry = new IcosahedronGeometry(radius, 1);
    const mesh = geometryToMesh(geometry);
    geometry.dispose();
    mesh.vertices = mesh.vertices.map(([x, y, z]) => {
      const distortion = 1 + Math.sin(x * 1.3 + y * 2.1 + z * 0.8 + index) * 0.14;
      return [x * distortion, y * distortion * 0.8, z * distortion * 1.13];
    });
    const id = `asteroid-${index + 1}`;
    scenery.push(
      create({
        id,
        name: `碎星 ${index + 1}`,
        type: 'box',
        position,
        rotation: [index * 17, index * 31, index * 7],
        modeling: mesh,
        tone: index % 3 === 0 ? '#bdc8c9' : '#d5dcda',
      }),
    );
    asteroids.push({ id, position, radius: radius * 1.3 });
  }
  await film.edit(
    scenery.filter((command) => !film.project.objects.some((object) => object.id === command.payload.id)),
  );

  const fire = async (
    id: string,
    attacker: string,
    target: string,
    start: number,
    flightTime: number,
    miss: Vec3 = [0, 0, 0],
  ) => {
    if (film.project.objects.some((object) => object.id === id)) return;
    const originShip = pointAt(attacker, start);
    const targetShip = pointAt(target, start + flightTime);
    const destination = new Vector3(...targetShip.position).add(new Vector3(...miss));
    const origin = new Vector3(...originShip.position).add(
      new Vector3(0, 0, 6).applyQuaternion(quaternionFor(originShip.rotation)),
    );
    const orientation = rotationFor(
      new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), destination.clone().sub(origin).normalize()),
    );
    await film.edit([
      {
        type: 'effect.create',
        payload: {
          id,
          name: `弹道 / ${attacker} > ${target}`,
          position: origin.toArray(),
          rotation: orientation,
          effect: { kind: 'projectile', start, duration: flightTime, radius: 7 },
        },
      },
      {
        type: 'object.update',
        payload: {
          id,
          patch: {
            tone: attacker.startsWith('hostile') ? '#647e88' : '#edf2ee',
            keyframes: [
              {
                id: `${id}-start`,
                time: start,
                position: origin.toArray(),
                rotation: orientation,
                easing: 'linear',
              },
              {
                id: `${id}-end`,
                time: start + flightTime,
                position: destination.toArray(),
                rotation: orientation,
                easing: 'linear',
              },
            ],
          },
        },
      },
    ]);
  };
  for (const [index, start] of [25, 28, 31, 35, 38, 41].entries())
    await fire(`enemy-shot-${index}`, index % 2 ? 'hostile-two' : 'hostile-one', 'flight-lead', start, 1.5, [
      index % 2 ? 11 : -11,
      6,
      0,
    ]);
  for (const [index, start] of [49, 52, 55, 60.5].entries())
    await fire(
      `friendly-shot-${index}`,
      index % 2 ? 'flight-left' : 'flight-lead',
      'hostile-one',
      start,
      1.5,
      index === 3 ? [0, 0, 0] : [6, 3, 0],
    );
  await fire('wing-hit-shot', 'hostile-two', 'flight-right', 56.5, 1.5);
  for (const [index, start] of [86, 89, 92, 95, 98, 101.5].entries())
    await fire(
      `final-shot-${index}`,
      index % 2 ? 'flight-lead' : 'flight-left',
      'hostile-two',
      start,
      1.5,
      index === 5 ? [0, 0, 0] : [-6, 4, 0],
    );

  const impactPosition = pointAt('flight-right', 58).position;
  if (!film.project.objects.some((object) => object.id === 'wing-impact'))
    await film.edit([
      {
        type: 'effect.create',
        payload: {
          id: 'wing-impact',
          name: '右翼受击闪点',
          position: impactPosition,
          effect: { kind: 'impact', start: 58, duration: 2, radius: 6 },
        },
      },
    ]);
  const debrisIds: string[] = [];
  for (const [index, [id, time]] of [
    ['hostile-one', 62],
    ['hostile-two', 103],
  ].entries()) {
    const targetId = id as string;
    const hitTime = time as number;
    const ship = pointAt(targetId, hitTime);
    const original = film.project.objects.find((object) => object.id === targetId)!;
    if (!film.project.objects.some((object) => object.id === `explosion-${index}`))
      await film.edit([
        {
          type: 'object.update',
          payload: {
            id: targetId,
            patch: {
              keyframes: original.keyframes.map((frame) => {
                if (Math.abs(frame.time - (hitTime - 1 / 24)) < 1e-7)
                  return { ...frame, scale: [1, 1, 1], easing: 'step' };
                if (Math.abs(frame.time - hitTime) < 1e-7)
                  return { ...frame, scale: [0.0001, 0.0001, 0.0001], easing: 'step' };
                return frame;
              }),
            },
          },
        },
        {
          type: 'effect.create',
          payload: {
            id: `explosion-${index}`,
            name: `截击机命中爆炸 ${index + 1}`,
            position: ship.position,
            effect: { kind: 'explosion', start: hitTime, duration: 6, radius: 18 },
          },
        },
        {
          type: 'beat.create',
          payload: {
            id: `space-hit-${index}`,
            label: '命中确认',
            time: hitTime,
            endTime: hitTime + 2,
            kind: 'action',
            text: '',
            notes: `${targetId} 被击中，碎片按零重力运动。`,
          },
        },
      ]);
    const ids: string[] = [];
    for (let shard = 0; shard < 4; shard++) {
      const debrisId = `debris-${index}-${shard}`;
      ids.push(debrisId);
      debrisIds.push(debrisId);
      if (film.project.objects.some((object) => object.id === debrisId)) continue;
      const direction = new Vector3((shard % 2 ? 1 : -1) * 3, (shard < 2 ? 1 : -1) * 3, 0);
      const position = new Vector3(...ship.position).add(direction).toArray() as Vec3;
      await film.edit([
        create({
          id: debrisId,
          name: `零重力碎片 ${index + 1}.${shard + 1}`,
          type: 'box',
          position,
          dimensions: [1.6, 0.7, 2.5],
          tone: '#9aacb0',
        }),
        {
          type: 'object.update',
          payload: {
            id: debrisId,
            patch: {
              keyframes: [
                { id: `${debrisId}-hidden`, time: 0, scale: [0.0001, 0.0001, 0.0001], easing: 'step' },
                { id: `${debrisId}-revealed`, time: hitTime, scale: [1, 1, 1], easing: 'step' },
              ],
            },
          },
        },
        {
          type: 'physics.body.set',
          payload: {
            id: debrisId,
            body: {
              mode: 'dynamic',
              shape: 'box',
              mass: 4,
              linearVelocity: [direction.x * 1.7, direction.y * 1.7, 8 + shard],
              angularVelocity: [0.7 + shard * 0.2, 0.4, -0.5],
              linearDamping: 0,
              angularDamping: 0,
              gravityScale: 0,
            },
          },
        },
      ]);
    }
    if (film.project.objects.find((object) => object.id === ids[0])!.keyframes.length < 10)
      await film.command('simulation_bake', {
        options: {
          ids,
          start: hitTime,
          duration: duration - hitTime,
          fps: 24,
          stepRate: 120,
          gravity: [0, 0, 0],
        },
      });
  }

  const specs = [
    {
      name: '01 / 编队进入碎星带',
      subject: 'flight-lead',
      offset: [48, 34, -78],
      aim: [0, 2, -16],
      fov: 50,
      rotate: false,
      intent: '建立三机编队与后方两架截击机的总体空间。',
    },
    {
      name: '02 / 追兵压近',
      subject: 'hostile-one',
      offset: [22, 8, -34],
      aim: [-8, -6, 32],
      fov: 53,
      rotate: false,
      intent: '敌机近景切入，前景敌机与远处护航编队同框。',
    },
    {
      name: '03 / 火线追逐',
      subject: 'flight-lead',
      offset: [-42, 20, -38],
      aim: [0, 8, -20],
      fov: 55,
      rotate: false,
      intent: '敌方弹道横穿编队周围，明确追击方向与攻击目标。',
    },
    {
      name: '04 / 垂直翻滚规避',
      subject: 'flight-lead',
      offset: [17, 7, -28],
      aim: [0, 0, 5],
      fov: 54,
      rotate: true,
      intent: '持续三维回转并完成滚转，摄影机跟随朝向但路径可单独编辑。',
    },
    {
      name: '05 / 护航反击',
      subject: 'flight-left',
      offset: [-24, 14, -28],
      aim: [20, 7, 12],
      fov: 55,
      rotate: false,
      intent: '左翼掩护主机回转，反击弹道指向截击一号。',
    },
    {
      name: '06 / 命中与碎片',
      subject: 'flight-lead',
      offset: [42, 28, -55],
      aim: [8, 10, 10],
      fov: 52,
      rotate: false,
      intent: '全局视角确认截击机命中、爆炸与零重力碎片扩散。',
    },
    {
      name: '07 / 穿越碎星廊道',
      subject: 'flight-lead',
      offset: [8, 7, -26],
      aim: [0, 0, 13],
      fov: 58,
      rotate: true,
      intent: '近距离追踪护航机穿越具有纵深和视差的碎星带。',
    },
    {
      name: '08 / 最后追兵',
      subject: 'hostile-two',
      offset: [-34, 13, -30],
      aim: [14, 12, 6],
      fov: 55,
      rotate: false,
      intent: '敌方二号与护航机共享画面，明确最后一轮追逐。',
    },
    {
      name: '09 / 决定性齐射',
      subject: 'flight-lead',
      offset: [30, 24, -44],
      aim: [-15, -10, 22],
      fov: 51,
      rotate: false,
      intent: '展示连续齐射，弹道抵达后出现命中反馈与碎片。',
    },
    {
      name: '10 / 重整编队驶向行星',
      subject: 'flight-lead',
      offset: [64, 38, -70],
      aim: [-10, 0, 16],
      fov: 52,
      rotate: false,
      intent: '三架护航机继续位移并重新组成三角队形，以行星作为目的地收束。',
    },
  ];
  const clips: SequenceClip[] = [];
  for (const [index, spec] of specs.entries()) {
    const from = index * 12;
    const to = from + 12;
    const ship = pointAt(spec.subject, from);
    const orient = quaternionFor(ship.rotation);
    const world = (offset: number[]) =>
      new Vector3(...(offset as Vec3))
        .applyQuaternion(orient)
        .add(new Vector3(...ship.position))
        .toArray() as Vec3;
    const cameraId = `space-camera-${index + 1}`;
    const shotId = `space-shot-${index + 1}`;
    if (!film.project.cameras.some((item) => item.id === cameraId))
      await film.edit([
        {
          type: 'camera.create',
          payload: { ...camera(cameraId, spec.name, world(spec.offset), world(spec.aim), spec.fov) },
        },
        {
          type: 'shot.create',
          payload: {
            id: shotId,
            name: spec.name,
            cameraId,
            sourceIn: from,
            sourceOut: to,
            subjectIds: shipIds,
            intent: spec.intent,
          },
        },
        {
          type: 'beat.create',
          payload: {
            id: `space-beat-${index + 1}`,
            label: spec.name,
            time: from,
            endTime: to,
            kind: 'action',
            text: '',
            notes: spec.intent,
          },
        },
      ]);
    await film.command('camera_motion', {
      id: cameraId,
      motion: 'follow',
      start: from,
      end: to,
      subjectId: spec.subject,
      rotateWithSubject: spec.rotate,
    });
    clips.push({ id: `space-clip-${index + 1}`, shotId, sourceIn: from, sourceOut: to });
  }
  await film.edit([
    {
      type: 'sequence.update',
      payload: { id: film.project.activeSequenceId, patch: { name: '碎星突围 / 导演剪辑', clips } },
    },
  ]);
  const audioFile = resolve(film.directory, 'space-reference.m4a');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=0.055*sin(2*PI*48*t)+0.025*sin(2*PI*(96*t+2*sin(t/9)))+0.16*sin(2*PI*62*t)*exp(-(t-62)*(t-62)*12)+0.18*sin(2*PI*52*t)*exp(-(t-103)*(t-103)*12):s=24000:d=${duration}`,
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-y',
    audioFile,
  ]);
  const asset = await film.call<{ url: string }>('asset_import', {
    name: 'space-reference.m4a',
    dataBase64: (await readFile(audioFile)).toString('base64'),
  });
  await film.edit([
    {
      type: 'audio.create',
      payload: {
        id: 'space-reference',
        name: '推进器与命中节奏参考',
        url: asset.url,
        start: 0,
        sourceIn: 0,
        duration,
        volume: 0.7,
        sync: 'source',
      },
    },
    { type: 'production.initialize', payload: {} },
  ]);
  const state = film.project.production!;
  await film.edit([
    {
      type: 'storyScene.create',
      payload: {
        id: 'space-story',
        name: '碎星突围',
        sceneId: state.activeSceneId,
        performanceId: state.activePerformanceId,
        location: '行星外侧碎星航道',
        timeOfDay: '太空外景',
        description: '三架护航机遭遇两架截击机，经翻滚规避与护航反击穿越碎星带，消灭追兵后重整编队。',
      },
    },
  ]);
  const clearances = asteroids.map((asteroid) => ({
    id: asteroid.id,
    minimumSurfaceClearance: Math.min(
      ...shipIds.flatMap((id) =>
        Array.from(
          { length: 241 },
          (_, i) =>
            new Vector3(...pointAt(id, i * 0.5).position).distanceTo(new Vector3(...asteroid.position)) -
            asteroid.radius -
            8,
        ),
      ),
    ),
  }));
  await film.save({
    sourceDuration: duration,
    narrative: specs,
    asteroidClearances: clearances,
    debrisIds,
    physics: 'Rapier fixed 120 Hz steps, zero gravity; editable 24 fps baked tracks.',
    review: 'Actual PNG review pending. Long video export pending.',
  });
  for (const [name, time] of [
    ['shot-01', 6],
    ['shot-03', 28.7],
    ['shot-04', 42],
    ['shot-05', 54],
    ['shot-06', 63.5],
    ['shot-07', 78],
    ['shot-09', 104.5],
    ['shot-10', 114],
  ] as const)
    await film.preview(time, name);
} finally {
  await film.close();
}
