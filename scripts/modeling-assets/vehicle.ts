import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import type { Command, Vec3 } from '../../shared/types';
import type { MeshModifier } from '../../shared/modifier-schema';
import { ModelingAssetClient, type MeshInspection } from './client';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4220' },
    project: { type: 'string' },
    from: { type: 'string', default: 'body' },
    'skip-export': { type: 'boolean', default: false },
  },
});
const author = new ModelingAssetClient('vehicle', values.api);
const create = (payload: Record<string, unknown>): Command => ({ type: 'object.create', payload });
const modifier = (id: string, value: Record<string, unknown>): Command => ({
  type: 'modifier.add',
  payload: { id, modifier: value },
});
const surface = (id: string, value: Record<string, unknown>): Command => ({
  type: 'surface.set',
  payload: { id, surface: { kind: 'surface', smooth: true, ...value } },
});
const profile = (points: number[][]) => ({
  outer: { closed: true, points: points.map((position) => ({ position })) },
  holes: [],
});
const selection = (inspection: MeshInspection, ids: string[]) => ({
  namespace: inspection.namespace,
  kind: inspection.kind,
  ids,
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function bodySections() {
  return [
    [-2.25, 0.66, 0.6],
    [-1.95, 0.87, 0.84],
    [-1.4, 0.95, 0.94],
    [-0.3, 0.91, 0.86],
    [0.85, 0.9, 0.91],
    [1.4, 0.94, 0.91],
    [2.15, 0.73, 0.68],
    [2.25, 0.63, 0.56],
  ].map(([z, width, top]) => ({
    position: [0, 0, z],
    rotation: [0, 0, 0],
    profile: profile([
      [-width * 0.8, 0.29],
      [width * 0.8, 0.29],
      [width, 0.43],
      [width * 0.96, top - 0.08],
      [width * 0.7, top],
      [-width * 0.7, top],
      [-width * 0.96, top - 0.08],
      [-width, 0.43],
    ]),
  }));
}

function roofCage() {
  const xs = [0, 0.22, 0.48, 0.67];
  const rows = [
    [-1.17, 1.05],
    [-1.02, 1.24],
    [-0.6, 1.37],
    [-0.1, 1.37],
    [0.35, 1.25],
    [0.57, 1.05],
  ];
  const vertices = rows.flatMap(([z, height]) => xs.map((x) => [x, height - 0.045 * (x / 0.67) ** 2, z]));
  const faces: number[][] = [];
  for (let row = 0; row < rows.length - 1; row++)
    for (let column = 0; column < xs.length - 1; column++) {
      const a = row * xs.length + column;
      faces.push([a, a + xs.length, a + xs.length + 1, a + 1]);
    }
  return { vertices, faces, smooth: true };
}

async function body() {
  await author.commands(
    [
      {
        type: 'project.settings',
        payload: {
          fps: 24,
          aspect: '16:9',
          resolution: 720,
          lighting: { intensity: 2.5, ambient: 0.85, azimuth: 125, elevation: 42 },
          environment: { ground: true, background: '#d7dddc', groundTone: '#b9c4c1' },
        },
      },
      { type: 'project.update', payload: { sceneName: 'GT 车体建模检查台' } },
      create({ id: 'car-body', name: '八截面放样车身壳', type: 'box', tone: '#e4e6e3' }),
      surface('car-body', {
        operation: 'loft',
        sections: bodySections(),
        interpolation: 'centripetal',
        segments: 3,
        profileSegments: 1,
        closed: false,
        caps: true,
        thickness: 0.025,
      }),
      create({ id: 'roof-panel', name: '镜像细分车顶控制笼', type: 'box', tone: '#eff0ec' }),
      { type: 'mesh.set', payload: { id: 'roof-panel', mesh: roofCage() } },
    ],
    'body-sources',
  );
  await author.save('body-source-project.json', author.project);
  await author.commands(
    [
      ...[
        [-1.4, 'rear'],
        [1.35, 'front'],
      ].flatMap(([z, label]) => [
        create({
          id: `wheel-cut-${label}`,
          name: `${label} 轮拱切削柱`,
          type: 'cylinder',
          dimensions: [0.86, 3.0, 0.86],
          position: [1.5, 0.39, z],
          rotation: [0, 0, 90],
          visible: false,
        }),
        modifier('car-body', {
          id: `arch-${label}`,
          type: 'boolean',
          operandId: `wheel-cut-${label}`,
          operation: 'subtract',
        }),
      ]),
    ],
    'retained-wheel-arches',
  );
}

async function roof() {
  const edges = await author.inspect('roof-panel', 'edge');
  const seed = edges.elements.find(
    (edge) =>
      edge.positions?.every((point) => Math.abs(point[0] - 0.22) < 1e-6) &&
      edge.positions.some((point) => Math.abs(point[2] + 0.6) < 1e-6) &&
      edge.positions.some((point) => Math.abs(point[2] + 0.1) < 1e-6),
  );
  if (!seed) throw new Error('Roof control cage lacks its planned support-strip edge');
  await author.command('topology_loop-cut', {
    id: 'roof-panel',
    selection: selection(edges, [seed.id]),
    cuts: 1,
    slide: 0,
  });
  const cut = await author.inspect('roof-panel', 'edge');
  const rail = cut.elements.filter((edge) =>
    edge.positions?.every((point) => Math.abs(point[2] + 0.35) < 1e-6),
  );
  if (rail.length !== 3)
    throw new Error('Loop cut did not create the expected three-edge roof support strip');
  await author.command('topology_slide', {
    id: 'roof-panel',
    selection: selection(
      cut,
      rail.map((edge) => edge.id),
    ),
    amount: 0.16,
  });
  const faces = await author.inspect('roof-panel', 'face');
  const inset = faces.elements.find(
    (face) =>
      face.center &&
      face.center[0] > 0.25 &&
      face.center[0] < 0.45 &&
      face.center[2] > 0 &&
      face.center[2] < 0.3,
  );
  if (!inset) throw new Error('Roof panel inset face is unavailable');
  await author.command('topology_inset', {
    id: 'roof-panel',
    selection: selection(faces, [inset.id]),
    thickness: 0.022,
    depth: -0.008,
    mode: 'individual',
  });
  await author.save('roof-topology.json', await author.inspect('roof-panel', 'face'));
  await author.commands(
    [
      modifier('roof-panel', {
        id: 'roof-mirror',
        type: 'mirror',
        axis: 'x',
        offset: 0,
        keepOriginal: true,
        weldThreshold: 0.00001,
      }),
      modifier('roof-panel', {
        id: 'roof-smooth',
        type: 'catmull-clark',
        iterations: 2,
        boundary: 'corners',
      }),
      modifier('roof-panel', { id: 'roof-thickness', type: 'solidify', thickness: 0.035, offset: 0 }),
      create({
        id: 'chassis',
        name: '底盘',
        type: 'box',
        dimensions: [1.56, 0.1, 3.75],
        position: [0, 0.2, -0.05],
        tone: '#868e8b',
      }),
      modifier('chassis', { id: 'chassis-bevel', type: 'bevel', width: 0.025, segments: 3 }),
    ],
    'editable-roof-stack',
  );
}

async function cabin() {
  const commands: Command[] = [];
  for (const side of [-1, 1]) {
    const id = `window-frame-${side}`;
    commands.push(
      create({
        id,
        name: `${side < 0 ? '左' : '右'}侧车窗贯穿框`,
        type: 'box',
        dimensions: [0.06, 0.36, 1.4],
        position: [side * 0.68, 0.87, -0.28],
        tone: '#d9dedb',
      }),
      modifier(id, { id: `${id}-bevel`, type: 'bevel', width: 0.012, segments: 3 }),
      create({
        id: `${id}-cutter`,
        name: `${side} 车窗孔操作数`,
        type: 'box',
        dimensions: [0.3, 0.245, 1.15],
        position: [side * 0.68, 0.925, -0.28],
        visible: false,
      }),
      modifier(id, {
        id: `${id}-opening`,
        type: 'boolean',
        operandId: `${id}-cutter`,
        operation: 'subtract',
      }),
      create({
        id: `b-pillar-${side}`,
        name: `${side} B柱`,
        type: 'box',
        dimensions: [0.068, 0.32, 0.052],
        position: [side * 0.68, 0.9, -0.58],
        tone: '#bdc6c2',
      }),
      create({
        id: `mirror-arm-${side}`,
        name: `${side} 后视镜支臂`,
        type: 'box',
        dimensions: [0.2, 0.045, 0.045],
        position: [side * 0.79, 0.9, 0.49],
      }),
      create({
        id: `mirror-${side}`,
        name: `${side} 后视镜壳`,
        type: 'box',
        dimensions: [0.18, 0.1, 0.25],
        position: [side * 0.91, 0.92, 0.46],
        tone: '#d5ddd8',
      }),
      modifier(`mirror-${side}`, { id: `mirror-${side}-bevel`, type: 'bevel', width: 0.025, segments: 3 }),
      create({
        id: `door-seam-${side}`,
        name: `${side} 门缝`,
        type: 'box',
        tone: '#7e8b86',
        modeling: {
          kind: 'curve',
          profile: 'tube',
          closed: true,
          radius: 0.006,
          radialSegments: 6,
          segments: 64,
          points: [
            [side * 0.91, 0.78, 0.6],
            [side * 0.93, 0.48, 0.48],
            [side * 0.87, 0.34, 0.22],
            [side * 0.88, 0.34, -0.8],
            [side * 0.93, 0.52, -0.94],
            [side * 0.91, 0.81, -0.99],
          ],
        },
      }),
    );
  }
  for (const [id, z, tilt] of [
    ['front', 0.55, -27],
    ['rear', -1.02, 28],
  ] as const) {
    commands.push(
      create({
        id: `screen-${id}`,
        name: `${id} 风挡灰阶占位`,
        type: 'box',
        dimensions: [1.25, 0.4, 0.028],
        position: [0, 0.91, z],
        rotation: [tilt, 0, 0],
        tone: '#a7b5af',
      }),
      modifier(`screen-${id}`, { id: `screen-${id}-bevel`, type: 'bevel', width: 0.008, segments: 2 }),
    );
  }
  await author.commands(commands, 'cabin-windows-and-seams');
}

async function wheels() {
  for (const side of [-1, 1])
    for (const [z, axle] of [
      [-1.4, 'rear'],
      [1.35, 'front'],
    ] as const) {
      const id = `wheel-${side}-${axle}`;
      const commands: Command[] = [
        create({
          id,
          name: `${side} ${axle} 可编辑轮胎`,
          type: 'box',
          position: [side * 0.91, 0.39, z],
          rotation: [0, 0, 90],
          tone: '#909b96',
        }),
        surface(id, {
          operation: 'revolve',
          segments: 40,
          profileSegments: 2,
          angle: 360,
          startAngle: 0,
          caps: true,
          thickness: 0,
          profile: {
            closed: true,
            points: [
              [0.3, -0.13],
              [0.365, -0.13],
              [0.395, -0.075],
              [0.395, 0.075],
              [0.365, 0.13],
              [0.3, 0.13],
            ].map((position) => ({ position })),
          },
        }),
        create({
          id: `${id}-rim`,
          name: `${side} ${axle} 轮圈截面`,
          type: 'box',
          position: [side * 1.04, 0.39, z],
          rotation: [0, 0, 90],
          tone: '#dce2dd',
        }),
        surface(`${id}-rim`, {
          operation: 'revolve',
          segments: 40,
          profileSegments: 1,
          angle: 360,
          caps: true,
          thickness: 0,
          profile: {
            closed: true,
            points: [
              [0.255, -0.023],
              [0.29, -0.023],
              [0.3, 0],
              [0.29, 0.023],
              [0.255, 0.023],
            ].map((position) => ({ position })),
          },
        }),
        create({
          id: `${id}-hub`,
          name: `${id} 轴心`,
          type: 'cylinder',
          dimensions: [0.13, 0.06, 0.13],
          position: [side * 1.07 + 0.03, 0.39, z],
          rotation: [0, 0, 90],
          tone: '#ced8d1',
        }),
      ];
      for (let spoke = 0; spoke < 7; spoke++) {
        const angle = (spoke * Math.PI * 2) / 7;
        commands.push(
          create({
            id: `${id}-spoke-${spoke}`,
            name: `${id} 辐条${spoke + 1}`,
            type: 'box',
            dimensions: [0.032, 0.21, 0.044],
            position: [side * 1.065, 0.39 + 0.055 * Math.cos(angle), z + 0.055 * Math.sin(angle)],
            rotation: [(angle * 180) / Math.PI, 0, 0],
            tone: '#e6e9e4',
          }),
        );
      }
      await author.commands(commands, `wheel-${side}-${axle}`);
    }
}

async function trim() {
  const commands: Command[] = [];
  for (const side of [-1, 1]) {
    for (const [label, z, height] of [
      ['front', 2.03, 0.55],
      ['rear', -2.08, 0.56],
    ] as const) {
      const id = `lamp-${side}-${label}`;
      commands.push(
        create({
          id,
          name: `${side} ${label} 灯组`,
          type: 'box',
          dimensions: [0.43, 0.073, 0.075],
          position: [side * 0.47, height, z],
          tone: '#bac6bf',
        }),
        modifier(id, { id: `${id}-bevel`, type: 'bevel', width: 0.015, segments: 3 }),
      );
    }
  }
  commands.push(
    create({
      id: 'front-intake',
      name: '前进气口贯穿壳',
      type: 'box',
      dimensions: [1.04, 0.22, 0.15],
      position: [0, 0.31, 2.12],
      tone: '#dce2dc',
    }),
    modifier('front-intake', { id: 'intake-bevel', type: 'bevel', width: 0.025, segments: 3 }),
    create({
      id: 'intake-cutter',
      name: '进气口操作数',
      type: 'box',
      dimensions: [0.9, 0.12, 0.4],
      position: [0, 0.36, 2.12],
      visible: false,
    }),
    modifier('front-intake', {
      id: 'intake-opening',
      type: 'boolean',
      operandId: 'intake-cutter',
      operation: 'subtract',
    }),
    create({
      id: 'grille-fin',
      name: '进气格栅阵列源',
      type: 'box',
      dimensions: [0.035, 0.12, 0.11],
      position: [-0.4, 0.36, 2.17],
      tone: '#7d8e84',
    }),
    modifier('grille-fin', { id: 'grille-array', type: 'array', count: 11, offset: [0.08, 0, 0] }),
    create({
      id: 'rear-diffuser',
      name: '后扩散器',
      type: 'box',
      dimensions: [1.15, 0.09, 0.2],
      position: [0, 0.25, -2.08],
      tone: '#8c9b92',
    }),
    modifier('rear-diffuser', { id: 'diffuser-bevel', type: 'bevel', width: 0.025, segments: 3 }),
  );
  await author.commands(commands, 'lights-intake-and-array');
}

const views: { id: string; name: string; position: Vec3; end: Vec3; target: Vec3; fov: number }[] = [
  {
    id: 'overall',
    name: '整车轮廓与轮拱',
    position: [4.8, 2.4, 5.3],
    end: [5.3, 1.8, -2.8],
    target: [0, 0.65, 0],
    fov: 40,
  },
  {
    id: 'nose',
    name: '前轮拱、灯组和进气孔',
    position: [2.6, 1.1, 3.25],
    end: [1.5, 0.72, 3.5],
    target: [0.25, 0.57, 1.25],
    fov: 42,
  },
  {
    id: 'roof',
    name: '车窗、厚度与细分车顶',
    position: [2.2, 2.2, 0.3],
    end: [1.4, 2.6, -0.6],
    target: [0, 1.08, -0.23],
    fov: 46,
  },
  {
    id: 'rear',
    name: '车尾、轮毂和下部结构',
    position: [2.9, 1.4, -3.6],
    end: [-1.7, 1.1, -4.1],
    target: [0, 0.61, -1.1],
    fov: 43,
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
            subjectIds: ['car-body'],
            intent: '检查可编辑白模的真实几何细节',
          },
        },
      ]),
      {
        type: 'sequence.update',
        payload: {
          id: author.project.activeSequenceId,
          patch: {
            name: 'GT 白模检查展示',
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
    'four-moving-shots',
  );
}

async function revisionProof() {
  const target = () => author.project.objects.find((object) => object.id === 'roof-panel')!;
  const before = digest(target().modeling);
  const vertices = await author.inspect('roof-panel', 'vertex');
  const crown = vertices.elements.find(
    (vertex) =>
      vertex.position && Math.abs(vertex.position[0]) < 1e-8 && Math.abs(vertex.position[2] + 0.1) < 1e-8,
  );
  if (!crown) throw new Error('Retained roof crown vertex cannot be selected');
  await author.command('topology_transform', {
    id: 'roof-panel',
    selection: selection(vertices, [crown.id]),
    translation: [0, 0.03, 0],
    space: 'local',
  });
  const after = digest(target().modeling);
  if (after === before) throw new Error('Topology edit did not change the retained roof source');
  await author.save('roof-edited-inspection.json', await author.inspect('roof-panel', 'face', 'evaluated'));
  await author.command('history_undo', {});
  if (digest(target().modeling) !== before)
    throw new Error('Undo did not restore the roof source and modifiers');
  await author.command('history_redo', {});
  if (digest(target().modeling) !== after) throw new Error('Redo did not reproduce the roof edit');
  await author.save('revision-evidence.json', {
    objectId: 'roof-panel',
    before,
    after,
    undoMatches: true,
    redoMatches: true,
    retainedModifiers: (target().modeling as { modifiers: MeshModifier[] }).modifiers,
  });
}

function windowPrism(side: number, inner: boolean) {
  const contour = inner
    ? [
        [-0.91, 0.94],
        [-0.96, 1.035],
        [-0.68, 1.23],
        [-0.24, 1.265],
        [0.1, 1.18],
        [0.39, 0.965],
        [0.39, 0.94],
      ]
    : [
        [-1.08, 0.885],
        [-1.1, 1.035],
        [-0.72, 1.3],
        [-0.24, 1.33],
        [0.15, 1.245],
        [0.55, 0.965],
        [0.55, 0.885],
      ];
  const halfThickness = inner ? 0.16 : 0.03;
  const vertices = [-halfThickness, halfThickness].flatMap((offset) =>
    contour.map(([z, y]) => [side * 0.68 + offset, y, z]),
  );
  const count = contour.length;
  const faces: number[][] = [
    Array.from({ length: count }, (_, index) => count - 1 - index),
    Array.from({ length: count }, (_, index) => count + index),
  ];
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    faces.push([index, next, next + count, index + count]);
  }
  return { vertices, faces, smooth: false };
}

async function refine() {
  await author.commands(
    [
      ...[-1, 1].flatMap((side): Command[] => [
        { type: 'object.update', payload: { id: `window-frame-${side}`, patch: { position: [0, 0, 0] } } },
        {
          type: 'object.update',
          payload: { id: `window-frame-${side}-cutter`, patch: { position: [0, 0, 0] } },
        },
        { type: 'mesh.set', payload: { id: `window-frame-${side}`, mesh: windowPrism(side, false) } },
        { type: 'mesh.set', payload: { id: `window-frame-${side}-cutter`, mesh: windowPrism(side, true) } },
        create({
          id: `seat-${side}`,
          name: `${side} 座椅占位`,
          type: 'chair',
          dimensions: [0.42, 0.62, 0.43],
          position: [side * 0.3, 0.49, -0.34],
          rotation: [0, 180, 0],
          tone: '#b4c0b8',
        }),
      ]),
    ],
    'window-profile-refinement',
  );
}

async function exposeDetails() {
  await author.commands(
    [
      ...[-1, 1].flatMap((side): Command[] => [
        {
          type: 'object.update',
          payload: { id: `lamp-${side}-front`, patch: { position: [side * 0.42, 0.545, 2.27] } },
        },
        {
          type: 'object.update',
          payload: { id: `lamp-${side}-rear`, patch: { position: [side * 0.43, 0.53, -2.27] } },
        },
      ]),
      {
        type: 'object.update',
        payload: { id: 'front-intake', patch: { position: [0, 0.305, 2.29] } },
      },
      {
        type: 'object.update',
        payload: { id: 'intake-cutter', patch: { position: [0, 0.355, 2.3] } },
      },
      {
        type: 'object.update',
        payload: { id: 'grille-fin', patch: { position: [-0.4, 0.355, 2.37] } },
      },
      modifier('car-body', {
        id: 'body-intake-opening',
        type: 'boolean',
        operandId: 'intake-cutter',
        operation: 'subtract',
      }),
      {
        type: 'object.update',
        payload: { id: 'rear-diffuser', patch: { position: [0, 0.25, -2.27] } },
      },
      {
        type: 'object.update',
        payload: {
          id: 'screen-front',
          patch: { position: [0, 0.89, 0.55], dimensions: [1.25, 0.38, 0.028], rotation: [27, 0, 0] },
        },
      },
      {
        type: 'object.update',
        payload: {
          id: 'screen-rear',
          patch: { position: [0, 0.96, -1.12], dimensions: [1.25, 0.32, 0.028], rotation: [-30, 0, 0] },
        },
      },
    ],
    'visible-intake-light-and-windshield-details',
  );
}

async function fitScreens() {
  const commands: Command[] = [];
  for (const [id, sign, bottomZ, topZ, topY] of [
    ['front', 1, 0.6, 0.24, 1.245],
    ['rear', -1, -1.19, -0.86, 1.235],
  ] as const) {
    const outer = [
      [-sign * 0.62, 0.955, bottomZ],
      [sign * 0.62, 0.955, bottomZ],
      [sign * 0.59, topY, topZ],
      [-sign * 0.59, topY, topZ],
    ];
    const vertices = [...outer, ...outer.map(([x, y, z]) => [x, y, z - sign * 0.024])];
    commands.push(
      {
        type: 'modifier.set',
        payload: {
          id: `screen-${id}`,
          modifier: { id: `screen-${id}-bevel`, type: 'bevel', width: 0.003, segments: 2 },
        },
      },
      {
        type: 'object.update',
        payload: { id: `screen-${id}`, patch: { position: [0, 0, 0], rotation: [0, 0, 0] } },
      },
      {
        type: 'mesh.set',
        payload: {
          id: `screen-${id}`,
          mesh: {
            vertices,
            faces: [
              [0, 1, 2, 3],
              [7, 6, 5, 4],
              [0, 4, 5, 1],
              [1, 5, 6, 2],
              [2, 6, 7, 3],
              [3, 7, 4, 0],
            ],
            smooth: false,
          },
        },
      },
    );
  }
  await author.commands(commands, 'fitted-windshield-source-meshes');
}

try {
  await author.connect();
  if (values.project) author.project = await author.call('project_open', { id: values.project });
  else await author.create('GT-01 / 可编辑白模车体');
  const stages = [
    ['body', body],
    ['roof', roof],
    ['cabin', cabin],
    ['wheels', wheels],
    ['trim', trim],
    ['cameras', cameras],
    ['proof', revisionProof],
    ['refine', refine],
    ['details', exposeDetails],
    ['screens', fitScreens],
  ] as const;
  const start = values.from === 'export' ? stages.length : stages.findIndex(([name]) => name === values.from);
  if (start < 0) throw new Error(`Unknown production stage: ${values.from}`);
  for (const [, run] of stages.slice(start)) await run();
  for (const id of ['car-body', 'roof-panel', 'window-frame-1', 'front-intake', 'wheel-1-front']) {
    await author.save(`${id}-inspection.json`, await author.inspect(id, 'face', 'evaluated'));
  }
  await author.refresh();
  await author.save('project.json', author.project);
  if (!values['skip-export']) {
    for (const view of views) await author.preview(`${view.id}.png`, `shot-${view.id}`, 3);
    await author.exportGlb();
    await author.exportVideo('vehicle', 24);
    await author.exportPackage();
    await author.reviewVideo();
  }
  await author.save('production-report.json', {
    projectId: author.project.id,
    revision: author.project.revision,
    directory: author.directory,
    objects: author.project.objects.length,
    duration: 24,
    method: 'Public MCP from empty project, retained surfaces and modifiers, source topology edits',
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
