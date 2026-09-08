import { createHash } from 'node:crypto';
import type { Command, Project, Vec3 } from '../../shared/types';
import type { MeshModifier } from '../../shared/modifier-schema';
import type { SurfaceProfile } from '../../shared/surfaces/schema';
import { ModelingAssetClient } from './client';

export const create = (payload: Record<string, unknown>): Command => ({ type: 'object.create', payload });
export const modify = (id: string, modifier: Record<string, unknown>): Command => ({
  type: 'modifier.add',
  payload: { id, modifier },
});
export const surface = (id: string, values: Record<string, unknown>): Command => ({
  type: 'surface.set',
  payload: { id, surface: { kind: 'surface', smooth: true, ...values } },
});
export const profile = (points: number[][]) => ({
  outer: { closed: true, points: points.map((position) => ({ position })) },
  holes: [],
});
export const ellipse = (width: number, height: number): SurfaceProfile => {
  const k = 0.552284749831;
  return {
    outer: {
      closed: true,
      points: [
        { position: [width, 0], inTangent: [0, -height * k], outTangent: [0, height * k] },
        { position: [0, height], inTangent: [width * k, 0], outTangent: [-width * k, 0] },
        { position: [-width, 0], inTangent: [0, height * k], outTangent: [0, -height * k] },
        { position: [0, -height], inTangent: [-width * k, 0], outTangent: [width * k, 0] },
      ],
    },
    holes: [],
  };
};
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function settings(author: ModelingAssetClient, name: string) {
  await author.commands(
    [
      { type: 'project.update', payload: { sceneName: name } },
      {
        type: 'project.settings',
        payload: {
          fps: 24,
          aspect: '16:9',
          resolution: 720,
          lighting: { intensity: 2.4, ambient: 0.8, azimuth: 130, elevation: 42 },
          environment: { ground: true, background: '#d9dfdd', groundTone: '#b7c2bd' },
        },
      },
    ],
    'studio-settings',
  );
}

export interface ShowcaseView {
  name: string;
  from: Vec3;
  to: Vec3;
  target: Vec3;
  fov?: number;
  subjects: string[];
}
export async function cameras(author: ModelingAssetClient, views: ShowcaseView[]) {
  const commands: Command[] = [];
  const clips = views.map((view, index) => {
    const start = index * 6;
    const id = `inspection-camera-${index}`;
    const shotId = `inspection-shot-${index}`;
    const keyframes = Array.from({ length: 145 }, (_, frame) => ({
      id: `${id}-${frame}`,
      time: start + frame / 24,
      position: view.from.map((value, axis) => value + ((view.to[axis] - value) * frame) / 144),
      target: view.target,
      fov: view.fov ?? 43,
      easing: 'linear',
    }));
    commands.push(
      {
        type: 'camera.create',
        payload: {
          id,
          name: view.name,
          position: view.from,
          target: view.target,
          fov: view.fov ?? 43,
          keyframes,
        },
      },
      {
        type: 'shot.create',
        payload: {
          id: shotId,
          name: view.name,
          cameraId: id,
          sourceIn: start,
          sourceOut: start + 6,
          subjectIds: view.subjects,
          intent: view.name,
        },
      },
    );
    return { id: `inspection-clip-${index}`, shotId, sourceIn: start, sourceOut: start + 6 };
  });
  commands.push({
    type: 'sequence.update',
    payload: { id: author.project.activeSequenceId, patch: { name: '结构与造型检查', clips } },
  });
  await author.commands(commands, 'inspection-cameras');
  await author.save('camera-checklist.json', views);
}

export async function modificationCycle(author: ModelingAssetClient, id: string, modifier: MeshModifier) {
  const before = structuredClone(author.project.objects);
  const evaluatedBefore = await author.inspect(id, 'vertex', 'evaluated');
  await author.command('modifier_set', { id, modifier });
  const changed = structuredClone(author.project.objects);
  const evaluatedChanged = await author.inspect(id, 'vertex', 'evaluated');
  if (digest(evaluatedBefore.elements) === digest(evaluatedChanged.elements))
    throw new Error('Parameter edit did not change evaluated geometry');
  author.project = await author.call<Project>('history_undo', {
    projectId: author.project.id,
    expectedRevision: author.project.revision,
  });
  if (digest(author.project.objects) !== digest(before))
    throw new Error('Undo did not exactly restore source and dependencies');
  author.project = await author.call<Project>('history_redo', {
    projectId: author.project.id,
    expectedRevision: author.project.revision,
  });
  if (digest(author.project.objects) !== digest(changed))
    throw new Error('Redo did not exactly restore the changed objects');
  await author.save('edit-undo-redo.json', {
    id,
    before: digest(before),
    changed: digest(changed),
    evaluatedBefore: digest(evaluatedBefore.elements),
    evaluatedChanged: digest(evaluatedChanged.elements),
    restored: true,
  });
}

export async function artifacts(author: ModelingAssetClient, views: ShowcaseView[]) {
  for (let index = 0; index < views.length; index++)
    await author.preview(`angle-${index + 1}.png`, `inspection-shot-${index}`, 3);
  await author.save('authored-project.json', author.project);
  await author.exportGlb();
  await author.exportVideo(author.name, views.length * 6);
  await author.exportPackage();
  await author.reviewVideo();
  await author.save('delivery.json', {
    projectId: author.project.id,
    revision: author.project.revision,
    directory: author.directory,
    objects: author.project.objects.length,
    restartVerification: 'pending',
    visualReview: 'pending',
  });
}
