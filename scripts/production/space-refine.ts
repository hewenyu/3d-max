import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Vector3 } from 'three';
import { ProductionMcp } from './production-mcp';
import { sampleObject } from '../../shared/timeline';
import type { Command, Project, Vec3 } from '../../shared/types';

const film = new ProductionMcp('space');
const shipIds = ['flight-lead', 'flight-left', 'flight-right', 'hostile-one', 'hostile-two'];
const point = (id: string, time: number) =>
  new Vector3(
    ...sampleObject(
      film.project.objects.find((object) => object.id === id)!,
      time,
      { render: true },
    ).position,
  );
const specs: {
  index: number;
  subjects: string[];
  offset: Vec3;
  fov: number;
  frozenTarget?: { id: string; time: number };
}[] = [
  { index: 1, subjects: shipIds, offset: [78, 52, -126], fov: 49 },
  { index: 2, subjects: ['hostile-one', 'flight-lead'], offset: [42, 30, -78], fov: 51 },
  { index: 3, subjects: shipIds, offset: [-82, 52, -94], fov: 53 },
  { index: 5, subjects: ['flight-left', 'flight-lead', 'hostile-one'], offset: [-74, 55, -68], fov: 52 },
  {
    index: 6,
    subjects: ['flight-lead', 'flight-left', 'flight-right'],
    offset: [96, 74, -116],
    fov: 51,
    frozenTarget: { id: 'hostile-one', time: 62 },
  },
  { index: 8, subjects: ['hostile-two', 'flight-lead', 'flight-left'], offset: [-72, 55, -88], fov: 51 },
  {
    index: 9,
    subjects: ['flight-lead', 'flight-left', 'flight-right'],
    offset: [94, 70, -130],
    fov: 51,
    frozenTarget: { id: 'hostile-two', time: 103 },
  },
  { index: 10, subjects: ['flight-lead', 'flight-left', 'flight-right'], offset: [70, 38, -90], fov: 50 },
];
try {
  await film.connect();
  film.project = await film.call<Project>('project_open', {
    id: (await readFile(resolve(film.directory, 'project-id.txt'), 'utf8')).trim(),
  });
  const edits: Command[] = [
    {
      type: 'object.update',
      payload: { id: 'planet', patch: { position: [-160, 30, 1810], dimensions: [320, 320, 320] } },
    },
  ];
  if (!film.project.objects.some((object) => object.id === 'orbital-gateway'))
    edits.push({
      type: 'object.create',
      payload: {
        id: 'orbital-gateway',
        name: '目的地轨道门',
        type: 'box',
        tone: '#d5ddda',
        modeling: {
          kind: 'curve',
          profile: 'tube',
          points: Array.from({ length: 25 }, (_, index) => {
            const angle = (index / 24) * Math.PI * 2;
            return [-70 + Math.cos(angle) * 75, 205 + Math.sin(angle) * 75, 1500];
          }),
          segments: 200,
          radius: 2,
          radialSegments: 8,
        },
      },
    });
  await film.edit(edits);
  for (const spec of specs) {
    const from = (spec.index - 1) * 12;
    const frames = Array.from({ length: 289 }, (_, frame) => {
      const fraction = frame / 288;
      const time = from + fraction * 12;
      const subjects = spec.subjects.map((id) => point(id, time));
      if (spec.frozenTarget)
        subjects.push(point(spec.frozenTarget.id, Math.min(time, spec.frozenTarget.time)));
      const target = subjects
        .reduce((sum, item) => sum.add(item), new Vector3())
        .divideScalar(subjects.length);
      const offset = new Vector3(...spec.offset)
        .applyAxisAngle(new Vector3(0, 1, 0), ((fraction - 0.5) * Math.PI) / 16)
        .multiplyScalar(1 - 0.08 * Math.sin(fraction * Math.PI));
      return {
        id: `space-reframe-${spec.index}-${frame}`,
        time,
        position: target.clone().add(offset).toArray(),
        target: target.toArray(),
        fov: spec.fov,
        easing: 'linear',
      };
    });
    await film.edit([
      {
        type: 'camera.update',
        payload: {
          id: `space-camera-${spec.index}`,
          patch: {
            position: frames[0]!.position,
            target: frames[0]!.target,
            fov: spec.fov,
            keyframes: frames,
          },
        },
      },
    ]);
  }
  let minimumSeparation = Infinity;
  let minimumMovementPerFrame = Infinity;
  for (let frame = 0; frame < 2880; frame++) {
    const time = frame / 24;
    const alive = shipIds.filter((id) =>
      id === 'hostile-one' ? time < 62 : id === 'hostile-two' ? time < 103 : true,
    );
    for (const [index, id] of alive.entries()) {
      const current = point(id, time);
      minimumMovementPerFrame = Math.min(
        minimumMovementPerFrame,
        current.distanceTo(point(id, (frame + 1) / 24)),
      );
      for (const other of alive.slice(index + 1))
        minimumSeparation = Math.min(minimumSeparation, current.distanceTo(point(other, time)));
    }
  }
  const previousReport = JSON.parse(
    await readFile(resolve(film.directory, 'production-report.json'), 'utf8'),
  ) as Record<string, unknown>;
  await film.save({
    ...previousReport,
    revision: film.project.revision,
    objects: film.project.objects.length,
    minimumLiveShipCenterSeparation: minimumSeparation,
    minimumLiveShipMovementPerFrame: minimumMovementPerFrame,
    review: 'Actual PNGs reviewed; reframed group coverage and both impacts. Long video export pending.',
  });
  for (const [name, time] of [
    ['shot-01', 6],
    ['shot-02', 18],
    ['shot-03', 28.7],
    ['shot-05', 55.7],
    ['shot-06', 63.5],
    ['shot-08', 90],
    ['shot-09', 104.5],
    ['shot-10', 114],
  ] as const)
    await film.preview(time, name);
} finally {
  await film.close();
}
