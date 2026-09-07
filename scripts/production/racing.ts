import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Vector3 } from 'three';
import { ProductionMcp, camera } from './production-mcp';
import { motionPathSchema, quaternionFor } from '../../shared/motion';
import { sampleObject } from '../../shared/timeline';
import { clipDuration, sampleClipTime } from '../../shared/time-map';
import type { Command, SequenceClip, Vec3 } from '../../shared/types';

const film = new ProductionMcp('racing');
const road: Vec3[] = [
  [0, 0, 0],
  [0, 0, 160],
  [60, 0, 340],
  [140, 0, 500],
  [20, 0, 670],
  [-140, 0, 780],
  [-200, 0, 960],
  [-100, 0, 1140],
  [80, 0, 1300],
  [180, 0, 1480],
  [80, 0, 1670],
  [-20, 0, 1840],
  [0, 0, 2020],
  [0, 0, 2230],
];
const duration = 112;
const roadSide = (index: number, distance: number, height = 0): Vec3 => {
  const previous = new Vector3(...road[Math.max(0, index - 1)]!);
  const next = new Vector3(...road[Math.min(road.length - 1, index + 1)]!);
  const right = new Vector3().crossVectors(new Vector3(0, 1, 0), next.sub(previous).normalize());
  return new Vector3(...road[index]!)
    .addScaledVector(right, distance)
    .add(new Vector3(0, height, 0))
    .toArray() as Vec3;
};
const create = (payload: Record<string, unknown>): Command => ({ type: 'object.create', payload });

try {
  await film.connect();
  await film.create('白模竞速 / 山口超越');
  await film.edit([
    { type: 'project.update', payload: { sceneName: '山口封闭赛道 · 日外' } },
    {
      type: 'project.settings',
      payload: {
        fps: 24,
        aspect: '16:9',
        resolution: 720,
        lighting: { intensity: 2.2, ambient: 0.65, azimuth: 125, elevation: 42 },
        environment: { ground: true, background: '#cdd5d2', groundTone: '#b5bdb7' },
      },
    },
  ]);
  const set: Command[] = [
    create({
      id: 'road-surface',
      name: '山口主赛道',
      type: 'box',
      tone: '#afb7b3',
      modeling: {
        kind: 'curve',
        profile: 'road',
        points: road,
        segments: 1400,
        width: 20,
        thickness: 0.25,
        bank: 0,
      },
    }),
    create({
      id: 'road-edge-left',
      name: '左侧护栏',
      type: 'box',
      tone: '#e4e7e2',
      modeling: {
        kind: 'curve',
        profile: 'tube',
        points: road.map((_point, index) => roadSide(index, -10.1, 0.7)),
        segments: 1000,
        radius: 0.15,
        radialSegments: 6,
      },
    }),
    create({
      id: 'road-edge-right',
      name: '右侧护栏',
      type: 'box',
      tone: '#e4e7e2',
      modeling: {
        kind: 'curve',
        profile: 'tube',
        points: road.map((_point, index) => roadSide(index, 10.1, 0.7)),
        segments: 1000,
        radius: 0.15,
        radialSegments: 6,
      },
    }),
    create({
      id: 'road-center-mark',
      name: '中线',
      type: 'box',
      tone: '#ebede8',
      modeling: {
        kind: 'curve',
        profile: 'road',
        points: road.map(([x, y, z]) => [x, y + 0.012, z]),
        segments: 900,
        width: 0.16,
        thickness: 0.012,
      },
    }),
    create({
      id: 'terrain-base',
      name: '山谷基底',
      type: 'plane',
      position: [0, -1.3, 1100],
      dimensions: [1000, 1, 2700],
      tone: '#c9cfca',
    }),
  ];
  for (let index = 1; index < road.length - 1; index++) {
    for (const side of [-1, 1]) {
      const center = roadSide(index, side * (140 + (index % 3) * 30), -0.8);
      const segments = 16;
      const heights = Array.from({ length: (segments + 1) ** 2 }, (_, vertex) => {
        const x = ((vertex % (segments + 1)) / segments - 0.5) * 2;
        const z = (Math.floor(vertex / (segments + 1)) / segments - 0.5) * 2;
        return (
          (45 + (index % 4) * 18) * Math.max(0, 1 - x * x - z * z) ** 1.6 +
          3 * Math.sin(x * 4 + index) * Math.cos(z * 5)
        );
      });
      set.push(
        create({
          id: `ridge-${index}-${side}`,
          name: `山脊 ${index} / ${side < 0 ? '左' : '右'}`,
          type: 'box',
          position: center,
          tone: index % 2 ? '#c0c8c1' : '#d1d7cf',
          modeling: {
            kind: 'terrain',
            sizeX: 220,
            sizeZ: 250,
            segmentsX: segments,
            segmentsZ: segments,
            heights,
            thickness: 2,
          },
        }),
      );
    }
  }
  for (const [index, z] of [60, 2060].entries()) {
    set.push(
      create({
        id: `gantry-left-${index}`,
        name: index ? '终点左柱' : '起点左柱',
        type: 'box',
        position: [-10, 0, z],
        dimensions: [1.2, 8, 1.2],
        tone: '#dbe0db',
      }),
      create({
        id: `gantry-right-${index}`,
        name: index ? '终点右柱' : '起点右柱',
        type: 'box',
        position: [10, 0, z],
        dimensions: [1.2, 8, 1.2],
        tone: '#dbe0db',
      }),
      create({
        id: `gantry-top-${index}`,
        name: index ? '终点横梁' : '起点横梁',
        type: 'box',
        position: [0, 7, z],
        dimensions: [21, 1, 1.2],
        tone: '#858f88',
      }),
    );
    for (const side of [-1, 1])
      set.push(
        create({
          id: `stands-${index}-${side}`,
          name: '观赛台',
          type: 'box',
          position: [side * 26, 0, z + 10],
          dimensions: [12, 3 + index * 2, 48],
          tone: '#d3d8d1',
        }),
      );
  }
  for (let index = 0; index < 12; index++) {
    const z = 1890 + index * 10;
    set.push(
      create({
        id: `gallery-left-${index}`,
        name: `廊架左 ${index + 1}`,
        type: 'box',
        position: [-10.5, 0, z],
        dimensions: [0.65, 7, 0.65],
      }),
      create({
        id: `gallery-right-${index}`,
        name: `廊架右 ${index + 1}`,
        type: 'box',
        position: [10.5, 0, z],
        dimensions: [0.65, 7, 0.65],
      }),
      create({
        id: `gallery-roof-${index}`,
        name: `廊架顶 ${index + 1}`,
        type: 'box',
        position: [0, 6.8, z],
        dimensions: [21.6, 0.5, 0.65],
      }),
    );
  }
  await film.edit(set);
  const schedules = [
    [
      [12, 9, 18],
      [16, 18, 19],
      [20, 19, 27],
      [14, 27, 19],
      [16, 19, 27],
      [20, 27, 28],
      [14, 28, 10],
    ],
    [
      [12, 13, 21],
      [16, 21, 25],
      [20, 25, 22],
      [14, 22, 17],
      [16, 17, 23],
      [20, 23, 25],
      [14, 25, 9],
    ],
    [
      [12, 11, 20],
      [16, 20, 22],
      [20, 22, 20],
      [14, 20, 18],
      [16, 18, 21],
      [20, 21, 22],
      [14, 22, 8],
    ],
  ];
  for (const [index, id] of ['racer-a', 'racer-b', 'racer-c'].entries()) {
    const lane = [-5, 0, 5][index]!;
    const points = road.map((_point, pointIndex) => ({
      position: roadSide(pointIndex, lane, 0.02),
      roll: 0,
    }));
    points[0]!.position[2] += [0, 10, 20][index]!;
    const path = motionPathSchema.parse({
      points,
      speed: schedules[index]!.map(([seconds, fromSpeed, toSpeed]) => ({
        duration: seconds,
        fromSpeed,
        toSpeed,
        easing: fromSpeed === toSpeed ? 'constant' : 'smooth',
      })),
      lookAhead: 1.5,
      bankStrength: 0,
    });
    await film.edit([
      {
        type: 'vehicle.create',
        payload: {
          id,
          name: ['01 / 追击车', '02 / 领跑车', '03 / 侧翼车'][index],
          kind: 'car',
          position: points[0]!.position,
        },
      },
      { type: 'object.update', payload: { id, patch: { tone: ['#eff1ec', '#bbc5bf', '#8e9c94'][index] } } },
      { type: 'motion.path.set', payload: { id, path } },
      { type: 'motion.path.fit', payload: { id, duration } },
      { type: 'motion.path.bake', payload: { id, fps: 24 } },
    ]);
  }
  const primary = film.project.objects.find((object) => object.id === 'racer-a')!;
  const driftKeys = primary.keyframes.map((frame) => {
    const drift = Math.max(0, Math.min(1, (frame.time - 54) / 8));
    const yaw = frame.time >= 54 && frame.time <= 62 ? Math.sin(drift * Math.PI) * 24 : 0;
    return frame.rotation
      ? {
          ...frame,
          rotation: [frame.rotation[0], frame.rotation[1] + yaw, frame.rotation[2] - yaw * 0.04] as Vec3,
        }
      : frame;
  });
  await film.edit([{ type: 'object.update', payload: { id: primary.id, patch: { keyframes: driftKeys } } }]);
  const specs = [
    {
      name: '01 / 山口发车',
      from: 0,
      to: 10,
      offset: [28, 18, -30],
      aim: [0, 0.8, 7],
      fov: 45,
      subject: 'racer-a',
      intent: '交代三车关系与连续赛道，追击车由队尾发动攻势。',
    },
    {
      name: '02 / 低机位加速',
      from: 10,
      to: 20,
      offset: [3.8, 0.65, 5.8],
      aim: [0, 0.6, 0],
      fov: 52,
      subject: 'racer-a',
      intent: '前轮和路面近景，车轮随真实位移滚动，背景掠过形成速度感。',
    },
    {
      name: '03 / 车内视线',
      from: 20,
      to: 30,
      offset: [-0.38, 1.08, -0.02],
      aim: [-0.38, 1.08, 18],
      fov: 64,
      subject: 'racer-a',
      intent: '随车辆转向的驾驶位，保留方向盘与风挡框，观察前车走线。',
    },
    {
      name: '04 / 并行攻防',
      from: 30,
      to: 42,
      offset: [-14, 2.3, 1],
      aim: [3, 0.8, 0],
      fov: 47,
      subject: 'racer-a',
      intent: '侧向追拍，两车在画面中交换先后位置。',
    },
    {
      name: '05 / 超越窗口',
      from: 42,
      to: 54,
      offset: [9, 7, -18],
      aim: [0, 0.8, 8],
      fov: 50,
      subject: 'racer-a',
      intent: '高位跟车，明确内外线与超车空间，保持行驶方向连续。',
    },
    {
      name: '06 / 漂移慢动作',
      from: 54,
      to: 62,
      offset: [10, 3, 8],
      aim: [0, 0.75, 0],
      fov: 48,
      subject: 'racer-a',
      intent: '同一连续漂移动作从正常速度渐慢、保持四分之一速度，再恢复正常；摄影机以独立时钟继续环绕。',
    },
    {
      name: '07 / 弯心反应',
      from: 62,
      to: 72,
      offset: [-3.6, 1.0, 6.2],
      aim: [0, 0.85, 0],
      fov: 44,
      subject: 'racer-b',
      intent: '领跑车前部近景，路面和追击车出现在同一空间关系中。',
    },
    {
      name: '08 / 廊架追逐',
      from: 72,
      to: 82,
      offset: [1.5, 2.2, -9],
      aim: [0, 0.8, 8],
      fov: 53,
      subject: 'racer-a',
      intent: '廊架的连续遮挡强化高速运动，摄影机沿车身后方追逐。',
    },
    {
      name: '09 / 终段反超',
      from: 82,
      to: 96,
      offset: [22, 11, 5],
      aim: [0, 0.75, 4],
      fov: 48,
      subject: 'racer-a',
      intent: '外侧远景记录追击车最终反超，三车仍沿独立可编辑轨迹行驶。',
    },
    {
      name: '10 / 越线收束',
      from: 96,
      to: 112,
      offset: [8, 5, 16],
      aim: [0, 0.75, 0],
      fov: 45,
      subject: 'racer-a',
      intent: '终点门架与渐缓车流完成比赛叙事，尾段保持实际位移。',
    },
  ];
  const clips: SequenceClip[] = [];
  for (const [index, spec] of specs.entries()) {
    const subject = film.project.objects.find((object) => object.id === spec.subject)!;
    const sampled = sampleObject(subject, spec.from, { render: true });
    const orient = quaternionFor(sampled.rotation);
    const world = (offset: number[]) =>
      new Vector3(...(offset as Vec3))
        .applyQuaternion(orient)
        .add(new Vector3(...sampled.position))
        .toArray() as Vec3;
    const cameraId = `race-camera-${index + 1}`;
    const shotId = `race-shot-${index + 1}`;
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
          sourceIn: spec.from,
          sourceOut: spec.to,
          subjectIds: ['racer-a', 'racer-b', 'racer-c'],
          intent: spec.intent,
        },
      },
      {
        type: 'beat.create',
        payload: {
          id: `race-beat-${index + 1}`,
          label: spec.name,
          time: spec.from,
          endTime: spec.to,
          kind: 'action',
          text: '',
          notes: spec.intent,
        },
      },
    ]);
    const clip: SequenceClip = {
      id: `race-clip-${index + 1}`,
      shotId,
      sourceIn: spec.from,
      sourceOut: spec.to,
    };
    if (index === 5) {
      clip.retiming = {
        audio: 'warp',
        segments: [
          { duration: 1, fromSpeed: 1, toSpeed: 1, easing: 'constant' },
          { duration: 2, fromSpeed: 1, toSpeed: 0.25, easing: 'smooth' },
          { duration: 12, fromSpeed: 0.25, toSpeed: 0.25, easing: 'constant' },
          { duration: 2, fromSpeed: 0.25, toSpeed: 1, easing: 'smooth' },
          { duration: 1.5, fromSpeed: 1, toSpeed: 1, easing: 'constant' },
        ],
      };
      clip.cameraTiming = { mode: 'independent', sourceIn: spec.from, rate: 1 };
      const frames = Array.from({ length: Math.ceil(clipDuration(clip) * 24) + 1 }, (_, frame) => {
        const editTime = Math.min(clipDuration(clip), frame / 24);
        const time = sampleClipTime(clip, editTime).sourceTime;
        const car = sampleObject(subject, time, { render: true });
        const angle = ((-35 + (editTime / clipDuration(clip)) * 100) * Math.PI) / 180;
        const offset = new Vector3(Math.cos(angle) * 11, 3.8, Math.sin(angle) * 11).applyQuaternion(
          quaternionFor(car.rotation),
        );
        return {
          id: `race-slow-camera-${frame}`,
          time: spec.from + editTime,
          position: offset.add(new Vector3(...car.position)).toArray() as Vec3,
          target: [car.position[0], car.position[1] + 0.75, car.position[2]] as Vec3,
          fov: spec.fov,
          easing: 'linear',
        };
      });
      await film.edit([{ type: 'camera.update', payload: { id: cameraId, patch: { keyframes: frames } } }]);
    } else
      await film.command('camera_motion', {
        id: cameraId,
        motion: 'follow',
        start: spec.from,
        end: spec.to,
        subjectId: spec.subject,
        rotateWithSubject: true,
      });
    clips.push(clip);
  }
  await film.edit([
    {
      type: 'sequence.update',
      payload: { id: film.project.activeSequenceId, patch: { name: '山口超越 / 导演剪辑', clips } },
    },
  ]);
  const audioFile = resolve(film.directory, 'racing-engine.m4a');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=0.15*sin(2*PI*(62*t+6*sin(t/7)))+0.07*sin(2*PI*(124*t+9*sin(t/9))):s=24000:d=${duration}`,
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-y',
    audioFile,
  ]);
  const asset = await film.call<{ url: string }>('asset_import', {
    name: 'racing-engine.m4a',
    dataBase64: (await readFile(audioFile)).toString('base64'),
  });
  await film.edit([
    {
      type: 'audio.create',
      payload: {
        id: 'race-engine-audio',
        name: '发动机参考音',
        url: asset.url,
        start: 0,
        sourceIn: 0,
        duration,
        volume: 0.6,
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
        id: 'race-story',
        name: '山口超越',
        sceneId: state.activeSceneId,
        performanceId: state.activePerformanceId,
        location: '封闭山口赛道',
        timeOfDay: '日外',
        description: '三车竞速：追击、并行、超越、漂移与终段冲刺。道路和三台车辆均可独立编辑。',
      },
    },
  ]);
  await film.save({
    narrative: specs,
    retimedClip: 'race-clip-6',
    sourceDuration: duration,
    review: 'Shot previews pending visual review; long video export pending.',
  });
  for (const index of [0, 2, 4, 5, 7, 9]) {
    const start = clips.slice(0, index).reduce((sum, clip) => sum + clipDuration(clip), 0);
    await film.preview(
      start + clipDuration(clips[index]!) * 0.5,
      `shot-${String(index + 1).padStart(2, '0')}`,
    );
  }
} finally {
  await film.close();
}
