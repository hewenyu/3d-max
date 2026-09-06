import type { ObjectType, Project, SceneObject, ShotCamera, Vec3 } from './types';

export function id(prefix = 'id'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const dimensions: Record<ObjectType, Vec3> = {
  box: [1, 1, 1],
  sphere: [1, 1, 1],
  cylinder: [0.6, 1, 0.6],
  plane: [8, 0.05, 7],
  wall: [8, 3, 0.15],
  door: [1, 2.2, 0.12],
  window: [1.5, 1.2, 0.12],
  sofa: [2.6, 0.9, 0.95],
  table: [1.4, 0.5, 0.7],
  chair: [0.5, 0.9, 0.5],
  actor: [0.5, 1.78, 0.35],
  phone: [0.075, 0.15, 0.012],
  group: [1, 1, 1],
  model: [1, 1, 1],
};
const names: Record<ObjectType, string> = {
  box: '方块',
  sphere: '球体',
  cylinder: '圆柱',
  plane: '地面',
  wall: '墙体',
  door: '门',
  window: '窗',
  sofa: '沙发',
  table: '桌子',
  chair: '椅子',
  actor: '角色',
  phone: '手机',
  group: '组合',
  model: '导入模型',
};

export function createObject(type: ObjectType, name = names[type]): SceneObject {
  return {
    id: id(type),
    name,
    type,
    parentId: null,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    dimensions: [...dimensions[type]],
    visible: true,
    locked: false,
    tone: type === 'actor' ? '#dededb' : '#e8e8e3',
    keyframes: [],
    ...(type === 'actor'
      ? {
          actor: {
            action: 'idle' as const,
            speed: 1,
            pose: { headPitch: 0, headYaw: 0, leftArm: 0, rightArm: 0, leftLeg: 0, rightLeg: 0 },
            lookAtId: null,
          },
        }
      : {}),
  };
}

export function createEmptyProject(name = '未命名项目'): Project {
  const sequenceId = id('sequence');
  return {
    schemaVersion: 1,
    id: id('project'),
    name,
    sceneName: '场景 01',
    revision: 0,
    objects: [],
    cameras: [],
    shots: [],
    sequences: [{ id: sequenceId, name: '主剪辑', clips: [], locked: false }],
    activeSequenceId: sequenceId,
    beats: [],
    audio: [],
    notes: [],
    settings: {
      fps: 24,
      aspect: '9:16',
      resolution: 720,
      lighting: { intensity: 2.5, ambient: 0.8, azimuth: 35, elevation: 45 },
      axisActorIds: [],
    },
    updatedAt: new Date().toISOString(),
  };
}

export function createDemoProject(): Project {
  const p = createEmptyProject('未接来电');
  p.sceneName = '01 / 客厅 · 日内';
  const object = (
    type: ObjectType,
    objectId: string,
    name: string,
    position: Vec3,
    overrides: Partial<SceneObject> = {},
  ) => {
    const value = { ...createObject(type, name), id: objectId, position, ...overrides };
    p.objects.push(value);
    return value;
  };
  object('plane', 'floor', '客厅地面', [0, -0.05, 0], {
    dimensions: [8, 0.05, 7],
    tone: '#c5c7c4',
    locked: true,
  });
  object('wall', 'back-wall', '后墙', [0, 0, -3], {
    dimensions: [8, 3, 0.15],
    tone: '#dadcd8',
    locked: true,
  });
  object('wall', 'left-wall', '左侧墙', [-4, 0, 0], {
    dimensions: [0.15, 3, 6],
    tone: '#dadcd8',
    locked: true,
  });
  object('door', 'entry-door', '入口', [-3, 0, -2.9], { tone: '#a9adaa' });
  object('window', 'window', '客厅窗', [1.4, 1.1, -2.89], { dimensions: [2, 1.35, 0.08] });
  object('sofa', 'sofa', '沙发', [0.2, 0, -2], { tone: '#d0d2cf' });
  object('table', 'coffee-table', '茶几', [0.2, 0, -0.95], { dimensions: [1.4, 0.45, 0.65] });
  const a = object('actor', 'actor-a', 'A / 林舟', [-2.4, 0, 0.8], {
    rotation: [0, 100, 0],
    tone: '#ecece8',
  });
  a.actor!.lookAtId = 'actor-b';
  a.keyframes = [
    { id: 'a-start', time: 0, position: [-2.4, 0, 0.8], action: 'walk' },
    { id: 'a-arrive', time: 2.2, position: [-0.7, 0, 0.2], action: 'idle', easing: 'smooth' },
    { id: 'a-question', time: 2.4, action: 'talk', pose: { rightArm: -25 } },
    { id: 'a-question-end', time: 4.5, action: 'idle', pose: { rightArm: 0 } },
  ];
  const b = object('actor', 'actor-b', 'B / 陈默', [0.8, 0, 0], { rotation: [0, -80, 0], tone: '#adb4b4' });
  b.actor!.pose.headPitch = 20;
  b.actor!.pose.rightArm = -25;
  b.keyframes = [
    { id: 'b-down', time: 0, pose: { headPitch: 20 }, lookAtId: null },
    { id: 'b-hold', time: 5, pose: { headPitch: 20 }, lookAtId: null },
    { id: 'b-look', time: 5.6, pose: { headPitch: 0 }, lookAtId: 'actor-a', easing: 'smooth' },
    { id: 'b-phone-hold', time: 7, pose: { rightArm: -25 } },
    { id: 'b-reveal', time: 8.2, pose: { rightArm: -65 }, easing: 'smooth' },
  ];
  object('phone', 'phone', '手机 / 关键道具', [0, 0, 0], {
    tone: '#565d60',
    rotation: [65, 0, 0],
    attachment: { objectId: 'actor-b', bone: 'rightHand', offset: [0, -0.015, 0.045] },
  });
  const camera = (cameraId: string, name: string, position: Vec3, target: Vec3, fov: number): ShotCamera => {
    const value: ShotCamera = { id: cameraId, name, position, target, fov, locked: false, keyframes: [] };
    p.cameras.push(value);
    return value;
  };
  camera('camera-wide', '01 / 双人全景', [-4.6, 3, 6.8], [-1, 1, 0.15], 46);
  const reaction = camera('camera-reaction', '02 / B 的反应', [-1.7, 1.62, 0.95], [0.8, 1.22, 0], 32);
  reaction.keyframes = [
    {
      id: 'reaction-start',
      time: 3.5,
      position: [-1.7, 1.62, 0.95],
      target: [0.8, 1.22, 0],
      fov: 32,
      easing: 'linear',
    },
    {
      id: 'reaction-end',
      time: 7,
      position: [-1.55, 1.6, 0.9],
      target: [0.8, 1.22, 0],
      fov: 32,
      easing: 'smooth',
    },
  ];
  const reveal = camera('camera-reveal', '03 / 手机揭示', [-0.9, 1.25, 1.9], [0.45, 1.05, -0.15], 36);
  reveal.keyframes = [
    {
      id: 'reveal-start',
      time: 7,
      position: [-0.9, 1.25, 1.9],
      target: [0.45, 1.05, -0.15],
      fov: 36,
      easing: 'linear',
    },
    {
      id: 'reveal-end',
      time: 10,
      position: [-0.65, 1.25, 1.4],
      target: [0.35, 1.2, -0.15],
      fov: 32,
      easing: 'smooth',
    },
  ];
  p.beats = [
    {
      id: 'beat-enter',
      label: '走近',
      time: 0,
      endTime: 2.2,
      kind: 'action',
      actorId: 'actor-a',
      text: '',
      notes: 'A 从入口走向 B，先建立空间关系。',
      locked: false,
    },
    {
      id: 'beat-question',
      label: '质问',
      time: 2.4,
      endTime: 4.5,
      kind: 'dialogue',
      actorId: 'actor-a',
      text: '昨晚，为什么不接我的电话？',
      notes: '跨切点保持对白连续。',
      locked: false,
    },
    {
      id: 'beat-pause',
      label: '停顿 0.5 秒',
      time: 4.5,
      endTime: 5,
      kind: 'pause',
      actorId: 'actor-b',
      text: '',
      notes: '听完以后保持低头，留出反应的时间。',
      locked: false,
    },
    {
      id: 'beat-reaction',
      label: '抬头',
      time: 5,
      endTime: 5.6,
      kind: 'reaction',
      actorId: 'actor-b',
      text: '',
      notes: '从回避到目光接触。',
      locked: false,
    },
    {
      id: 'beat-reveal',
      label: '手机揭示',
      time: 7,
      endTime: 8.2,
      kind: 'reveal',
      actorId: 'actor-b',
      text: '',
      notes: 'B 抬起手机，让观众第一次看清道具。',
      locked: false,
    },
  ];
  p.shots = [
    {
      id: 'shot-wide',
      name: '01 双人全景',
      cameraId: 'camera-wide',
      sourceIn: 0,
      sourceOut: 3.5,
      intent: '交代人物距离与走位，A 占据主动。',
      subjectIds: ['actor-a', 'actor-b'],
      hiddenIds: ['phone'],
      beatId: 'beat-enter',
      locked: false,
    },
    {
      id: 'shot-reaction',
      name: '02 过肩 · 反应',
      cameraId: 'camera-reaction',
      sourceIn: 3.5,
      sourceOut: 7,
      intent: '听者的沉默比对白更重要；停顿后抬头。',
      subjectIds: ['actor-b'],
      hiddenIds: ['phone'],
      beatId: 'beat-reaction',
      locked: false,
    },
    {
      id: 'shot-reveal',
      name: '03 道具揭示',
      cameraId: 'camera-reveal',
      sourceIn: 7,
      sourceOut: 10,
      intent: '推进手机，揭示未接来电背后的线索。',
      subjectIds: ['actor-b', 'phone'],
      hiddenIds: [],
      beatId: 'beat-reveal',
      locked: false,
    },
  ];
  p.sequences = [
    {
      id: 'sequence-main',
      name: '方案 A / 主剪辑',
      locked: false,
      clips: p.shots.map((shot, i) => ({
        id: `clip-${i + 1}`,
        shotId: shot.id,
        sourceIn: shot.sourceIn,
        sourceOut: shot.sourceOut,
      })),
    },
  ];
  p.activeSequenceId = 'sequence-main';
  p.settings.axisActorIds = ['actor-a', 'actor-b'];
  return p;
}
