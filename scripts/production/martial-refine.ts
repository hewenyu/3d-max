import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import { ProductionMcp } from './production-mcp';
import { choreography } from './martial-choreography';
import { ContinuityScene } from '../../shared/continuity-scene';
import { sampleObject, sampleTimeline } from '../../shared/timeline';
import type { Command, Project, Vec3 } from '../../shared/types';

export async function refineMartial(film: ProductionMcp) {
  const commands: Command[] = [];
  const before = film.project;
  const after = structuredClone(before);
  for (const fighter of ['qing', 'lan'] as const) {
    const tracks = choreography(fighter);
    after.objects.find((item) => item.id === fighter)!.keyframes = tracks.keyframes;
    commands.push({
      type: 'object.update',
      payload: { id: fighter, patch: { keyframes: tracks.keyframes } },
    });
    commands.push({ type: 'actor.animation.set', payload: { id: fighter, animation: tracks.animation } });
  }
  for (const object of film.project.objects) {
    if (object.id === 'court')
      commands.push({
        type: 'object.update',
        payload: { id: object.id, patch: { position: [0, -0.32, 0] } },
      });
    else if (
      object.id.endsWith('-wall') ||
      object.id.startsWith('gate-pillar-') ||
      object.id.startsWith('bench-') ||
      object.id.startsWith('rack-') ||
      object.id === 'gate-opening'
    )
      commands.push({
        type: 'object.update',
        payload: {
          id: object.id,
          patch: {
            position: [object.position[0], 0, object.id.startsWith('rack-') ? -2.6 : object.position[2]],
            ...(object.id.startsWith('rack-') ? { dimensions: [0.42, 1.12, 0.85] } : {}),
          },
        },
      });
    if (object.id.endsWith('-staff')) {
      commands.push({
        type: 'object.update',
        payload: {
          id: object.id,
          patch: {
            position: [object.position[0], 1.12, object.id.startsWith('qing') ? -2.32 : -2.88],
          },
        },
      });
    }
  }
  for (const [index, camera] of before.cameras.entries()) {
    const subject = index === 2 || index === 6 ? 'lan' : 'qing';
    const close = [2, 4, 6, 7, 12].includes(index);
    const keyframes = camera.keyframes.map((key, frame) => {
      const time = index * 8 + (frame / 32) * 8;
      const focus = (project: Project) =>
        close
          ? sampleObject(
              project.objects.find((item) => item.id === subject)!,
              time,
            ).position
          : ['qing', 'lan']
              .map(
                (id) =>
                  sampleObject(
                    project.objects.find((item) => item.id === id)!,
                    time,
                  ).position,
              )
              .reduce((a, b) => a.map((v, axis) => v + b[axis]! / 2) as Vec3, [0, 0, 0] as Vec3);
      const a = focus(before);
      const b = focus(after);
      const move = (value: Vec3) => value.map((v, axis) => v + b[axis]! - a[axis]!) as Vec3;
      return { ...key, position: move(key.position), target: move(key.target) };
    });
    commands.push({ type: 'camera.update', payload: { id: camera.id, patch: { keyframes } } });
  }
  await film.edit(commands);
  const scene = new ContinuityScene(film.project, 'martial-grip');
  try {
    for (const fighter of ['qing', 'lan'] as const) {
      const time = fighter === 'qing' ? 56 : 57;
      const staff = film.project.objects.find((item) => item.id === `${fighter}-staff`)!;
      scene.sample(sampleTimeline(film.project, time - 0.000001));
      const hand = scene.objects.get(fighter)!.rig!.rightHand;
      const local = hand.worldToLocal(new Vector3(...staff.position)).toArray() as Vec3;
      const rotation = new Euler().setFromQuaternion(hand.getWorldQuaternion(new Quaternion()).invert());
      const angles: Vec3 = [rotation.x, rotation.y, rotation.z].map(MathUtils.radToDeg) as Vec3;
      await film.edit([
        {
          type: 'object.update',
          payload: {
            id: staff.id,
            patch: {
              rotationInterpolation: 'quaternion',
              keyframes: [
                {
                  id: `${fighter}-staff-pickup`,
                  time,
                  position: [0, 0, 0],
                  rotation: angles,
                  attachment: { objectId: fighter, bone: 'rightHand', offset: local },
                  easing: 'step',
                },
                { id: `${fighter}-staff-lift`, time: time + 0.45, rotation: [180, 0, 0], easing: 'smooth' },
              ],
            },
          },
        },
      ]);
    }
  } finally {
    scene.dispose();
  }
}

if (process.argv[1]?.endsWith('martial-refine.ts')) {
  const film = new ProductionMcp('martial', process.env.WHITEFRAME_PRODUCTION_API ?? 'http://127.0.0.1:4201');
  try {
    await film.connect();
    film.project = await film.call<Project>('project_get');
    await refineMartial(film);
    await film.save({ status: 'authored-layout-and-grip-refined-video-export-pending' });
  } finally {
    await film.close();
  }
}
