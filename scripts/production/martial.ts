import { ProductionMcp, camera } from './production-mcp';
import { arenaCenter, choreography, exchanges, martialDuration, pointAt } from './martial-choreography';
import { refineMartial } from './martial-refine';
import type { Command, SequenceClip, Vec3 } from '../../shared/types';

const film = new ProductionMcp('martial', process.env.WHITEFRAME_PRODUCTION_API ?? 'http://127.0.0.1:4201');
const create = (payload: Record<string, unknown>): Command => ({ type: 'object.create', payload });
const shotNames = [
  '入场 · 庭院全景',
  '试探 · 双人中景',
  '反击 · 过肩格挡',
  '下盘 · 低机位踢击',
  '闪身 · 动作侧跟',
  '压迫 · 受击与倒地',
  '重整 · 起身和取械',
  '取势 · 握柄与转身',
  '第一合 · 持械攻防',
  '追击 · 横移跟拍',
  '换位 · 高位调度',
  '交锋 · 正常到慢动作',
  '贴身 · 武器与手部',
  '决胜 · 反应与倒地',
  '留手 · 起身恢复',
  '收势 · 回到庭院',
];

function waveform(duration: number, kind: 'ambience' | 'hit' | 'staff') {
  const rate = 8000;
  const frames = Math.ceil(duration * rate);
  const data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(frames * 2, 40);
  let seed = 73417;
  let filtered = 0;
  for (let frame = 0; frame < frames; frame++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 4294967296) * 2 - 1;
    const time = frame / rate;
    filtered = filtered * 0.97 + noise * 0.03;
    const envelope =
      kind === 'ambience'
        ? 0.025 * (0.7 + 0.3 * Math.sin(time * 0.19))
        : Math.exp(-time * (kind === 'hit' ? 18 : 30));
    const sample =
      kind === 'ambience'
        ? filtered
        : Math.sin(time * Math.PI * 2 * (kind === 'hit' ? 92 : 620)) * 0.55 + noise * 0.25;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample * envelope)) * 26000), 44 + frame * 2);
  }
  return data;
}

try {
  await film.connect();
  await film.create('白模武打 / 庭院试锋');
  await film.edit([
    { type: 'project.update', payload: { sceneName: '练武庭院 · 日外' } },
    {
      type: 'project.settings',
      payload: {
        fps: 24,
        aspect: '16:9',
        resolution: 720,
        lighting: { intensity: 2.1, ambient: 0.7, azimuth: 120, elevation: 48 },
        environment: { ground: true, background: '#ced6d3', groundTone: '#b7beba' },
      },
    },
  ]);
  const set: Command[] = [
    create({
      id: 'court',
      type: 'box',
      name: '练武石台',
      position: [0, -0.32, 0],
      dimensions: [15, 0.32, 12],
      tone: '#d6dbd6',
    }),
    create({
      id: 'north-wall',
      type: 'wall',
      name: '庭院北墙',
      position: [0, 0, -5.7],
      dimensions: [15, 3.3, 0.35],
      tone: '#c5cdc6',
    }),
    create({
      id: 'east-wall',
      type: 'wall',
      name: '庭院东墙',
      position: [7.2, 0, 0],
      dimensions: [0.35, 2.5, 11.8],
      tone: '#c5cdc6',
    }),
    create({
      id: 'west-wall',
      type: 'wall',
      name: '庭院西墙',
      position: [-7.2, 0, 0],
      dimensions: [0.35, 2.5, 11.8],
      tone: '#c5cdc6',
    }),
    create({
      id: 'gate-lintel',
      type: 'box',
      name: '正门横梁',
      position: [0, 3.05, -4.95],
      dimensions: [5.5, 0.4, 1],
      tone: '#b3bdb6',
    }),
    create({
      id: 'gate-opening',
      type: 'box',
      name: '门内阴影',
      position: [0, 0, -5.49],
      dimensions: [3, 2.5, 0.035],
      tone: '#596763',
    }),
  ];
  for (const x of [-2.35, 2.35])
    set.push(
      create({
        id: `gate-pillar-${x}`,
        type: 'cylinder',
        name: '门廊立柱',
        position: [x, 0, -4.95],
        dimensions: [0.42, 3, 0.42],
        tone: '#b7c0b8',
      }),
    );
  for (let index = -3; index <= 3; index++) {
    set.push(
      create({
        id: `paving-x-${index}`,
        type: 'box',
        name: '石台横向分缝',
        position: [0, 0.005, index * 1.65],
        dimensions: [14.7, 0.006, 0.016],
        tone: '#b8c2b9',
      }),
    );
    set.push(
      create({
        id: `paving-z-${index}`,
        type: 'box',
        name: '石台纵向分缝',
        position: [index * 2, 0.005, 0],
        dimensions: [0.016, 0.006, 11.7],
        tone: '#b8c2b9',
      }),
    );
  }
  for (const side of [-1, 1]) {
    set.push(
      create({
        id: `rack-${side}`,
        type: 'box',
        name: '兵器架底座',
        position: [side * 2.3, 0, -2.6],
        dimensions: [0.42, 1.12, 0.85],
        tone: '#8f9c94',
      }),
    );
    set.push(
      create({
        id: `bench-${side}`,
        type: 'box',
        name: '庭院长凳',
        position: [side * 5.6, 0, -2.4],
        dimensions: [0.65, 0.68, 2.3],
        tone: '#a9b5ac',
      }),
    );
  }
  for (const fighter of ['qing', 'lan'] as const) {
    const tracks = choreography(fighter);
    set.push(
      create({
        id: fighter,
        type: 'actor',
        name: fighter === 'qing' ? '青 · 进攻方' : '岚 · 应对方',
        position: tracks.keyframes[0]!.position,
        rotation: tracks.keyframes[0]!.rotation,
        dimensions: [0.5, 1.78, 0.35],
        tone: fighter === 'qing' ? '#edf0e9' : '#aebbb4',
        keyframes: tracks.keyframes,
        rotationInterpolation: 'quaternion',
      }),
    );
  }
  await film.edit(set);
  for (const fighter of ['qing', 'lan'] as const) {
    const tracks = choreography(fighter);
    await film.command('actor_animation_set', { id: fighter, animation: tracks.animation });
  }
  await film.edit(
    ['qing', 'lan'].map((fighter) =>
      create({
        id: `${fighter}-staff`,
        type: 'cylinder',
        name: fighter === 'qing' ? '青的短棍' : '岚的短棍',
        position: [fighter === 'qing' ? -2.3 : 2.3, 1.12, fighter === 'qing' ? -2.32 : -2.88],
        dimensions: [0.055, 1.12, 0.055],
        tone: '#77877d',
        keyframes: [
          {
            id: `${fighter}-staff-pickup`,
            time: fighter === 'qing' ? 56 : 57,
            position: [0, 0, 0],
            rotation: [180, 0, 0],
            attachment: { objectId: fighter, bone: 'rightHand', offset: [0, 0.08, 0] },
            easing: 'step',
          },
        ],
      }),
    ),
  );
  const ambience = await film.call<{ url: string }>('asset_import', {
    name: 'courtyard-air.wav',
    dataBase64: waveform(martialDuration, 'ambience').toString('base64'),
  });
  const hit = await film.call<{ url: string }>('asset_import', {
    name: 'contact.wav',
    dataBase64: waveform(0.5, 'hit').toString('base64'),
  });
  const staff = await film.call<{ url: string }>('asset_import', {
    name: 'staff-contact.wav',
    dataBase64: waveform(0.5, 'staff').toString('base64'),
  });
  const cues: Command[] = [
    {
      type: 'audio.create',
      payload: {
        id: 'courtyard-air',
        name: '庭院环境声',
        url: ambience.url,
        start: 0,
        duration: martialDuration,
        sync: 'source',
        volume: 0.8,
      },
    },
  ];
  for (const [index, exchange] of exchanges.entries()) {
    const at = exchange.time + exchange.duration * 0.47;
    const defender = exchange.attacker === 'qing' ? 'lan' : 'qing';
    cues.push({
      type: 'beat.create',
      payload: {
        id: `beat-${index}`,
        label: `${index + 1}. ${exchange.action === 'weapon' ? '兵器交锋' : exchange.action === 'kick' ? '下盘转换' : '拳路试探'}`,
        time: exchange.time,
        endTime: exchange.time + exchange.duration,
        kind: 'action',
        actorId: exchange.attacker,
        text: `${exchange.attacker === 'qing' ? '青' : '岚'}进攻，${defender === 'qing' ? '青' : '岚'}${exchange.response === 'block' ? '格挡' : exchange.response === 'dodge' ? '闪避' : exchange.response === 'fall' ? '倒地' : '受击'}`,
        notes: '双方站位与动作接触遵守当前庭院轴线。',
      },
    });
    if (exchange.response !== 'dodge') {
      cues.push({
        type: 'audio.create',
        payload: {
          id: `cue-${index}`,
          name: `接触声 ${index + 1}`,
          url: exchange.action === 'weapon' ? staff.url : hit.url,
          start: at,
          duration: 0.5,
          sync: 'source',
          volume: exchange.action === 'weapon' ? 0.55 : 0.38,
        },
      });
      cues.push({
        type: 'sync.group.set',
        payload: {
          group: {
            id: `exchange-sync-${index}`,
            name: `第 ${index + 1} 合节拍`,
            members: [
              { kind: 'beat', id: `beat-${index}`, anchor: 'start' },
              {
                kind: 'actor-clip',
                objectId: exchange.attacker,
                id: `${exchange.attacker}-exchange-${index}`,
                anchor: 'start',
              },
              {
                kind: 'actor-clip',
                objectId: defender,
                id: `${defender}-exchange-${index}`,
                anchor: 'start',
              },
              { kind: 'audio', id: `cue-${index}`, anchor: 'start' },
            ],
          },
        },
      });
    }
  }
  await film.edit(cues);
  const edits: SequenceClip[] = [];
  for (let index = 0; index < 16; index++) {
    const start = index * 8;
    const end = start + 8;
    const id = `martial-camera-${index}`;
    const shotId = `martial-shot-${index}`;
    const center = arenaCenter(start + 4);
    const type =
      index === 0 || index === 15
        ? 'wide'
        : index === 10
          ? 'overhead'
          : index === 2 || index === 4 || index === 6 || index === 7 || index === 12
            ? 'close'
            : index === 3 || index === 11
              ? 'low'
              : 'pair';
    const subject = index === 2 || index === 6 ? 'lan' : 'qing';
    const target = type === 'close' ? pointAt(subject, start + 4) : ([center.x, 0, center.z] as Vec3);
    const offset: Vec3 =
      type === 'wide'
        ? [4.8, 4.2, 8.8]
        : type === 'overhead'
          ? [0.6, 8, 2.8]
          : type === 'close'
            ? [subject === 'qing' ? 1.8 : -1.8, 1.65, 3.4]
            : type === 'low'
              ? index === 11
                ? [1.7, 0.85, 5.6]
                : [1.7, 0.65, 4.5]
              : [2.7, 2, 5.6];
    const focalHeight =
      index === 11
        ? 1.25
        : type === 'overhead'
          ? 0
          : type === 'close'
            ? index === 7 || index === 12
              ? 1.1
              : 1.25
            : 0.9;
    const position = target.map((value, axis) => value + offset[axis]!) as Vec3;
    const aim: Vec3 = [target[0], focalHeight, target[2]];
    const definition = camera(
      id,
      shotNames[index]!,
      position,
      aim,
      type === 'wide' || index === 11 ? 44 : type === 'close' ? 30 : 38,
    );
    const cameraEnd = index === 11 ? end + 6 : end;
    definition.keyframes = Array.from({ length: 33 }, (_, frame) => {
      const fraction = frame / 32;
      const source = start + fraction * 8;
      const midpoint = arenaCenter(source);
      const focus =
        index === 11
          ? ([0, 0, 0] as Vec3)
          : type === 'close'
            ? pointAt(subject, source)
            : ([midpoint.x, 0, midpoint.z] as Vec3);
      const pan =
        type === 'wide' ? -fraction * 1.5 : type === 'overhead' ? fraction * 1.2 : fraction * 0.7 - 0.35;
      return {
        id: `${id}-${frame}`,
        time: start + (cameraEnd - start) * fraction,
        position: [
          focus[0] + offset[0] + pan,
          offset[1] - (type === 'wide' ? fraction * 0.6 : 0),
          focus[2] + offset[2] - fraction * 0.35,
        ],
        target: [focus[0], focalHeight, focus[2]],
        fov: definition.fov,
        easing: 'smooth',
      };
    });
    await film.edit([
      { type: 'camera.create', payload: { ...definition } },
      {
        type: 'shot.create',
        payload: {
          id: shotId,
          cameraId: id,
          name: shotNames[index],
          sourceIn: start,
          sourceOut: end,
          subjectIds: ['qing', 'lan'],
          intent: shotNames[index],
        },
      },
    ]);
    const clip: SequenceClip = { id: `martial-edit-${index}`, shotId, sourceIn: start, sourceOut: end };
    if (index === 11) {
      clip.retiming = {
        audio: 'warp',
        segments: [
          { duration: 1, fromSpeed: 1, toSpeed: 1, easing: 'constant' },
          { duration: 2, fromSpeed: 1, toSpeed: 0.25, easing: 'smooth' },
          { duration: 6, fromSpeed: 0.25, toSpeed: 0.25, easing: 'constant' },
          { duration: 2, fromSpeed: 0.25, toSpeed: 1, easing: 'smooth' },
          { duration: 3, fromSpeed: 1, toSpeed: 1, easing: 'constant' },
        ],
      };
      clip.cameraTiming = { mode: 'independent', sourceIn: start, rate: 1 };
    }
    edits.push(clip);
  }
  await film.edit([
    {
      type: 'sequence.update',
      payload: { id: film.project.activeSequenceId, patch: { name: '庭院试锋 · 导演剪辑', clips: edits } },
    },
    { type: 'project.settings', payload: { axisActorIds: ['qing', 'lan'] } },
  ]);
  await refineMartial(film);
  for (const [time, shot] of [
    [4, 0],
    [20.5, 2],
    [40, 4],
    [47.4, 5],
    [56, 7],
    [68, 8],
    [90.9, 11],
    [112.5, 14],
    [125, 15],
  ] as const)
    await film.preview(time - shot * 8, `preview-${time}`, `martial-shot-${shot}`);
  await film.save({
    storyboard: shotNames,
    contactConstraints: 5,
    exchanges: exchanges.length,
    audioTracks: film.project.audio.length,
    requiredBeats: [
      '双人攻防',
      '闪避',
      '格挡',
      '受击',
      '倒地起身',
      '持械',
      '空间交代',
      '局部特写',
      '反应镜头',
      '连续变速及独立摄影机时间',
    ],
  });
} finally {
  await film.close();
}
