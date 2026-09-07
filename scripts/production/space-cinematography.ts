import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Euler, Quaternion, Vector3 } from 'three';
import { ProductionMcp } from './production-mcp';
import { sampleObject } from '../../shared/timeline';
import type { Project, Vec3 } from '../../shared/types';

const film = new ProductionMcp('space', process.env.WHITEFRAME_PRODUCTION_API ?? 'http://127.0.0.1:4210');
const projectId = process.env.WHITEFRAME_SPACE_PROJECT ?? 'f6fea4fb-95eb-48ae-b8eb-60d2b1129c68';
const friends = ['flight-lead', 'flight-left', 'flight-right'];
const everyone = [...friends, 'hostile-one', 'hostile-two'];
const specifications: {
  index: number;
  subjects: string[];
  direction: Vec3;
  fov: number;
  arc: number;
  hold?: { id: string; time: number };
}[] = [
  { index: 1, subjects: everyone, direction: [0.75, 0.6, -1], fov: 44, arc: 0.65 },
  { index: 2, subjects: ['hostile-one', 'flight-lead'], direction: [0.6, 0.3, -1], fov: 43, arc: -0.75 },
  { index: 3, subjects: everyone, direction: [-0.7, 0.65, -1], fov: 46, arc: 0.65 },
  {
    index: 5,
    subjects: ['flight-left', 'flight-lead', 'hostile-one'],
    direction: [-0.8, 0.4, -1],
    fov: 44,
    arc: -0.65,
  },
  {
    index: 6,
    subjects: ['flight-lead', 'flight-left'],
    direction: [0.8, 0.5, -1],
    fov: 44,
    arc: 0.7,
    hold: { id: 'hostile-one', time: 62 },
  },
  {
    index: 8,
    subjects: ['hostile-two', 'flight-lead', 'flight-left'],
    direction: [-0.7, 0.35, -1],
    fov: 43,
    arc: 0.7,
  },
  {
    index: 9,
    subjects: ['flight-lead', 'flight-right'],
    direction: [0.75, 0.4, -1],
    fov: 44,
    arc: -0.7,
    hold: { id: 'hostile-two', time: 103 },
  },
  { index: 10, subjects: friends, direction: [0.7, 0.35, -1], fov: 43, arc: 0.75 },
];

function subject(id: string, time: number, hold?: { id: string; time: number }) {
  const object = film.project.objects.find((current) => current.id === id)!;
  const state = sampleObject(object, hold?.id === id ? Math.min(time, hold.time) : time, { render: true });
  const center = new Vector3(...state.position);
  const rotation = new Quaternion().setFromEuler(
    new Euler(...(state.rotation.map((value) => (value * Math.PI) / 180) as Vec3)),
  );
  const corners: Vector3[] = [];
  if (hold?.id === id) {
    for (const x of [-18, 18])
      for (const y of [-18, 18])
        for (const z of [-18, 18]) corners.push(center.clone().add(new Vector3(x, y, z)));
  }
  for (const x of [-0.5, 0.5])
    for (const y of [-0.5, 0.5])
      for (const z of [-0.5, 0.5])
        corners.push(
          new Vector3(
            x * object.dimensions[0] * state.scale[0],
            y * object.dimensions[1] * state.scale[1],
            z * object.dimensions[2] * state.scale[2],
          )
            .applyQuaternion(rotation)
            .add(center),
        );
  return { center, corners };
}

try {
  await film.connect();
  film.project = await film.call<Project>('project_open', { id: projectId });
  const original = film.project;
  const report: { shot: number; minimumDistance: number; maximumDistance: number; arcDegrees: number }[] = [];
  for (const spec of specifications) {
    const distances: number[] = [];
    const frames = Array.from({ length: 289 }, (_, frame) => {
      const fraction = frame / 288;
      const time = (spec.index - 1) * 12 + fraction * 12;
      const subjects = [...spec.subjects, ...(spec.hold ? [spec.hold.id] : [])].map((id) =>
        subject(id, time, spec.hold),
      );
      const target = subjects
        .reduce((sum, current) => sum.add(current.center), new Vector3())
        .divideScalar(subjects.length);
      const normal = new Vector3(...spec.direction)
        .normalize()
        .applyAxisAngle(new Vector3(0, 1, 0), (fraction - 0.5) * spec.arc);
      const right = new Vector3().crossVectors(new Vector3(0, 1, 0), normal).normalize();
      const up = new Vector3().crossVectors(normal, right).normalize();
      const tanY = Math.tan((spec.fov * Math.PI) / 360);
      const tanX = (tanY * 16) / 9;
      let distance = 22;
      for (const corner of subjects.flatMap((current) => current.corners)) {
        const relative = corner.clone().sub(target);
        distance = Math.max(
          distance,
          relative.dot(normal) + Math.abs(relative.dot(right)) / tanX,
          relative.dot(normal) + Math.abs(relative.dot(up)) / tanY,
        );
      }
      // Fit the selected action with visible margins while the camera arcs independently of the flight path.
      distance = distance * (1.16 + 0.09 * fraction) + 4;
      distances.push(distance);
      return {
        id: `space-cinema-${spec.index}-${frame}`,
        time,
        position: target.clone().addScaledVector(normal, distance).toArray(),
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
          patch: { position: frames[0].position, target: frames[0].target, fov: spec.fov, keyframes: frames },
        },
      },
    ]);
    report.push({
      shot: spec.index,
      minimumDistance: Math.min(...distances),
      maximumDistance: Math.max(...distances),
      arcDegrees: (spec.arc * 180) / Math.PI,
    });
  }
  const previous = JSON.parse(
    await readFile(resolve(film.directory, 'production-report.json'), 'utf8'),
  ) as Record<string, unknown>;
  await writeFile(
    resolve(film.directory, 'cinematography-revision.json'),
    JSON.stringify(
      {
        fromProjectId: original.id,
        fromRevision: original.revision,
        toRevision: film.project.revision,
        reason:
          'Actual encoded wide views left subjects too small and screen motion too weak; selected action now fills more of the frame with independent camera arcs.',
        shots: report,
      },
      null,
      2,
    ),
  );
  await film.save({
    ...previous,
    projectId: film.project.id,
    revision: film.project.revision,
    review: 'Camera revision after full encoded-video freeze warnings. New MP4 acceptance pending.',
  });
  for (const [name, time] of [
    ['cinema-01', 6],
    ['cinema-02', 18],
    ['cinema-03', 28.7],
    ['cinema-05', 55.7],
    ['cinema-06', 63.5],
    ['cinema-08', 90],
    ['cinema-09', 104.5],
    ['cinema-10', 114],
  ] as const)
    await film.preview(time, name);
} finally {
  await film.close();
}
