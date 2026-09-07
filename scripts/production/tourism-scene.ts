import type { Command, Vec3 } from '../../shared/types';
import type { MeshData } from '../../shared/modeling';
import { CatmullRomCurve3, Vector3 } from 'three';

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
export function elevation(x: number, z: number) {
  const rise = smooth((z - 340) / 1150) * 132;
  const edge = smooth((Math.abs(x) - 180) / 170);
  const ridges =
    smooth((z - 280) / 300) *
    edge *
    (65 + 75 * Math.sin(x / 155 + z / 240) ** 2 + 40 * Math.cos(z / 135) ** 2);
  const shore = z < -20 ? -Math.min(40, (-z - 20) / 4) : 0;
  const coast = smooth((1000 - Math.hypot(x / 0.95, (z - 800) / 1.8)) / 300);
  return (rise + ridges + shore + 40) * coast - 40;
}
export const monastery: Vec3 = [160, elevation(160, 820) + 8, 820];
export const observatory: Vec3 = [-140, elevation(-140, 1510) + 8, 1510];
export const create = (payload: Record<string, unknown>): Command => ({ type: 'object.create', payload });
function domeMesh(radius: number): MeshData {
  const segments = 48;
  const rings = 16;
  const vertices: Vec3[] = [[0, radius, 0]];
  const faces: number[][] = [];
  for (let ring = 1; ring <= rings; ring++) {
    const latitude = ((ring / rings) * Math.PI) / 2;
    for (let segment = 0; segment < segments; segment++) {
      const longitude = (segment / segments) * Math.PI * 2;
      vertices.push([
        Math.sin(latitude) * Math.cos(longitude) * radius,
        Math.cos(latitude) * radius,
        Math.sin(latitude) * Math.sin(longitude) * radius,
      ]);
    }
  }
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    faces.push([0, 1 + next, 1 + segment]);
    for (let ring = 0; ring < rings - 1; ring++) {
      const a = 1 + ring * segments;
      const b = a + segments;
      faces.push([a + segment, a + next, b + next, b + segment]);
    }
  }
  faces.push(Array.from({ length: segments }, (_, segment) => 1 + (rings - 1) * segments + segment));
  return { kind: 'mesh', vertices, faces, smooth: true };
}
const object = (id: string, name: string, type: string, position: Vec3, dimensions: Vec3, tone = '#e1e4df') =>
  create({ id, name, type, position, dimensions, tone });

function roadOverTerrain(points: Vec3[]): Vec3[] {
  const curve = new CatmullRomCurve3(
    points.map((point) => new Vector3(...point)),
    false,
    'centripetal',
  );
  return Array.from({ length: 65 }, (_, index) => {
    const point = curve.getPoint(index / 64);
    const margin = 1.4 * smooth(index / 4) * smooth((64 - index) / 4);
    point.y = Math.max(point.y, elevation(point.x, point.z) + margin);
    return point.toArray() as Vec3;
  });
}

function roof(id: string, position: Vec3, width: number, depth: number, height: number): Command {
  return create({
    id,
    name: '折线屋顶',
    type: 'box',
    position,
    tone: '#a6b1ab',
    modeling: {
      kind: 'mesh',
      smooth: false,
      vertices: [
        [-width / 2, 0, -depth / 2],
        [width / 2, 0, -depth / 2],
        [width / 2, 0, depth / 2],
        [-width / 2, 0, depth / 2],
        [0, height, -depth / 2],
        [0, height, depth / 2],
      ],
      faces: [
        [0, 3, 2, 1],
        [0, 1, 4],
        [3, 5, 2],
        [0, 4, 5, 3],
        [1, 2, 5, 4],
      ],
    },
  });
}

export function lodgeTemplate(): Command[] {
  return [
    object('lodge-wall', '石屋主体', 'box', [0, 0, 0], [14, 9, 12]),
    roof('lodge-roof', [0, 9, 0], 16, 14, 5),
    object('lodge-door', '石屋门洞', 'box', [0, 0.1, -6.05], [2.5, 5.4, 0.15], '#66736c'),
    object('lodge-window-left', '左窗', 'box', [-4.5, 4.4, -6.05], [2.3, 2.8, 0.18], '#738077'),
    object('lodge-window-right', '右窗', 'box', [4.5, 4.4, -6.05], [2.3, 2.8, 0.18], '#738077'),
    object('lodge-chimney', '烟囱', 'box', [4, 9, 2], [1.8, 5.5, 1.8], '#c6ccc4'),
  ];
}

export function tourismScene(): Command[] {
  const segmentsX = 100;
  const segmentsZ = 160;
  const commands: Command[] = [
    create({
      id: 'coastal-terrain',
      name: '海岸至山脊连续地形',
      type: 'box',
      position: [0, 0, 800],
      tone: '#cbd1c8',
      modeling: {
        kind: 'terrain',
        sizeX: 2800,
        sizeZ: 4000,
        segmentsX,
        segmentsZ,
        thickness: 5,
        heights: Array.from({ length: (segmentsX + 1) * (segmentsZ + 1) }, (_, index) =>
          elevation(
            ((index % (segmentsX + 1)) / segmentsX) * 2800 - 1400,
            (Math.floor(index / (segmentsX + 1)) / segmentsZ) * 4000 - 1200,
          ),
        ),
      },
    }),
    object('bay-water', '海湾水面白模', 'plane', [0, -0.7, 0], [24000, 0.25, 24000], '#99acaf'),
    object('harbor-quay', '港口栈道', 'box', [0, 0, -5], [110, 1.2, 32], '#dfe3dc'),
    object('harbor-pier', '入港长堤', 'box', [0, 0, -62], [11, 1.2, 96]),
    object('town-road', '老城主街', 'plane', [0, 0.12, 152], [14, 0.1, 280], '#a5b0a7'),
    object('arch-gate', '临海石门', 'box', [0, 0, 80], [28, 18, 4]),
    create({
      id: 'gate-round-cut',
      name: '拱门圆弧刀具',
      type: 'cylinder',
      position: [0, 8, 77],
      rotation: [90, 0, 0],
      dimensions: [12, 6, 12],
    }),
    object('gate-square-cut', '拱门下部刀具', 'box', [0, -0.1, 80], [12, 8.2, 6]),
    {
      type: 'mesh.boolean',
      payload: { id: 'arch-gate', operandId: 'gate-round-cut', operation: 'subtract', keepOperand: false },
    },
    {
      type: 'mesh.boolean',
      payload: { id: 'arch-gate', operandId: 'gate-square-cut', operation: 'subtract', keepOperand: false },
    },
    object('gate-crown', '城门压顶', 'box', [0, 18, 80], [30, 1.4, 5], '#bbc4bb'),
    object('town-plaza', '山海广场', 'cylinder', [0, 0.12, 270], [90, 0.25, 90], '#dfe3db'),
    object('fountain-base', '环形水台', 'cylinder', [0, 0.4, 270], [27, 1.4, 27], '#bac6bf'),
    object('fountain-water', '水台内池', 'cylinder', [0, 1.82, 270], [22, 0.1, 22], '#93a7aa'),
    object('landmark-plinth', '风帆雕塑台座', 'cylinder', [0, 1.95, 270], [6, 2, 6]),
    create({
      id: 'sail-landmark',
      name: '山海风帆雕塑',
      type: 'box',
      position: [0, 3.95, 270],
      tone: '#edf0e9',
      modeling: {
        kind: 'mesh',
        smooth: false,
        vertices: [
          [-3, 0, -1],
          [4, 0, -1],
          [1, 25, -1],
          [-3, 0, 1],
          [4, 0, 1],
          [1, 25, 1],
        ],
        faces: [
          [0, 2, 1],
          [3, 4, 5],
          [0, 1, 4, 3],
          [1, 2, 5, 4],
          [2, 0, 3, 5],
        ],
      },
    }),
  ];
  for (let index = 0; index < 9; index++) {
    const z = 118 + index * 11;
    for (const side of [-1, 1]) {
      commands.push(
        object(`arcade-column-${index}-${side}`, '拱廊立柱', 'cylinder', [side * 10, 0, z], [1.2, 7.5, 1.2]),
      );
      commands.push(
        object(
          `arcade-capital-${index}-${side}`,
          '柱头',
          'box',
          [side * 10, 7.2, z],
          [2.2, 0.6, 2.2],
          '#bcc6bd',
        ),
      );
    }
  }
  commands.push(object('arcade-left-beam', '西侧柱廊顶梁', 'box', [-10, 7.7, 162], [2, 0.9, 96]));
  commands.push(object('arcade-right-beam', '东侧柱廊顶梁', 'box', [10, 7.7, 162], [2, 0.9, 96]));
  for (let index = 0; index < 12; index++) {
    const angle = (index / 12) * Math.PI * 2;
    const x = Math.sin(angle) * 36;
    const z = 270 + Math.cos(angle) * 36;
    commands.push(object(`plaza-seat-${index}`, '广场石凳', 'box', [x, 0.4, z], [4, 0.9, 1.8], '#b7c0b5'));
  }
  for (const [index, [x, z]] of [
    [-48, 38],
    [48, 38],
    [-53, 145],
    [53, 145],
    [-48, 230],
    [48, 230],
    [-43, 320],
    [43, 320],
  ].entries()) {
    commands.push(
      object(`tree-trunk-${index}`, '景观树树干', 'cylinder', [x, 0, z], [0.9, 5, 0.9], '#a7b2a7'),
    );
    commands.push(object(`tree-crown-${index}`, '景观树体块', 'sphere', [x, 4, z], [10, 9, 10], '#b0beb0'));
  }
  const trail: Vec3[] = [
    [0, 0.32, 314],
    [0, 0.5, 370],
    [-25, 4, 435],
    [-60, 9, 505],
    [0, elevation(0, 610) + 0.4, 610],
    [115, elevation(115, 700) + 0.4, 700],
    [160, monastery[1], 775],
    [160, monastery[1], 820],
  ];
  commands.push(
    create({
      id: 'mountain-road',
      name: '山寺上行道路',
      type: 'box',
      tone: '#abb7ad',
      modeling: {
        kind: 'curve',
        profile: 'road',
        points: roadOverTerrain(trail),
        segments: 420,
        width: 9,
        thickness: 2,
      },
    }),
  );
  for (const [index, point] of trail.slice(2, -1).entries()) {
    commands.push(
      object(`trail-marker-${index}`, '山路石标', 'box', [point[0] - 7, point[1], point[2]], [1.2, 4, 1.2]),
    );
  }
  const [mx, my, mz] = monastery;
  commands.push(
    object('monastery-foundation', '山寺台地', 'box', [mx, my - 8, mz], [112, 8, 108], '#b5c0b3'),
  );
  commands.push(object('monastery-main', '山寺主殿', 'box', [mx, my, mz + 13], [36, 14, 26]));
  commands.push(roof('monastery-roof', [mx, my + 14, mz + 13], 42, 32, 11));
  commands.push(object('monastery-door', '主殿门洞', 'box', [mx, my, mz - 0.08], [6, 10, 0.15], '#778679'));
  for (const side of [-1, 1]) {
    commands.push(
      object(`monastery-hall-${side}`, '山寺侧殿', 'box', [mx + side * 35, my, mz + 8], [15, 8, 34]),
    );
    commands.push(roof(`monastery-hall-roof-${side}`, [mx + side * 35, my + 8, mz + 8], 19, 38, 5));
  }
  for (let index = 0; index < 9; index++) {
    commands.push(
      object(
        `monastery-stair-${index}`,
        '山寺台阶',
        'box',
        [mx, my - 4.5 + index * 0.5, mz - 47 + index * 1.5],
        [24, 0.5, 24 - index * 1.5],
        '#e6e9e2',
      ),
    );
  }
  for (let index = 0; index < 14; index++) {
    const x = mx - 49 + index * 7.5;
    commands.push(object(`terrace-post-${index}`, '观景台栏柱', 'box', [x, my, mz - 53], [0.6, 2, 0.6]));
  }
  commands.push(object('terrace-rail', '观景台横栏', 'box', [mx, my + 1.5, mz - 53], [106, 0.35, 0.45]));
  const [ox, oy, oz] = observatory;
  commands.push(
    object(
      'observatory-foundation',
      '天文台山顶平台',
      'cylinder',
      [ox, oy - 8, oz],
      [110, 8, 110],
      '#b2bfaf',
    ),
  );
  commands.push(object('observatory-base', '天文台环楼', 'cylinder', [ox, oy, oz], [55, 14, 55]));
  commands.push(
    create({
      id: 'observatory-dome',
      name: '天文台穹顶',
      type: 'box',
      position: [ox, oy + 14, oz],
      dimensions: [56, 28, 56],
      tone: '#d3dcd3',
      modeling: domeMesh(28),
    }),
  );
  commands.push(
    object('observatory-slit', '穹顶观测暗室', 'box', [ox, oy + 14.1, oz - 4], [3.5, 24, 1.1], '#647669'),
  );
  commands.push(
    object('observatory-slit-cutter', '穹顶观测缝刀具', 'box', [ox, oy + 13.5, oz - 21], [4, 32, 40]),
  );
  commands.push({
    type: 'mesh.boolean',
    payload: {
      id: 'observatory-dome',
      operandId: 'observatory-slit-cutter',
      operation: 'subtract',
      keepOperand: false,
    },
  });
  for (let index = 0; index < 18; index++) {
    const angle = (index / 18) * Math.PI * 2;
    commands.push(
      create({
        id: `observatory-rib-${index}`,
        name: '环楼竖向窗带',
        type: 'box',
        position: [ox + Math.sin(angle) * 27.55, oy + 4, oz + Math.cos(angle) * 27.55],
        rotation: [0, (angle * 180) / Math.PI, 0],
        dimensions: [2.4, 6, 0.2],
        tone: '#7c8b7e',
      }),
    );
  }
  commands.push(
    object('observatory-steps', '天文台引道', 'box', [ox, oy, oz - 65], [18, 0.4, 42], '#e4e9e1'),
  );
  const ridgeTrail: Vec3[] = [
    [mx, my, mz + 55],
    [190, elevation(190, 940) + 0.4, 940],
    [80, elevation(80, 1090) + 0.4, 1090],
    [-50, elevation(-50, 1260) + 0.4, 1260],
    [ox, oy, oz - 85],
    [ox, oy, oz - 55],
  ];
  commands.push(
    create({
      id: 'ridge-road',
      name: '山脊观星步道',
      type: 'box',
      tone: '#aebbac',
      modeling: {
        kind: 'curve',
        profile: 'road',
        points: roadOverTerrain(ridgeTrail),
        segments: 480,
        width: 7,
        thickness: 2,
      },
    }),
  );
  for (let index = 0; index < 14; index++) {
    const x = (index % 2 ? -1 : 1) * (330 + (index % 4) * 90);
    const z = 600 + index * 80;
    commands.push(
      object(
        `ridge-rock-${index}`,
        '山脊岩体',
        'sphere',
        [x, elevation(x, z) - 5, z],
        [60 + index * 3, 30 + (index % 4) * 12, 80],
        '#bdc8b9',
      ),
    );
  }
  return commands;
}
