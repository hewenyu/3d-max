import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CatmullRomCurve3, Vector3 } from 'three';
import type { Command, Project, RenderJob, SequenceClip, Vec3 } from '../../shared/types';
import type { TemplateContent } from '../../shared/templates';
import { ProductionMcp, camera } from './production-mcp';
import { lodgeTemplate, tourismScene, monastery, observatory, elevation } from './tourism-scene';

const film = new ProductionMcp('tourism', process.env.WHITEFRAME_PRODUCTION_API ?? 'http://127.0.0.1:4202');
interface TravelShot {
  name: string;
  duration: number;
  position: Vec3[];
  target: Vec3[];
  fov: number;
  intent: string;
  subjects: string[];
}
const [mx, my, mz] = monastery;
const [ox, oy, oz] = observatory;
const specs: TravelShot[] = [
  {
    name: '01 / 山海抵达',
    duration: 10,
    position: [
      [-200, 95, -160],
      [-160, 80, -100],
      [-110, 65, -35],
    ],
    target: [
      [0, 12, 100],
      [0, 14, 150],
      [0, 18, 190],
    ],
    fov: 48,
    subjects: ['arch-gate'],
    intent: '航拍交代港口、老城与远山的完整空间关系，以向内陆的运动开启游览。',
  },
  {
    name: '02 / 海堤入城',
    duration: 10,
    position: [
      [0, 3, -100],
      [0, 3.4, -48],
      [0, 4, 35],
    ],
    target: [
      [0, 7, 80],
      [0, 9, 80],
      [0, 10, 95],
    ],
    fov: 52,
    subjects: ['arch-gate'],
    intent: '由海堤低位持续推进，城门由远景变为主体，保持游览方向。',
  },
  {
    name: '03 / 穿门步行',
    duration: 10,
    position: [
      [0, 2.2, 46],
      [0, 2.2, 83],
      [0, 2.2, 112],
    ],
    target: [
      [0, 4, 130],
      [0, 4, 170],
      [0, 4, 220],
    ],
    fov: 58,
    subjects: ['arcade-left-beam', 'arcade-right-beam'],
    intent: '以人眼高度真实穿过布尔建模的石拱门，由前景遮挡揭示柱廊。',
  },
  {
    name: '04 / 柱廊日影',
    duration: 10,
    position: [
      [-5, 2.5, 125],
      [-5, 2.5, 163],
      [-5, 3.1, 198],
    ],
    target: [
      [13, 4, 148],
      [13, 4, 182],
      [3, 6, 257],
    ],
    fov: 48,
    subjects: ['arcade-right-beam'],
    intent: '地面侧向行进，用前后柱列的视差展示可复用建筑组装关系。',
  },
  {
    name: '05 / 广场风帆',
    duration: 10,
    position: [
      [-39, 14, 239],
      [-45, 17, 276],
      [-22, 19, 311],
    ],
    target: [
      [0, 16, 270],
      [0, 16, 270],
      [0, 16, 270],
    ],
    fov: 45,
    subjects: ['sail-landmark'],
    intent: '绕行雕塑广场，从街巷节奏转入开阔停留，地标形态在持续环绕中展开。',
  },
  {
    name: '06 / 石作细节',
    duration: 8,
    position: [
      [6, 8, 259],
      [8, 11, 262],
      [8, 16, 267],
    ],
    target: [
      [0, 11, 270],
      [0, 15, 270],
      [1, 20, 270],
    ],
    fov: 38,
    subjects: ['sail-landmark'],
    intent: '局部仰视升镜，展示风帆的折面与厚度，背景老城保持可读。',
  },
  {
    name: '07 / 沿路上山',
    duration: 14,
    position: [
      [-50, 55, 340],
      [-95, 70, 450],
      [-25, 95, 630],
      [95, my + 65, 737],
    ],
    target: [
      [0, 5, 420],
      [-15, 17, 565],
      [130, my - 5, 720],
      [mx, my + 8, mz],
    ],
    fov: 52,
    subjects: ['mountain-road'],
    intent: '长距离航拍沿道路逐步上行，老城过渡至山寺，不重复先前游览段落。',
  },
  {
    name: '08 / 山寺迎面',
    duration: 12,
    position: [
      [mx - 20, my + 6, mz - 90],
      [mx - 8, my + 5, mz - 55],
      [mx, my + 3.5, mz - 23],
    ],
    target: [
      [mx, my + 12, mz + 13],
      [mx, my + 12, mz + 13],
      [mx, my + 12, mz + 13],
    ],
    fov: 50,
    subjects: ['monastery-main'],
    intent: '切至山寺前的接近镜头，轴向推进形成抵达感并读取台阶、殿门和屋顶。',
  },
  {
    name: '09 / 露台山海',
    duration: 10,
    position: [
      [mx + 45, my + 9, mz - 36],
      [mx + 16, my + 12, mz - 43],
      [mx - 30, my + 15, mz - 40],
    ],
    target: [
      [0, 15, 240],
      [-20, 10, 160],
      [-30, 5, 80],
    ],
    fov: 50,
    subjects: ['town-plaza'],
    intent: '从露台回望刚走过的老城与海湾，用栏杆前景证实远近空间及遮挡关系。',
  },
  {
    name: '10 / 山脊观星路',
    duration: 10,
    position: [
      [180, elevation(180, 980) + 80, 980],
      [30, elevation(30, 1190) + 85, 1190],
      [-130, oy + 55, 1375],
    ],
    target: [
      [50, elevation(50, 1150), 1150],
      [-110, oy, 1390],
      [ox, oy + 14, oz],
    ],
    fov: 52,
    subjects: ['ridge-road'],
    intent: '沿高山步道继续前往天文台，起伏地形和折返道路形成第二段空间推进。',
  },
  {
    name: '11 / 穹顶近观',
    duration: 10,
    position: [
      [ox - 44, oy + 14, oz - 30],
      [ox - 30, oy + 22, oz - 43],
      [ox + 2, oy + 29, oz - 49],
    ],
    target: [
      [ox, oy + 19, oz],
      [ox, oy + 22, oz],
      [ox, oy + 25, oz],
    ],
    fov: 45,
    subjects: ['observatory-dome'],
    intent: '贴近环绕天文台穹顶，展示曲面体量、窗带和观测缝，形成细节高潮。',
  },
  {
    name: '12 / 山海全景',
    duration: 14,
    position: [
      [ox + 75, oy + 68, oz + 75],
      [ox + 175, oy + 145, oz + 200],
      [ox + 350, oy + 265, oz + 370],
    ],
    target: [
      [ox, oy + 10, oz],
      [30, 55, 830],
      [0, 25, 580],
    ],
    fov: 48,
    subjects: ['observatory-base', 'monastery-main'],
    intent: '持续升高后拉，将天文台、山寺、老城和海湾收束为完整游览版图。',
  },
];

try {
  await film.connect();
  const refining = process.argv.includes('--refine');
  let savedTemplateId: string | undefined;
  if (refining) {
    film.project = await film.call<Project>('project_get');
    const ids = [
      'coastal-terrain',
      'bay-water',
      'mountain-road',
      'ridge-road',
      'observatory-dome',
      'observatory-slit',
      'observatory-slit-cutter',
    ];
    const revisions: Command[] = tourismScene()
      .filter(
        (command) =>
          (command.type === 'object.create' && ids.includes(command.payload.id as string)) ||
          (command.type === 'mesh.boolean' && command.payload.id === 'observatory-dome'),
      )
      .map((command) => {
        if (
          command.type !== 'object.create' ||
          !film.project.objects.some((object) => object.id === command.payload.id)
        )
          return command;
        const { id, type: _type, ...patch } = command.payload;
        return { type: 'object.update', payload: { id, patch } };
      });
    await film.edit(revisions);
  } else {
    await film.create('白模旅拍 / 山海慢行');
    await film.edit([
      { type: 'project.update', payload: { sceneName: '山海步道 · 日外' } },
      {
        type: 'project.settings',
        payload: {
          fps: 24,
          aspect: '16:9',
          resolution: 720,
          lighting: { intensity: 2.1, ambient: 0.72, azimuth: 130, elevation: 38 },
          environment: { ground: false, background: '#c9d5d4', groundTone: '#cbd1c8' },
        },
      },
      ...tourismScene(),
      ...lodgeTemplate(),
    ]);
    const saved = await film.call<{ id: string }>('template_save', {
      projectId: film.project.id,
      expectedRevision: film.project.revision,
      requestId: randomUUID(),
      kind: 'objects',
      name: '山海石屋',
      description: '可独立编辑的石屋、屋顶、门窗及烟囱组件',
      objectIds: [
        'lodge-wall',
        'lodge-roof',
        'lodge-door',
        'lodge-window-left',
        'lodge-window-right',
        'lodge-chimney',
      ],
    });
    savedTemplateId = saved.id;
    const template = await film.call<{ content: TemplateContent }>('template_get', { id: saved.id });
    for (const id of template.content.project.objects.map((object) => object.id))
      await film.edit([{ type: 'object.delete', payload: { id } }]);
    for (const [index, spec] of [
      [-27, 0, 110, 90],
      [27, 0, 112, -90],
      [-29, 0, 155, 90],
      [30, 0, 158, -90],
      [-29, 0, 200, 90],
      [31, 0, 205, -90],
      [-41, 0, 280, 90],
      [41, 0, 279, -90],
      [mx - 39, my, mz - 27, 0],
      [mx + 39, my, mz - 27, 0],
    ].entries()) {
      const result = await film.command('template_instantiate', {
        template: template.content,
        name: `石屋 ${index + 1}`,
      });
      const groupId = (result.results[0] as { groupId: string }).groupId;
      await film.edit([
        {
          type: 'object.update',
          payload: {
            id: groupId,
            patch: {
              position: spec.slice(0, 3),
              rotation: [0, spec[3], 0],
            },
          },
        },
      ]);
    }
  }
  const clips: SequenceClip[] = [];
  let start = 0;
  for (const [index, spec] of specs.entries()) {
    const cameraId = `travel-camera-${index + 1}`;
    const shotId = `travel-shot-${index + 1}`;
    const position = new CatmullRomCurve3(
      spec.position.map((point) => new Vector3(...point)),
      false,
      'centripetal',
    );
    const target = new CatmullRomCurve3(
      spec.target.map((point) => new Vector3(...point)),
      false,
      'centripetal',
    );
    const keyframes = Array.from({ length: spec.duration * 24 + 1 }, (_, frame) => {
      const t = frame / (spec.duration * 24);
      return {
        id: `travel-key-${index}-${frame}`,
        time: start + frame / 24,
        position: position.getPoint(t).toArray() as Vec3,
        target: target.getPoint(t).toArray() as Vec3,
        fov: spec.fov,
        easing: 'linear',
      };
    });
    const commands: Command[] = [
      {
        type: 'camera.create',
        payload: { ...camera(cameraId, spec.name, spec.position[0], spec.target[0], spec.fov), keyframes },
      },
      {
        type: 'shot.create',
        payload: {
          id: shotId,
          name: spec.name,
          cameraId,
          sourceIn: start,
          sourceOut: start + spec.duration,
          subjectIds: spec.subjects,
          intent: spec.intent,
        },
      },
      {
        type: 'beat.create',
        payload: {
          id: `travel-beat-${index + 1}`,
          label: spec.name,
          time: start,
          endTime: start + spec.duration,
          kind: 'action',
          text: '',
          notes: spec.intent,
        },
      },
    ];
    await film.edit(
      refining ? [{ type: 'camera.update', payload: { id: cameraId, patch: { keyframes } } }] : commands,
    );
    clips.push({ id: `travel-clip-${index + 1}`, shotId, sourceIn: start, sourceOut: start + spec.duration });
    start += spec.duration;
  }
  await film.edit([
    {
      type: 'sequence.update',
      payload: { id: film.project.activeSequenceId, patch: { name: '山海慢行 / 导演剪辑', clips } },
    },
  ]);
  if (!refining) {
    const audioFile = resolve(film.directory, 'travel-ambience.m4a');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `aevalsrc=0.055*sin(2*PI*130.8128*t)*(0.7+0.3*sin(t/7))+0.035*sin(2*PI*164.8138*t)+0.025*sin(2*PI*195.9977*t)*(0.6+0.4*sin(t/11)):s=24000:d=${start}`,
      '-af',
      `afade=t=in:d=3,afade=t=out:st=${start - 5}:d=5`,
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-y',
      audioFile,
    ]);
    const audio = await film.call<{ url: string }>('asset_import', {
      name: 'travel-ambience.m4a',
      dataBase64: (await readFile(audioFile)).toString('base64'),
    });
    await film.edit([
      {
        type: 'audio.create',
        payload: {
          id: 'travel-audio',
          name: '山海环境参考音',
          url: audio.url,
          start: 0,
          sourceIn: 0,
          duration: start,
          volume: 0.6,
          sync: 'sequence',
        },
      },
      { type: 'production.initialize', payload: {} },
    ]);
    await film.edit([
      {
        type: 'storyScene.create',
        payload: {
          id: 'travel-story',
          name: '山海慢行',
          sceneId: film.project.production!.activeSceneId,
          performanceId: film.project.production!.activePerformanceId,
          location: '海湾、老城、山寺、天文台',
          timeOfDay: '日外',
          description: '从海湾抵达，经老城与山寺到天文台的完整连续游览。',
        },
      },
    ]);
  }
  await film.save({
    narrative: specs,
    reusedTemplateId: savedTemplateId,
    review: 'All 12 shot midpoint previews pending; 128-second export pending.',
  });
  for (const [index, clip] of clips.entries())
    await film.preview((clip.sourceIn + clip.sourceOut) / 2, `shot-${String(index + 1).padStart(2, '0')}`);
  if (process.argv.includes('--export')) {
    const job = await film.call<RenderJob>('render_start', {
      projectId: film.project.id,
      expectedRevision: film.project.revision,
      requestId: randomUUID(),
      resolution: 720,
      fps: 24,
      aspect: '16:9',
      includeAudio: true,
      burnIn: false,
    });
    await writeFile(resolve(film.directory, 'render-job.json'), JSON.stringify(job, null, 2));
    console.log(JSON.stringify({ renderId: job.id, status: job.status }));
  }
} finally {
  await film.close();
}
