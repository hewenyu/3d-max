import { parseArgs } from 'node:util';
import type { Project } from '../../shared/types';
import type { SurfaceProfile } from '../../shared/surfaces/schema';
import { ModelingAssetClient } from './client';
import {
  artifacts,
  cameras,
  create,
  digest,
  ellipse,
  modify,
  profile,
  settings,
  surface,
  type ShowcaseView,
} from './design';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://127.0.0.1:4223' },
    'skip-export': { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
  },
});
const author = new ModelingAssetClient('curved-prop', values.api);
const hollow = (radius: number, thickness: number): SurfaceProfile => ({
  ...ellipse(radius, radius),
  holes: [ellipse(radius - thickness, radius - thickness).outer],
});

async function vessel() {
  await author.commands(
    [
      create({ id: 'vessel', name: '内外轮廓旋转壶体', type: 'box', tone: '#e1e6df' }),
      surface('vessel', {
        operation: 'revolve',
        angle: 360,
        segments: 64,
        profileSegments: 4,
        caps: true,
        profile: {
          closed: false,
          points: [
            { position: [0, 0.15] },
            { position: [0.4, 0.15], outTangent: [0.22, 0] },
            { position: [0.87, 0.5], inTangent: [-0.12, -0.18], outTangent: [0.1, 0.2] },
            { position: [0.9, 1.05], inTangent: [0.06, -0.2], outTangent: [-0.06, 0.2] },
            { position: [0.54, 1.6], inTangent: [0.15, -0.13], outTangent: [-0.06, 0.025] },
            { position: [0.44, 1.64], inTangent: [0.04, -0.02] },
            { position: [0.38, 1.64] },
            { position: [0.49, 1.53], outTangent: [0.12, -0.12] },
            { position: [0.83, 1.03], inTangent: [-0.08, 0.22], outTangent: [0.06, -0.18] },
            { position: [0.81, 0.55], inTangent: [0.08, 0.18], outTangent: [-0.1, -0.15] },
            { position: [0.4, 0.23], inTangent: [0.2, 0] },
            { position: [0, 0.23] },
          ],
        },
      }),
      create({ id: 'foot', name: '阶梯旋转底座', type: 'box', tone: '#b5c1b4' }),
      surface('foot', {
        operation: 'revolve',
        segments: 48,
        profileSegments: 1,
        caps: true,
        profile: {
          closed: false,
          points: [
            [0, 0.035],
            [0.45, 0.035],
            [0.49, 0.075],
            [0.49, 0.12],
            [0.43, 0.16],
            [0, 0.16],
          ].map((position) => ({ position })),
        },
      }),
      create({ id: 'lid', name: '独立弧面壶盖', type: 'box', tone: '#d5dfd2' }),
      surface('lid', {
        operation: 'revolve',
        segments: 48,
        profileSegments: 4,
        caps: true,
        profile: {
          closed: false,
          points: [
            { position: [0, 1.68] },
            { position: [0.43, 1.68] },
            { position: [0.48, 1.71] },
            { position: [0.46, 1.75], outTangent: [-0.12, 0.1] },
            { position: [0.12, 1.86], inTangent: [0.12, 0] },
            { position: [0, 1.86] },
          ],
        },
      }),
      create({ id: 'lid-knob', name: '曲线旋转盖钮', type: 'box', tone: '#9dab9c' }),
      surface('lid-knob', {
        operation: 'revolve',
        segments: 40,
        profileSegments: 3,
        caps: true,
        profile: {
          closed: false,
          points: [
            { position: [0, 1.83] },
            { position: [0.08, 1.83] },
            { position: [0.085, 1.96], outTangent: [0.09, 0] },
            { position: [0.17, 2.03], inTangent: [0, -0.05], outTangent: [0, 0.06] },
            { position: [0.07, 2.11], inTangent: [0.09, 0] },
            { position: [0, 2.11] },
          ],
        },
      }),
    ],
    'revolved-hollow-vessel',
  );
}

async function handleAndSpout() {
  await author.commands(
    [
      create({ id: 'handle', name: '切线可编辑扫掠把手', type: 'box', tone: '#a6b6a4' }),
      surface('handle', {
        operation: 'sweep',
        segments: 12,
        profileSegments: 1,
        caps: true,
        profile: profile([
          [-0.07, -0.08],
          [0.07, -0.08],
          [0.085, -0.055],
          [0.085, 0.055],
          [0.07, 0.08],
          [-0.07, 0.08],
          [-0.085, 0.055],
          [-0.085, -0.055],
        ]),
        path: {
          closed: false,
          points: [
            { position: [0, 1.38, -0.55], outTangent: [0, 0.15, -0.25] },
            { position: [0, 1.55, -1.25], inTangent: [0, 0, 0.25], outTangent: [0, -0.2, -0.2] },
            { position: [0, 0.65, -1.49], inTangent: [0, 0.3, -0.05], outTangent: [0, -0.2, 0.08] },
            { position: [0, 0.42, -0.72], inTangent: [0, 0, -0.35] },
          ],
        },
      }),
      create({ id: 'spout', name: '四截面空心放样壶嘴', type: 'box', tone: '#e0e8dc' }),
      surface('spout', {
        operation: 'loft',
        segments: 5,
        profileSegments: 6,
        caps: true,
        sections: [
          { position: [0, 0.82, 0.66], rotation: [-35, 0, 0], profile: hollow(0.25, 0.055) },
          { position: [0, 1.0, 1.07], rotation: [-40, 0, 0], profile: hollow(0.23, 0.05) },
          { position: [0, 1.48, 1.44], rotation: [-53, 0, 0], profile: hollow(0.16, 0.04) },
          { position: [0, 1.73, 1.65], rotation: [-50, 0, 0], profile: hollow(0.13, 0.035) },
        ],
      }),
      create({
        id: 'spout-opening',
        name: '壶体出水孔保留操作数',
        type: 'cylinder',
        dimensions: [0.28, 0.7, 0.28],
        position: [0, 0.64, 0.37],
        rotation: [55, 0, 0],
        visible: false,
      }),
      modify('vessel', {
        id: 'vessel-pour-opening',
        type: 'boolean',
        operation: 'subtract',
        operandId: 'spout-opening',
      }),
    ],
    'swept-handle-and-lofted-spout',
  );
  for (const [index, y, z] of [
    [0, 1.3, -0.61],
    [1, 0.36, -0.74],
  ]) {
    const id = `handle-mount-${index}`;
    await author.commands(
      [
        create({
          id,
          name: `把手支座 ${index + 1}`,
          type: 'box',
          dimensions: [0.32, 0.19, 0.16],
          position: [0, y, z],
          tone: '#ced8c9',
        }),
        modify(id, { id: `${id}-bevel`, type: 'bevel', width: 0.035, segments: 3 }),
        create({
          id: `${id}-pin`,
          name: `支座轴销 ${index + 1}`,
          type: 'cylinder',
          dimensions: [0.085, 0.36, 0.085],
          position: [-0.18, y + 0.1, z - 0.045],
          rotation: [0, 0, -90],
          tone: '#92a58e',
        }),
      ],
      `handle-mount-${index}`,
    );
  }
}

async function topologyAndSourceProof() {
  await author.command('object_duplicate', {
    id: 'lid-knob',
    newId: 'inspection-knob',
    name: '盖钮拓扑转换检查件',
  });
  await author.command('object_update', {
    id: 'inspection-knob',
    patch: { position: [1.65, -1.83, 0.4], tone: '#b0bea8' },
  });
  await author.command('mesh_convert', { id: 'inspection-knob' });
  const vertices = await author.inspect('inspection-knob', 'vertex');
  const selected = vertices.elements
    .filter((item) => item.position && item.position[1] > 2.02)
    .map((item) => item.id);
  await author.command('topology_transform', {
    id: 'inspection-knob',
    selection: { namespace: vertices.namespace, kind: 'vertex', ids: selected },
    translation: [0, 0.045, 0],
    proportional: { radius: 0.1, falloff: 'smooth', connected: true },
  });
  await author.save('converted-topology-proof.json', await author.inspect('inspection-knob', 'face'));
  const before = structuredClone(author.project.objects);
  const original = author.project.objects.find((object) => object.id === 'handle')!.modeling;
  if (original?.kind !== 'surface' || original.operation !== 'sweep')
    throw new Error('Editable handle source missing');
  const changed = structuredClone(original);
  changed.path.points[1].outTangent = [0, -0.22, -0.16];
  const beforeGeometry = await author.inspect('handle', 'vertex', 'evaluated');
  await author.command('surface_set', { id: 'handle', surface: changed });
  const after = structuredClone(author.project.objects);
  const changedGeometry = await author.inspect('handle', 'vertex', 'evaluated');
  if (digest(beforeGeometry.elements) === digest(changedGeometry.elements))
    throw new Error('Bezier source edit did not change mesh');
  author.project = await author.call<Project>('history_undo', {
    projectId: author.project.id,
    expectedRevision: author.project.revision,
  });
  if (digest(author.project.objects) !== digest(before)) throw new Error('Source undo mismatch');
  author.project = await author.call<Project>('history_redo', {
    projectId: author.project.id,
    expectedRevision: author.project.revision,
  });
  if (digest(author.project.objects) !== digest(after)) throw new Error('Source redo mismatch');
  await author.save('edit-undo-redo.json', {
    before: digest(before),
    after: digest(after),
    beforeGeometry: digest(beforeGeometry.elements),
    afterGeometry: digest(changedGeometry.elements),
    restored: true,
  });
}

const views: ShowcaseView[] = [
  {
    name: '壶体轮廓与三种曲面',
    from: [4.7, 3.1, 5.0],
    to: [5.5, 2.7, 3.4],
    target: [0, 1.0, 0],
    fov: 42,
    subjects: ['vessel', 'handle', 'spout'],
  },
  {
    name: '空心壶嘴与盖钮',
    from: [2.5, 2.9, 3.8],
    to: [1.5, 3.2, 3.8],
    target: [0, 1.4, 0.85],
    fov: 35,
    subjects: ['spout', 'lid', 'lid-knob'],
  },
  {
    name: '扫掠把手与机械支座',
    from: [3.5, 2.2, -4.8],
    to: [2.6, 1.8, -4.7],
    target: [0, 1.0, -0.65],
    fov: 40,
    subjects: ['handle', 'handle-mount-0', 'handle-mount-1'],
  },
  {
    name: '旋转底座与拓扑检查件',
    from: [4.2, 1.4, 2.5],
    to: [4.3, 1.7, 0.7],
    target: [0.6, 0.65, 0.2],
    fov: 42,
    subjects: ['foot', 'inspection-knob', 'vessel'],
  },
];
try {
  await author.connect();
  if (values.resume) author.project = await author.call<Project>('project_get');
  else {
    await author.create('高级白模 / 曲面工艺壶');
    await author.save('modeling-checklist.json', {
      revolve: ['hollow vessel with inner bottom', 'stepped foot', 'curved lid and knob'],
      sweep: ['eight-point handle section', 'editable Bezier handles'],
      loft: ['four oriented holed spout sections'],
      topology: ['converted knob with connected proportional edit'],
      dependencies: ['retained pour opening operand'],
    });
    await settings(author, '工艺壶 / 曲面造型检查台');
    await vessel();
    await handleAndSpout();
  }
  if (!author.project.objects.some((object) => object.id === 'inspection-knob'))
    await topologyAndSourceProof();
  if (!author.project.shots.some((shot) => shot.id === 'inspection-shot-0')) await cameras(author, views);
  await author.commands(
    [
      { type: 'object.update', payload: { id: 'inspection-knob', patch: { position: [1.65, -1.83, 0.4] } } },
      { type: 'object.update', payload: { id: 'lid', patch: { position: [0, -0.03, 0] } } },
      {
        type: 'object.update',
        payload: {
          id: 'spout-opening',
          patch: { dimensions: [0.28, 0.7, 0.28], position: [0, 0.64, 0.37], rotation: [55, 0, 0] },
        },
      },
    ],
    'curved-prop-assembly-review',
  );
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
