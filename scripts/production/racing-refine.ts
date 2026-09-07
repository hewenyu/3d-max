import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Vector3 } from 'three';
import { ProductionMcp } from './production-mcp';
import { compilePath, pathClock, quaternionFor } from '../../shared/motion';
import { sampleObject } from '../../shared/timeline';
import { clipDuration } from '../../shared/time-map';
import type { Command, Project, Vec3 } from '../../shared/types';

const film = new ProductionMcp('racing');
const schedules = [
  [
    [0, 0],
    [20, 15],
    [30, 8],
    [42, -10],
    [54, -18],
    [62, 12],
    [72, 15],
    [82, 8],
    [96, -10],
    [112, -8],
  ],
  [
    [0, 0],
    [20, 3],
    [30, -2],
    [42, -12],
    [54, -20],
    [62, -4],
    [72, 2],
    [82, -12],
    [96, -20],
    [112, -14],
  ],
];
function derivative(points: number[][], time: number) {
  const next = points.findIndex((point) => point[0]! >= time);
  const index = Math.max(1, next < 0 ? points.length - 1 : next);
  const [start, a] = points[index - 1]!;
  const [end, b] = points[index]!;
  const u = Math.max(0, Math.min(1, (time - start!) / (end! - start!)));
  return ((b! - a!) * 6 * u * (1 - u)) / (end! - start!);
}
try {
  await film.connect();
  const id = (await readFile(resolve(film.directory, 'project-id.txt'), 'utf8')).trim();
  film.project = await film.call<Project>('project_open', { id });
  const primary = film.project.objects.find((object) => object.id === 'racer-a')!;
  const primaryLength = compilePath(primary.motion!).length;
  for (const [index, id] of ['racer-b', 'racer-c'].entries()) {
    const object = film.project.objects.find((item) => item.id === id)!;
    const ratio = compilePath(object.motion!).length / primaryLength;
    const speed = Array.from({ length: 112 }, (_, second) => ({
      duration: 1,
      fromSpeed: Math.max(
        1,
        pathClock(primary.motion!, second).speed * ratio + derivative(schedules[index]!, second),
      ),
      toSpeed: Math.max(
        1,
        pathClock(primary.motion!, second + 1 - 1e-7).speed * ratio +
          derivative(schedules[index]!, second + 1),
      ),
      easing: 'linear',
    }));
    await film.edit([
      { type: 'motion.path.set', payload: { id, path: { ...object.motion, speed } } },
      { type: 'motion.path.bake', payload: { id, fps: 24 } },
    ]);
  }
  const gallery: Command[] = [];
  for (let index = 0; index < 12; index++) {
    const car = sampleObject(primary, 72 + index * 0.84, { render: true });
    const right = new Vector3(1, 0, 0).applyQuaternion(quaternionFor(car.rotation));
    const center = new Vector3(...car.position).addScaledVector(right, 5);
    for (const [part, side, height] of [
      ['left', -10.5, 0],
      ['right', 10.5, 0],
      ['roof', 0, 6.8],
    ] as const) {
      const position = center.clone().addScaledVector(right, side);
      position.y = height;
      gallery.push({
        type: 'object.update',
        payload: {
          id: `gallery-${part}-${index}`,
          patch: {
            position: position.toArray() as Vec3,
            rotation: [0, car.rotation[1], 0],
          },
        },
      });
    }
  }
  await film.edit(gallery);
  const car = sampleObject(
    film.project.objects.find((object) => object.id === 'racer-b')!,
    62,
    { render: true },
  );
  const world = (offset: Vec3) =>
    new Vector3(...offset)
      .applyQuaternion(quaternionFor(car.rotation))
      .add(new Vector3(...car.position))
      .toArray() as Vec3;
  await film.edit([
    {
      type: 'camera.update',
      payload: {
        id: 'race-camera-7',
        patch: {
          position: world([-3.6, 1, 6.2]),
          target: world([0, 0.85, 0]),
          keyframes: [],
        },
      },
    },
  ]);
  await film.command('camera_motion', {
    id: 'race-camera-7',
    motion: 'follow',
    start: 62,
    end: 72,
    subjectId: 'racer-b',
    rotateWithSubject: true,
  });
  const overtake = sampleObject(primary, 42, { render: true });
  const overtakeWorld = (offset: Vec3) =>
    new Vector3(...offset)
      .applyQuaternion(quaternionFor(overtake.rotation))
      .add(new Vector3(...overtake.position))
      .toArray() as Vec3;
  await film.edit([
    {
      type: 'camera.update',
      payload: {
        id: 'race-camera-5',
        patch: {
          position: overtakeWorld([10, 10, -32]),
          target: overtakeWorld([4, 0.8, -2]),
          fov: 52,
          keyframes: [],
        },
      },
    },
  ]);
  await film.command('camera_motion', {
    id: 'race-camera-5',
    motion: 'follow',
    start: 42,
    end: 54,
    subjectId: 'racer-a',
    rotateWithSubject: true,
  });
  const distances = Array.from({ length: 113 }, (_, time) => {
    const cars = ['racer-a', 'racer-b', 'racer-c'].map((id) =>
      sampleObject(
        film.project.objects.find((object) => object.id === id)!,
        time,
        { render: true },
      ),
    );
    const forward = new Vector3(0, 0, 1).applyQuaternion(quaternionFor(cars[0]!.rotation));
    return {
      time,
      bAheadMeters: new Vector3(...cars[1]!.position).sub(new Vector3(...cars[0]!.position)).dot(forward),
      cAheadMeters: new Vector3(...cars[2]!.position).sub(new Vector3(...cars[0]!.position)).dot(forward),
      minimumCenterDistance: Math.min(
        ...cars.flatMap((a, i) =>
          cars.slice(i + 1).map((b) => new Vector3(...a.position).distanceTo(new Vector3(...b.position))),
        ),
      ),
    };
  });
  await film.save({
    sourceDuration: 112,
    retimedClip: 'race-clip-6',
    relativeVehiclePositions: distances,
    review:
      'Revised vehicle spacing and gallery alignment; actual PNG review in progress. Long video export pending.',
  });
  const clips = film.project.sequences.find(
    (sequence) => sequence.id === film.project.activeSequenceId,
  )!.clips;
  for (const index of [0, 2, 3, 4, 5, 7, 8, 9]) {
    const start = clips.slice(0, index).reduce((sum, clip) => sum + clipDuration(clip), 0);
    await film.preview(
      start + clipDuration(clips[index]!) * 0.5,
      `shot-${String(index + 1).padStart(2, '0')}`,
    );
  }
} finally {
  await film.close();
}
