import { parseArgs } from 'node:util';
import type { Command, Project, Vec3 } from '../../shared/types';
import type { MeshData } from '../../shared/modeling';
import { ModelingAssetClient } from './client';
import {
  artifacts,
  cameras,
  create,
  ellipse,
  modificationCycle,
  modify,
  settings,
  surface,
  type ShowcaseView,
} from './design';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4222' },
    'skip-export': { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
  },
});
const author = new ModelingAssetClient('mechanical', values.api);

function wing(): MeshData {
  const rows = [
    [0, 0, -0.9, 1.5],
    [0.5, 0.03, -1.0, 1.5],
    [1.5, 0.1, -1.1, 1.1],
    [3.5, 0.28, -1.45, 0.25],
    [4.0, 0.42, -1.5, -0.08],
  ];
  const vertices: Vec3[] = rows.flatMap(([x, y, back, front]) =>
    [0, 0.12, 0.5, 0.9, 1].map((fraction): Vec3 => [
      x,
      y + Math.sin(fraction * Math.PI) * 0.12,
      back + (front - back) * fraction,
    ]),
  );
  const faces: number[][] = [];
  for (let row = 0; row < rows.length - 1; row++)
    for (let column = 0; column < 4; column++) {
      const a = row * 5 + column;
      faces.push([a, a + 1, a + 6, a + 5]);
    }
  return { kind: 'mesh', vertices, faces, smooth: true };
}

async function fuselage() {
  const sections = [
    [-3.5, 0.12, 0.18],
    [-2.8, 0.48, 0.4],
    [-1.5, 0.75, 0.57],
    [0, 0.85, 0.67],
    [1.5, 0.68, 0.62],
    [2.5, 0.43, 0.42],
    [3.35, 0.06, 0.09],
  ].map(([z, width, height]) => ({
    position: [0, 0, z],
    rotation: [0, 0, 0],
    profile: ellipse(width, height),
  }));
  await author.commands(
    [
      create({ id: 'fuselage', name: '七截面机身主壳', type: 'box', position: [0, 2.4, 0], tone: '#e7eae6' }),
      surface('fuselage', {
        operation: 'loft',
        sections,
        segments: 3,
        profileSegments: 5,
        caps: true,
        thickness: 0.035,
      }),
      create({
        id: 'wing',
        name: '镜像细分翼面控制笼',
        type: 'box',
        position: [0, 2.15, -0.1],
        tone: '#d8dfd9',
        modeling: wing(),
      }),
      modify('wing', { id: 'wing-mirror', type: 'mirror', axis: 'x', weldThreshold: 0.00001 }),
      modify('wing', { id: 'wing-subdivision', type: 'catmull-clark', iterations: 2, boundary: 'corners' }),
      modify('wing', { id: 'wing-shell', type: 'solidify', thickness: 0.095, offset: 0 }),
      create({ id: 'canopy', name: '驾驶舱曲面罩', type: 'box', position: [0, 2.83, 1.12], tone: '#9baaa3' }),
      surface('canopy', {
        operation: 'loft',
        sections: [
          [-1.0, 0.18, 0.08],
          [-0.5, 0.51, 0.4],
          [0.35, 0.46, 0.42],
          [1.0, 0.12, 0.1],
        ].map(([z, x, y]) => ({ position: [0, 0, z], profile: ellipse(x, y) })),
        segments: 5,
        profileSegments: 5,
        caps: true,
      }),
    ],
    'fuselage-wing-sources',
  );
  const edges = await author.inspect('wing', 'edge');
  const edge = edges.elements.find((item) =>
    item.positions?.every((point) => Math.abs(point[0] - 0.5) < 1e-6 && point[2] < -0.6),
  );
  if (!edge) throw new Error('Wing support-loop edge unavailable');
  await author.command('topology_loop-cut', {
    id: 'wing',
    selection: { namespace: edges.namespace, kind: 'edge', ids: [edge.id] },
    cuts: 1,
    slide: 0.18,
  });
  await author.save('wing-topology-edit.json', await author.inspect('wing', 'face'));
}

async function engines() {
  for (const side of [-1, 1]) {
    const id = `engine-${side}`;
    const commands: Command[] = [
      create({
        id,
        name: `${side} 环形旋转发动机壳`,
        type: 'box',
        position: [side * 1.8, 1.75, -0.7],
        rotation: [90, 0, 0],
        tone: '#d3dad4',
      }),
      surface(id, {
        operation: 'revolve',
        angle: 360,
        segments: 48,
        profileSegments: 1,
        caps: true,
        profile: {
          closed: true,
          points: [
            [0.48, -1.2],
            [0.63, -0.95],
            [0.67, 0],
            [0.56, 0.8],
            [0.43, 1.05],
            [0.35, 1.05],
            [0.4, 0.7],
            [0.47, 0],
            [0.48, -0.85],
            [0.39, -1.2],
          ].map((position) => ({ position })),
        },
      }),
      create({
        id: `${id}-fan`,
        name: `${side} 涡扇叶片阵列源`,
        type: 'box',
        dimensions: [0.06, 0.2, 0.1],
        position: [side * 1.8, 1.75, 0.43],
        tone: '#a4b1a8',
      }),
      modify(`${id}-fan`, {
        id: `${id}-radial`,
        type: 'curve-array',
        axis: 'x',
        count: 16,
        closed: true,
        orient: true,
        points: Array.from({ length: 16 }, (_, i) => [
          Math.cos((i * Math.PI) / 8) * 0.29,
          Math.sin((i * Math.PI) / 8) * 0.29,
          0,
        ]),
      }),
      create({
        id: `${id}-hub`,
        name: `${side} 涡扇轴心`,
        type: 'sphere',
        dimensions: [0.32, 0.32, 0.48],
        position: [side * 1.8, 1.6, 0.46],
        tone: '#e4e8e1',
      }),
      create({
        id: `${id}-mount`,
        name: `${side} 带检修孔吊架`,
        type: 'box',
        dimensions: [0.26, 0.5, 0.9],
        position: [side * 1.8, 1.85, -0.5],
        tone: '#c6cfc7',
      }),
      modify(`${id}-mount`, { id: `${id}-round`, type: 'bevel', width: 0.035, segments: 3 }),
      create({
        id: `${id}-drill`,
        name: `${side} 检修孔保留操作数`,
        type: 'cylinder',
        dimensions: [0.24, 0.6, 0.24],
        position: [side * 1.8 - 0.3, 2.1, -0.5],
        rotation: [0, 0, -90],
        visible: false,
      }),
      modify(`${id}-mount`, {
        id: `${id}-hole`,
        type: 'boolean',
        operation: 'subtract',
        operandId: `${id}-drill`,
      }),
    ];
    await author.commands(commands, `engine-assembly-${side}`);
  }
}

async function details() {
  const fin: MeshData = {
    kind: 'mesh',
    vertices: [
      [0, 0, -1.0],
      [0, 1.5, -1.1],
      [0, 1.2, -0.7],
      [0, 0, 0.65],
    ],
    faces: [[0, 1, 2, 3]],
    smooth: false,
  };
  const commands: Command[] = [
    create({ id: 'tail-fin', name: '垂直尾翼薄壳', type: 'box', position: [0, 2.6, -2.0], modeling: fin }),
    modify('tail-fin', { id: 'tail-thickness', type: 'solidify', thickness: 0.1, offset: 0 }),
    create({
      id: 'tail-plane',
      name: '水平尾翼',
      type: 'box',
      position: [0, 2.65, -2.4],
      scale: [0.52, 0.65, 0.52],
      modeling: wing(),
    }),
    modify('tail-plane', { id: 'tail-mirror', type: 'mirror', axis: 'x', weldThreshold: 0.00001 }),
    modify('tail-plane', { id: 'tail-solid', type: 'solidify', thickness: 0.1, offset: 0 }),
  ];
  for (const side of [-1, 1]) {
    commands.push(
      create({
        id: `flap-${side}`,
        name: `${side} 后缘襟翼`,
        type: 'box',
        dimensions: [2.0, 0.06, 0.24],
        position: [side * 2.0, 2.26, -1.32],
        rotation: [0, side * 9, side * 4],
        tone: '#c0cac2',
      }),
      modify(`flap-${side}`, { id: `flap-bevel-${side}`, type: 'bevel', width: 0.015, segments: 2 }),
      create({
        id: `gear-${side}`,
        name: `${side} 主起落架`,
        type: 'box',
        dimensions: [0.12, 1.73, 0.16],
        position: [side * 1.05, 0.47, -0.65],
        rotation: [0, 0, -side * 9],
        tone: '#9caba0',
      }),
      create({
        id: `tire-${side}`,
        name: `${side} 主轮胎`,
        type: 'cylinder',
        dimensions: [0.7, 0.27, 0.7],
        position: [side * 1.05 - 0.135, 0.35, -0.65],
        rotation: [0, 0, -90],
        tone: '#7e8c83',
      }),
      create({
        id: `wheel-hub-${side}`,
        name: `${side} 轮毂`,
        type: 'cylinder',
        dimensions: [0.35, 0.3, 0.35],
        position: [side * 1.05 - 0.15, 0.35, -0.65],
        rotation: [0, 0, -90],
        tone: '#ced7cc',
      }),
    );
  }
  commands.push(
    create({
      id: 'nose-gear',
      name: '前起落架',
      type: 'box',
      dimensions: [0.11, 1.9, 0.13],
      position: [0, 0.36, 2.0],
      tone: '#a4b2a7',
    }),
    create({
      id: 'nose-tire',
      name: '前轮胎',
      type: 'cylinder',
      dimensions: [0.52, 0.22, 0.52],
      position: [-0.11, 0.26, 2.0],
      rotation: [0, 0, -90],
      tone: '#87968a',
    }),
  );
  await author.commands(commands, 'tail-gear-panels');
  await author.command('mesh_convert', { id: 'flap-1' });
  await author.command('topology_bisect', {
    id: 'flap-1',
    normal: [1, 0, 0],
    offset: 0.82,
    keep: 'negative',
    fill: true,
  });
  await author.command('topology_repair', {
    id: 'flap-1',
    removeLooseVertices: true,
    orientFaces: 'outward',
  });
  await author.save('panel-cut-repair.json', await author.inspect('flap-1', 'edge'));
}

async function hydraulics() {
  for (const side of [-1, 1]) {
    const fan = author.project.objects.find((object) => object.id === `engine-${side}-fan`)!;
    if (!(
      fan.modeling?.kind === 'stack' && fan.modeling.modifiers.some((modifier) => modifier.type === 'twist')
    ))
      await author.commands(
        [
          {
            type: 'modifier.add',
            payload: {
              id: fan.id,
              index: 0,
              modifier: { id: `fan-pitch-${side}`, type: 'twist', axis: 'y', angle: 18, from: 0, to: 0.2 },
            },
          },
        ],
        `pitched-fan-${side}`,
      );
    const id = `hydraulic-sleeve-${side}`;
    if (author.project.objects.some((object) => object.id === id)) continue;
    const vertices: Vec3[] = [0, 0.65].flatMap((y) =>
      [0.135, 0.105].flatMap((radius) =>
        Array.from({ length: 8 }, (_, index): Vec3 => [
          Math.cos((index * Math.PI) / 4) * radius,
          y,
          Math.sin((index * Math.PI) / 4) * radius,
        ]),
      ),
    );
    const faces = [0, 1].flatMap((end) =>
      Array.from({ length: 8 }, (_, index) => {
        const next = (index + 1) % 8;
        const face = [index, next, next + 8, index + 8].map((vertex) => vertex + end * 16);
        return end ? face.reverse() : face;
      }),
    );
    await author.commands(
      [
        create({
          id,
          name: `${side} 桥接液压套筒`,
          type: 'box',
          position: [side * 1.15, 0.85, -0.65],
          tone: '#b4c2b4',
          modeling: { kind: 'mesh', vertices, faces, smooth: false },
        }),
      ],
      `hydraulic-source-${side}`,
    );
    for (const radius of [0.135, 0.105]) {
      const edges = await author.inspect(id, 'edge');
      const ids = edges.elements
        .filter(
          (edge) =>
            edge.boundary &&
            edge.positions?.every((point) => Math.abs(Math.hypot(point[0], point[2]) - radius) < 1e-5),
        )
        .map((edge) => edge.id);
      if (ids.length !== 16)
        throw new Error('Hydraulic sleeve requires two complete eight-edge boundary loops');
      await author.command('topology_bridge', {
        id,
        selection: { namespace: edges.namespace, kind: 'edge', ids },
        segments: 3,
        twist: 0,
      });
    }
    const inspection = await author.inspect(id, 'edge');
    if (inspection.elements.some((edge) => edge.boundary))
      throw new Error('Bridged hydraulic sleeve retains an unexpected boundary');
    await author.save(`hydraulic-${side}-bridge.json`, inspection);
  }
}

const views: ShowcaseView[] = [
  {
    name: '机体轮廓与翼面',
    from: [8.4, 5.0, 11],
    to: [10.0, 4.1, 8.4],
    target: [0, 2.0, 0],
    subjects: ['fuselage', 'wing'],
  },
  {
    name: '进气环与涡扇叶片',
    from: [5.1, 2.8, 5.8],
    to: [3.8, 2.1, 5.2],
    target: [1.5, 1.95, 0.1],
    fov: 39,
    subjects: ['engine-1', 'engine-1-fan', 'engine-1-mount'],
  },
  {
    name: '翼面细分与尾翼',
    from: [-8.2, 6.6, -8.5],
    to: [-9.0, 4.8, -6.5],
    target: [0, 2.1, -0.6],
    subjects: ['wing', 'tail-fin', 'tail-plane'],
  },
  {
    name: '底部机械连接',
    from: [6.0, 1.45, -7.5],
    to: [8.0, 1.65, -4.5],
    target: [0, 1.8, -0.35],
    fov: 46,
    subjects: ['engine-1-mount', 'gear-1', 'nose-gear'],
  },
];

try {
  await author.connect();
  if (values.resume) {
    author.project = await author.call<Project>('project_get');
    await author.commands(
      [
        { type: 'object.update', payload: { id: 'nose-gear', patch: { dimensions: [0.11, 1.9, 0.13] } } },
        ...[-1, 1].map((side): Command => ({
          type: 'object.update',
          payload: { id: `gear-${side}`, patch: { dimensions: [0.12, 1.73, 0.16] } },
        })),
        { type: 'object.update', payload: { id: 'tail-fin', patch: { tone: '#b8c6bb' } } },
      ],
      'mechanical-connection-review',
    );
  } else {
    await author.create('高级白模 / 双发巡航验证机');
    await author.save('modeling-checklist.json', {
      hardSurface: ['wing', 'tail-fin', 'flap-1'],
      surfaces: ['fuselage', 'canopy', 'engine-1'],
      openings: ['engine-1', 'engine-1-mount'],
      dependencies: ['wing-mirror', 'engine-1-hole', 'engine-1-radial'],
      topology: [
        'wing support loop',
        'flap bisect and outward repair',
        'inner and outer hydraulic sleeve boundary bridges',
      ],
    });
    await settings(author, '双发巡航机 / 结构检查台');
    await fuselage();
    await engines();
    await details();
    await modificationCycle(author, 'wing', {
      id: 'wing-shell',
      type: 'solidify',
      enabled: true,
      thickness: 0.105,
      offset: 0,
    });
    await cameras(author, views);
  }
  await hydraulics();
  if (!values['skip-export']) await artifacts(author, views);
  console.log(
    JSON.stringify({
      directory: author.directory,
      projectId: author.project.id,
      revision: author.project.revision,
    }),
  );
} finally {
  await author.close();
}
