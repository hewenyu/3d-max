import { z } from 'zod';
import { createEmptyProject, createObject, id } from './project';
import { projectSchema, validateProject } from './schema';
import { createScene, selectProduction } from './production';
import { remapActorTargets } from './actor-validation';
import { referencedOperandIds } from './modifiers/dependencies';
import { remapModifierReferences } from './modifier-references';
import { objectFace } from './face-animation';
import { DomainError } from './domain-error';
import type { Project, SceneObject } from './types';

export const templateContentSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['objects', 'scene']),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(''),
    project: projectSchema,
  })
  .strict();
export type TemplateContent = z.infer<typeof templateContentSchema>;
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  kind: TemplateContent['kind'];
  objectCount: number;
  shotCount: number;
  revision: number;
  updatedAt: string;
}
export const templateCaptureSchema = z
  .object({
    kind: z.enum(['objects', 'scene']),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(''),
    objectIds: z.array(z.string().min(1).max(160)).max(10000).optional(),
  })
  .strict();

function objectReferences(object: SceneObject): string[] {
  return [
    ...referencedOperandIds(object),
    object.parentId,
    object.attachment?.objectId,
    object.actor?.lookAtId,
    ...object.keyframes.flatMap((frame) => [frame.attachment?.objectId, frame.lookAtId]),
    ...(object.actor?.animation?.constraints.flatMap((constraint) =>
      constraint.target.kind === 'object' ? [constraint.target.objectId] : [],
    ) ?? []),
    ...(object.motionEvents?.map((event) => event.otherId) ?? []),
  ].filter((value): value is string => !!value);
}

/** Include hierarchy and constraint dependencies so a saved assembly has no external object links. */
function dependencyClosure(project: Project, selected: string[]): Set<string> {
  const objects = new Map(project.objects.map((object) => [object.id, object]));
  if (!selected.length) throw new DomainError('Select at least one object to save a template');
  const included = new Set(selected);
  let changed = true;
  while (changed) {
    const before = included.size;
    for (const objectId of included) {
      const object = objects.get(objectId);
      if (!object) throw new DomainError(`Template object does not exist: ${objectId}`);
      for (const reference of objectReferences(object)) included.add(reference);
    }
    for (const object of project.objects)
      if (
        (object.parentId && included.has(object.parentId)) ||
        (object.attachment && included.has(object.attachment.objectId))
      )
        included.add(object.id);
    changed = included.size !== before;
  }
  return included;
}

export function captureTemplate(
  project: Project,
  input: z.input<typeof templateCaptureSchema>,
): TemplateContent {
  const options = templateCaptureSchema.parse(input);
  const scene = options.kind === 'scene';
  const included = scene
    ? new Set(project.objects.map((object) => object.id))
    : dependencyClosure(project, options.objectIds ?? []);
  const snapshot = createEmptyProject(options.name);
  snapshot.sceneName = project.sceneName;
  snapshot.objects = structuredClone(project.objects.filter((object) => included.has(object.id)));
  snapshot.settings = structuredClone(project.settings);
  snapshot.settings.axisActorIds = snapshot.settings.axisActorIds.filter((objectId) =>
    included.has(objectId),
  );
  if (scene) {
    snapshot.beats = structuredClone(project.beats);
    snapshot.audio = structuredClone(project.audio);
    snapshot.shots = structuredClone(
      project.shots.filter(
        (shot) =>
          !project.production ||
          (shot.sceneId === project.production.activeSceneId &&
            shot.performanceId === project.production.activePerformanceId),
      ),
    );
    for (const shot of snapshot.shots) {
      delete shot.sceneId;
      delete shot.performanceId;
      delete shot.storySceneId;
    }
    const cameraIds = new Set(snapshot.shots.map((shot) => shot.cameraId));
    snapshot.cameras = structuredClone(project.cameras.filter((camera) => cameraIds.has(camera.id)));
    const shotIds = new Set(snapshot.shots.map((shot) => shot.id));
    snapshot.sequences = structuredClone(
      project.sequences.map((sequence) => ({
        ...sequence,
        clips: sequence.clips.filter((clip) => shotIds.has(clip.shotId)),
      })),
    );
    snapshot.activeSequenceId = project.activeSequenceId;
    snapshot.notes = structuredClone(
      project.notes.filter((note) => !note.shotId || shotIds.has(note.shotId)),
    );
  }
  const groups = project.synchronization?.filter(
    (group) =>
      scene || group.members.every((member) => 'objectId' in member && included.has(member.objectId)),
  );
  if (groups?.length) snapshot.synchronization = structuredClone(groups);
  if (!scene)
    for (const object of snapshot.objects)
      for (const clip of objectFace(object)?.clips ?? []) clip.audioId = null;
  if (scene) {
    const usedPlans = new Set([
      snapshot.settings.lightingPlanId,
      ...snapshot.shots.map((shot) => shot.lightingPlanId),
    ]);
    if (project.lightingPlans)
      snapshot.lightingPlans = structuredClone(
        project.lightingPlans.filter((plan) => usedPlans.has(plan.id)),
      );
  } else delete snapshot.settings.lightingPlanId;
  return {
    version: 1,
    kind: options.kind,
    name: options.name,
    description: options.description,
    project: validateProject(snapshot),
  };
}

export const templateCommandDefinitions = [
  {
    type: 'template.instantiate',
    description:
      'Instantiate a saved object assembly or scene template as independent editable content. Object references, constraints, actions, timing groups, cameras and cuts are remapped. Scene templates create and activate a new scene/take and import its camera/edit variants. Object templates add an assembly group in the current scene. One atomic undo step; template data comes from template_get.',
    schema: z
      .object({ template: templateContentSchema, name: z.string().trim().min(1).max(200).optional() })
      .strict(),
  },
];

export function instantiateTemplate(project: Project, input: unknown) {
  const { template, name } = templateCommandDefinitions[0].schema.parse(input);
  const source = validateProject(template.project);
  if (source.production) throw new DomainError('A template must contain one resolved scene and performance');
  const instanceName = name ?? template.name;
  const remap = (items: { id: string }[], prefix: string) =>
    new Map(items.map((item) => [item.id, id(prefix)]));
  const objects = remap(source.objects, 'object');
  const beats = remap(source.beats, 'beat');
  const audio = remap(source.audio, 'audio');
  const cameras = remap(source.cameras, 'camera');
  const shots = remap(source.shots, 'shot');
  const sequences = remap(source.sequences, 'sequence');
  const lightingPlans = remap(source.lightingPlans ?? [], 'lighting');
  let sceneId: string | undefined;
  let performanceId: string | undefined;
  let groupId: string | undefined;
  if (template.kind === 'scene') {
    const scene = createScene(project, instanceName);
    selectProduction(project, scene.id);
    sceneId = scene.id;
    performanceId = scene.performances[0].id;
    project.settings.lighting = structuredClone(source.settings.lighting);
    if (source.lightingPlans?.length)
      project.lightingPlans = [
        ...(project.lightingPlans ?? []),
        ...source.lightingPlans.map((plan) => ({
          ...structuredClone(plan),
          id: lightingPlans.get(plan.id)!,
          locked: false,
        })),
      ];
    if (source.settings.lightingPlanId)
      project.settings.lightingPlanId = lightingPlans.get(source.settings.lightingPlanId)!;
    else delete project.settings.lightingPlanId;
    if (source.settings.environment)
      project.settings.environment = structuredClone(source.settings.environment);
    else delete project.settings.environment;
    project.settings.axisActorIds = source.settings.axisActorIds.map((objectId) => objects.get(objectId)!);
  } else {
    const group = createObject('group', instanceName);
    groupId = group.id;
    project.objects.push(group);
  }
  for (const object of source.objects) {
    const clone = structuredClone(object);
    clone.id = objects.get(object.id)!;
    clone.locked = false;
    clone.parentId = object.parentId ? objects.get(object.parentId)! : (groupId ?? null);
    if (clone.attachment) clone.attachment.objectId = objects.get(clone.attachment.objectId)!;
    if (clone.actor?.lookAtId) clone.actor.lookAtId = objects.get(clone.actor.lookAtId)!;
    remapActorTargets(clone, objects);
    remapModifierReferences(clone, objects);
    for (const clip of objectFace(clone)?.clips ?? [])
      if (clip.audioId) clip.audioId = audio.get(clip.audioId) ?? null;
    for (const frame of clone.keyframes) {
      if (frame.attachment) frame.attachment.objectId = objects.get(frame.attachment.objectId)!;
      if (frame.lookAtId) frame.lookAtId = objects.get(frame.lookAtId)!;
    }
    for (const event of clone.motionEvents ?? [])
      if (event.otherId) event.otherId = objects.get(event.otherId)!;
    project.objects.push(clone);
  }
  project.beats.push(
    ...source.beats.map((beat) => ({
      ...structuredClone(beat),
      id: beats.get(beat.id)!,
      locked: false,
      actorId: beat.actorId ? objects.get(beat.actorId)! : null,
    })),
  );
  project.audio.push(
    ...source.audio.map((clip) => ({ ...structuredClone(clip), id: audio.get(clip.id)!, locked: false })),
  );
  const groups = source.synchronization?.map((group) => ({
    ...structuredClone(group),
    id: id('sync'),
    locked: false,
    members: group.members.map((member) => {
      if (member.kind === 'beat') return { ...member, id: beats.get(member.id)! };
      if (member.kind === 'audio') return { ...member, id: audio.get(member.id)! };
      return { ...member, objectId: objects.get(member.objectId)! };
    }),
  }));
  if (groups?.length) project.synchronization = [...(project.synchronization ?? []), ...groups];
  for (const camera of source.cameras) {
    const clone = structuredClone(camera);
    clone.id = cameras.get(camera.id)!;
    clone.locked = false;
    if (clone.optics) {
      if (clone.optics.focusTargetId) clone.optics.focusTargetId = objects.get(clone.optics.focusTargetId)!;
      for (const key of clone.optics.keyframes)
        if (key.focusTargetId) key.focusTargetId = objects.get(key.focusTargetId)!;
    }
    project.cameras.push(clone);
  }
  project.shots.push(
    ...source.shots.map((shot) => ({
      ...structuredClone(shot),
      id: shots.get(shot.id)!,
      cameraId: cameras.get(shot.cameraId)!,
      ...(shot.lightingPlanId ? { lightingPlanId: lightingPlans.get(shot.lightingPlanId)! } : {}),
      locked: false,
      sceneId,
      performanceId,
      subjectIds: shot.subjectIds.map((objectId) => objects.get(objectId)!),
      hiddenIds: shot.hiddenIds.map((objectId) => objects.get(objectId)!),
      beatId: shot.beatId ? beats.get(shot.beatId)! : null,
    })),
  );
  if (template.kind === 'scene') {
    project.sequences.push(
      ...source.sequences.map((sequence) => ({
        ...structuredClone(sequence),
        id: sequences.get(sequence.id)!,
        name: `${instanceName} / ${sequence.name}`,
        locked: false,
        clips: sequence.clips.map((clip) => ({
          ...structuredClone(clip),
          id: id('clip'),
          shotId: shots.get(clip.shotId)!,
        })),
      })),
    );
    project.activeSequenceId = sequences.get(source.activeSequenceId)!;
  }
  project.notes.push(
    ...source.notes.map((note) => ({
      ...structuredClone(note),
      id: id('note'),
      shotId: note.shotId ? shots.get(note.shotId)! : null,
    })),
  );
  return { groupId, sceneId, performanceId, objectIds: [...objects.values()], shotIds: [...shots.values()] };
}
