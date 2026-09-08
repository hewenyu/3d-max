import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import type { Command, Vec3 } from '../../shared/types';
import { ModelingAssetClient } from './client';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4220' },
    project: { type: 'string' },
    from: { type: 'string', default: 'hall' },
    'skip-export': { type: 'boolean', default: false },
  },
});
const author = new ModelingAssetClient('architecture', values.api);
const create = (payload: Record<string, unknown>): Command => ({ type: 'object.create', payload });
const modifier = (id: string, value: Record<string, unknown>): Command => ({
  type: 'modifier.add',
  payload: { id, modifier: value },
});
const surface = (id: string, value: Record<string, unknown>): Command => ({
  type: 'surface.set',
  payload: { id, surface: { kind: 'surface', smooth: false, ...value } },
});
const profile = (points: number[][]) => ({
  outer: { closed: true, points: points.map((position) => ({ position })) },
  holes: [],
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function archProfile() {
  return profile([
    [-1.04, -0.08],
    [1.04, -0.08],
    [1.04, 2.0],
    ...Array.from({ length: 24 }, (_, index) => {
      const angle = ((index + 1) * Math.PI) / 24;
      return [1.04 * Math.cos(angle), 2 + 1.04 * Math.sin(angle)];
    }),
  ]);
}

async function hall() {
  await author.commands(
    [
      {
        type: 'project.settings',
        payload: {
          fps: 24,
          aspect: '16:9',
          resolution: 720,
          lighting: { intensity: 2.2, ambient: 0.8, azimuth: 120, elevation: 38 },
          environment: { ground: true, background: '#d7dedb', groundTone: '#b5c3bd' },
        },
      },
      { type: 'project.update', payload: { sceneName: '三拱观测馆 / 建筑白模' } },
      create({
        id: 'platform',
        name: '1.28m 架高平台',
        type: 'box',
        dimensions: [14, 0.48, 8],
        position: [0, 0.8, 0],
        tone: '#ced7d1',
      }),
      modifier('platform', { id: 'platform-edge', type: 'bevel', width: 0.04, segments: 3 }),
      create({
        id: 'foundation',
        name: '平台基座',
        type: 'box',
        dimensions: [13.5, 0.8, 7.5],
        position: [0, 0, 0],
        tone: '#b4c1b9',
      }),
      create({
        id: 'front-wall',
        name: '三拱前墙 / 360mm 厚',
        type: 'box',
        dimensions: [12, 4.4, 0.36],
        position: [0, 1.28, 2.7],
        tone: '#e9ebe6',
      }),
      modifier('front-wall', { id: 'front-soft-edges', type: 'bevel', width: 0.04, segments: 3 }),
      create({
        id: 'rear-wall',
        name: '后墙 / 阵列贯穿窗洞',
        type: 'box',
        dimensions: [12, 4.4, 0.32],
        position: [0, 1.28, -2.7],
        tone: '#e3e7e1',
      }),
      ...[-1, 1].map((side) =>
        create({
          id: `side-wall-${side}`,
          name: `${side} 侧墙 / 320mm 厚`,
          type: 'box',
          dimensions: [0.32, 4.4, 5.4],
          position: [side * 5.84, 1.28, 0],
          tone: '#e3e7e1',
        }),
      ),
      create({
        id: 'roof-deck',
        name: '320mm 屋面板',
        type: 'box',
        dimensions: [12.7, 0.32, 6.35],
        position: [0, 5.68, 0],
        tone: '#f0f0eb',
      }),
      modifier('roof-deck', { id: 'roof-deck-bevel', type: 'bevel', width: 0.035, segments: 3 }),
    ],
    'hall-walls-and-slabs',
  );
  for (const x of [-4, 0, 4]) {
    const id = `arch-cutter-${x}`;
    await author.commands(
      [
        create({ id, name: `${x} 拱洞扫掠操作数`, type: 'box', position: [x, 1.28, 2.7], visible: false }),
        surface(id, {
          operation: 'sweep',
          profile: archProfile(),
          path: { closed: false, points: [{ position: [0, 0, -0.6] }, { position: [0, 0, 0.6] }] },
          segments: 1,
          profileSegments: 1,
          caps: true,
          thickness: 0,
        }),
        modifier('front-wall', {
          id: `arch-opening-${x}`,
          type: 'boolean',
          operandId: id,
          operation: 'subtract',
        }),
      ],
      `true-arch-opening-${x}`,
    );
  }
  await author.commands(
    [
      create({
        id: 'rear-window-cutter',
        name: '后窗阵列操作数源',
        type: 'box',
        dimensions: [1.48, 1.85, 1.0],
        position: [-4.2, 2.25, -2.7],
        visible: false,
      }),
      modifier('rear-window-cutter', {
        id: 'four-window-array',
        type: 'array',
        count: 4,
        offset: [2.8, 0, 0],
      }),
      modifier('rear-wall', {
        id: 'rear-windows',
        type: 'boolean',
        operandId: 'rear-window-cutter',
        operation: 'subtract',
      }),
      create({
        id: 'window-sill',
        name: '后窗台阵列源',
        type: 'box',
        dimensions: [1.65, 0.1, 0.56],
        position: [-4.2, 2.18, -2.72],
        tone: '#c2cec5',
      }),
      modifier('window-sill', { id: 'four-sill-array', type: 'array', count: 4, offset: [2.8, 0, 0] }),
      ...[-4, 0, 4].map((x) =>
        create({
          id: `interior-bench-${x}`,
          name: `${x} 馆内长凳`,
          type: 'box',
          dimensions: [2.2, 0.43, 0.62],
          position: [x, 1.28, -1.5],
          tone: '#b6c5bb',
        }),
      ),
    ],
    'retained-window-array-dependencies',
  );
}

function rail(id: string, name: string, points: Vec3[]): Command {
  return create({
    id,
    name,
    type: 'box',
    tone: '#b0bfb5',
    modeling: {
      kind: 'curve',
      profile: 'tube',
      closed: false,
      radius: 0.045,
      radialSegments: 8,
      segments: 32,
      points,
    },
  });
}
function posts(id: string, points: Vec3[], count: number): Command[] {
  return [
    create({ id, name: `${id} 立柱阵列源`, type: 'box', dimensions: [0.065, 0.84, 0.065], tone: '#c0cbc2' }),
    modifier(id, {
      id: `${id}-path`,
      type: 'curve-array',
      points,
      count,
      axis: 'y',
      orient: false,
      closed: false,
    }),
  ];
}

async function stairs() {
  const commands: Command[] = [];
  for (let index = 0; index < 8; index++)
    commands.push(
      create({
        id: `stair-${index + 1}`,
        name: `第 ${index + 1} 级 / 160mm 踏高`,
        type: 'box',
        dimensions: [3.6, (index + 1) * 0.16, 0.32],
        position: [0, 0, 6.56 - (index + 0.5) * 0.32],
        tone: index % 2 ? '#dbe0d8' : '#e5e7e0',
      }),
    );
  for (const side of [-1, 1]) {
    const x = side * 1.76;
    commands.push(
      rail(`stair-rail-${side}`, `${side} 楼梯斜扶手`, [
        [x, 1.0, 6.4],
        [x, 2.12, 4.16],
      ]),
      ...posts(
        `stair-posts-${side}`,
        [
          [x, 0.16, 6.4],
          [x, 1.28, 4.16],
        ],
        8,
      ),
    );
  }
  await author.commands(commands, 'eight-real-steps-and-path-rails');
  await author.save('stair-dimensions.json', {
    rise: 0.16,
    tread: 0.32,
    count: 8,
    platformTop: 1.28,
    topStep: author.project.objects.find((object) => object.id === 'stair-8'),
    railSources: author.project.objects.filter((object) => object.id.startsWith('stair-')),
  });
}

async function roof() {
  const commands: Command[] = [];
  const paths: { id: string; points: Vec3[]; count: number }[] = [
    {
      id: 'roof-front',
      points: [
        [-6.12, 6.0, 2.95],
        [6.12, 6.0, 2.95],
      ],
      count: 15,
    },
    {
      id: 'roof-rear',
      points: [
        [-6.12, 6.0, -2.95],
        [6.12, 6.0, -2.95],
      ],
      count: 15,
    },
    {
      id: 'roof-left',
      points: [
        [-6.12, 6.0, -2.95],
        [-6.12, 6.0, 2.95],
      ],
      count: 8,
    },
    {
      id: 'roof-right',
      points: [
        [6.12, 6.0, -2.95],
        [6.12, 6.0, 2.95],
      ],
      count: 8,
    },
  ];
  for (const path of paths)
    commands.push(
      rail(
        `${path.id}-rail`,
        `${path.id} 屋面扶手`,
        path.points.map(([x, y, z]) => [x, y + 0.84, z]),
      ),
      ...posts(`${path.id}-posts`, path.points, path.count),
    );
  const octagon = (radius: number) =>
    profile(
      Array.from({ length: 8 }, (_, index) => {
        const angle = (index * Math.PI) / 4;
        return [radius * Math.cos(angle), radius * Math.sin(angle)];
      }),
    );
  commands.push(
    create({
      id: 'tower-shaft',
      name: '三截面放样观测塔',
      type: 'box',
      position: [2.4, 6, -0.4],
      tone: '#d7dfd6',
    }),
    surface('tower-shaft', {
      operation: 'loft',
      sections: [
        { profile: octagon(1.16), position: [0, 0, 0], rotation: [-90, 0, 0] },
        { profile: octagon(0.94), position: [0, 1.1, 0], rotation: [-90, 0, 0] },
        { profile: octagon(0.82), position: [0, 2.05, 0], rotation: [-90, 0, 0] },
      ],
      segments: 2,
      profileSegments: 1,
      closed: false,
      caps: true,
      thickness: 0.12,
      interpolation: 'linear',
    }),
    create({
      id: 'tower-crown',
      name: '真实剖切塔冠',
      type: 'box',
      dimensions: [2.35, 1.28, 2.35],
      position: [2.4, 8.05, -0.4],
      tone: '#edf0e8',
    }),
    create({
      id: 'roof-vent',
      name: '屋面通风构件阵列源',
      type: 'box',
      dimensions: [0.16, 0.5, 1.15],
      position: [-4.15, 6, -0.1],
      tone: '#b8c6bc',
    }),
    modifier('roof-vent', { id: 'vent-array', type: 'array', count: 7, offset: [0.32, 0, 0] }),
  );
  await author.commands(commands, 'roof-rails-loft-tower-and-array');
  await author.command('mesh_convert', { id: 'tower-crown' });
  await author.save('tower-before-bisect.json', await author.inspect('tower-crown', 'face'));
  await author.command('topology_bisect', {
    id: 'tower-crown',
    normal: [0.34, 1, 0.12],
    offset: 0.84,
    keep: 'negative',
    fill: true,
    tolerance: 0.000001,
  });
  await author.save('tower-after-bisect.json', await author.inspect('tower-crown', 'face'));
  await author.commands(
    [modifier('tower-crown', { id: 'crown-cut-edge', type: 'bevel', width: 0.06, segments: 3 })],
    'editable-beveled-cut-surface',
  );
}

const views: { id: string; name: string; position: Vec3; end: Vec3; target: Vec3; fov: number }[] = [
  {
    id: 'overall',
    name: '三拱观测馆整体',
    position: [18, 13, 22],
    end: [-17, 11, 23],
    target: [0, 3.7, 0.5],
    fov: 46,
  },
  {
    id: 'arches',
    name: '台阶、扶手和贯穿拱洞',
    position: [6.4, 3.8, 13.8],
    end: [-4.3, 3.2, 11.3],
    target: [0, 2.7, 2.4],
    fov: 48,
  },
  {
    id: 'roof',
    name: '屋面栏杆与剖切塔冠',
    position: [11.3, 12.6, 8.5],
    end: [10.5, 12, -8.5],
    target: [0.6, 6.8, -0.2],
    fov: 50,
  },
  {
    id: 'rear',
    name: '墙厚与阵列窗洞',
    position: [-12, 7.3, -15.5],
    end: [11.5, 7.6, -16],
    target: [0, 3.7, -1.4],
    fov: 44,
  },
];
async function cameras() {
  await author.commands(
    [
      ...views.flatMap((view): Command[] => [
        {
          type: 'camera.create',
          payload: {
            id: `camera-${view.id}`,
            name: view.name,
            position: view.position,
            target: view.target,
            fov: view.fov,
            keyframes: [
              {
                id: `${view.id}-start`,
                time: 0,
                position: view.position,
                target: view.target,
                fov: view.fov,
                easing: 'smooth',
              },
              {
                id: `${view.id}-end`,
                time: 6,
                position: view.end,
                target: view.target,
                fov: view.fov,
                easing: 'smooth',
              },
            ],
          },
        },
        {
          type: 'shot.create',
          payload: {
            id: `shot-${view.id}`,
            name: view.name,
            cameraId: `camera-${view.id}`,
            sourceIn: 0,
            sourceOut: 6,
            subjectIds: ['front-wall'],
            intent: '检查真实建筑结构、开口和可编辑参数',
          },
        },
      ]),
      {
        type: 'sequence.update',
        payload: {
          id: author.project.activeSequenceId,
          patch: {
            name: '三拱观测馆建模展示',
            clips: views.map((view) => ({
              id: `clip-${view.id}`,
              shotId: `shot-${view.id}`,
              sourceIn: 0,
              sourceOut: 6,
            })),
          },
        },
      },
    ],
    'four-moving-architectural-views',
  );
}

async function revisionProof() {
  const object = () => author.project.objects.find((item) => item.id === 'roof-front-posts')!;
  const source = object().modeling;
  if (!source || !('modifiers' in source)) throw new Error('Roof posts lost their retained path');
  const path = source.modifiers?.find((item) => item.id === 'roof-front-posts-path');
  if (!path || path.type !== 'curve-array') throw new Error('Roof posts have no curve array');
  const before = digest(source);
  const beforeGeometry = await author.inspect('roof-front-posts', 'vertex', 'evaluated');
  await author.command('modifier_set', { id: object().id, modifier: { ...path, count: 17 } });
  const after = digest(object().modeling);
  const afterGeometry = await author.inspect('roof-front-posts', 'vertex', 'evaluated');
  if (before === after || beforeGeometry.total === afterGeometry.total)
    throw new Error('Array edit did not change actual posts');
  await author.command('history_undo', {});
  if (digest(object().modeling) !== before) throw new Error('Undo did not restore the architectural source');
  await author.command('history_redo', {});
  if (digest(object().modeling) !== after) throw new Error('Redo did not reproduce the architectural edit');
  await author.save('revision-evidence.json', {
    objectId: object().id,
    before,
    after,
    beforeGeometry,
    afterGeometry,
    undoMatches: true,
    redoMatches: true,
  });
}

async function orientArches() {
  await author.commands(
    [-4, 0, 4].map((x): Command => ({
      type: 'object.update',
      payload: { id: `arch-cutter-${x}`, patch: { rotation: [0, 0, 90] } },
    })),
    'orient-sweep-frames-for-upright-arches',
  );
}

try {
  await author.connect();
  if (values.project) author.project = await author.call('project_open', { id: values.project });
  else await author.create('三拱观测馆 / 可编辑建筑地标');
  const stages = [
    ['hall', hall],
    ['stairs', stairs],
    ['roof', roof],
    ['cameras', cameras],
    ['proof', revisionProof],
    ['orient', orientArches],
  ] as const;
  const start = values.from === 'export' ? stages.length : stages.findIndex(([name]) => name === values.from);
  if (start < 0) throw new Error(`Unknown production stage: ${values.from}`);
  for (const [, run] of stages.slice(start)) await run();
  for (const id of [
    'front-wall',
    'rear-wall',
    'arch-cutter-0',
    'stair-posts-1',
    'tower-shaft',
    'tower-crown',
  ])
    await author.save(`${id}-inspection.json`, await author.inspect(id, 'face', 'evaluated'));
  await author.refresh();
  await author.save('project.json', author.project);
  if (!values['skip-export']) {
    for (const view of views) await author.preview(`${view.id}.png`, `shot-${view.id}`, 3);
    await author.exportGlb();
    await author.exportVideo('architecture', 24);
    await author.exportPackage();
    await author.reviewVideo();
  }
  await author.save('production-report.json', {
    projectId: author.project.id,
    revision: author.project.revision,
    directory: author.directory,
    objects: author.project.objects.length,
    duration: 24,
    method:
      'Public MCP from empty project, live sweep Boolean arches, curve arrays, loft and topology bisect',
    visualReview: 'pending',
    restartAndRestore: 'pending',
  });
  console.log(
    JSON.stringify({
      projectId: author.project.id,
      revision: author.project.revision,
      directory: author.directory,
    }),
  );
} catch (error) {
  await author
    .save('failure.json', {
      error: String(error),
      projectId: author.project?.id,
      revision: author.project?.revision,
    })
    .catch(() => {});
  console.error(JSON.stringify({ failed: true, error: String(error), directory: author.directory }));
  process.exitCode = 1;
} finally {
  await author.close();
}
