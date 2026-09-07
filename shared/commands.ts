import type {
  AudioClip,
  Beat,
  CameraKeyframe,
  Command,
  DirectorNote,
  ObjectKeyframe,
  Project,
  SceneObject,
  Sequence,
  Shot,
  ShotCamera,
} from './types';
import { createObject, id } from './project';
import { validateProject } from './schema';
import { commandDefinitions } from './command-definitions';
import { retimeClip, splitClip, trimClip } from './time-map';
import type { CameraTiming, ClipRetiming } from './types';
import { applyModelingCommand, modelingCommandDefinitions } from './modeling';
import { buildCameraMotion, type CameraMotion } from './camera-motion';
import { applyProductionCommand, productionCommandDefinitions } from './production-commands';
import { syncProduction } from './production';
import { DomainError } from './domain-error';
import { actorCommandDefinitions, applyActorCommand } from './actor-commands';
import { protectActorTargets, remapActorTargets } from './actor-validation';
import { motionCommandDefinitions } from './motion';
import { applyMotionCommand } from './motion-operations';
import { applyCameraSettingsCommand, cameraSettingsCommandDefinitions, cameraTrack } from './camera-commands';
import { aspectComposition, type Aspect } from './camera-optics';
import { applyModelCommand, modelCommandDefinitions } from './model-catalog';
import { applyCameraPreset } from './camera-presets';
import { applyContinuityCommand, continuityCommandDefinitions } from './continuity-types';
import { instantiateTemplate } from './templates';
import { planScriptImport } from './script-plan';
import { faceCommandDefinitions, applyFaceCommand } from './face-commands';
import { applyLightingCommand, lightingCommandDefinitions } from './lighting-commands';
import { captureLightingState, lightingCopyName, validateLightingLocks } from './lighting-plans';
import {
  applySynchronization,
  applySynchronizationCommand,
  captureSynchronization,
  createSynchronizationTransaction,
  synchronizationCommandDefinitions,
} from './synchronization-operations';
export { validateProject, commandDefinitions };

export { DomainError };

type Entity = { id: string; locked?: boolean };
function find<T extends Entity>(items: T[], entityId: unknown): T {
  const entity = items.find((item) => item.id === entityId);
  if (!entity) throw new DomainError(`Entity not found: ${String(entityId)}`, 'NOT_FOUND', 404);
  return entity;
}
function unlocked(entity: Entity, patch?: Record<string, unknown>) {
  if (entity.locked && !(patch && Object.keys(patch).length === 1 && patch.locked === false))
    throw new DomainError(`Entity is locked: ${entity.id}`, 'LOCKED', 409);
}
function cameraUnlocked(project: Project, camera: ShotCamera, patch?: Record<string, unknown>) {
  unlocked(camera, patch);
  const lockedShot = project.shots.find((shot) => shot.cameraId === camera.id && shot.locked);
  if (lockedShot && !(patch && Object.keys(patch).length === 1 && patch.locked === false))
    throw new DomainError(`Camera is used by locked shot: ${lockedShot.id}`, 'LOCKED', 409);
}
function patchEntity<T extends Entity>(items: T[], payload: Record<string, unknown>): T {
  const entity = find(items, payload.id);
  const patch = payload.patch as Record<string, unknown>;
  unlocked(entity, patch);
  Object.assign(entity, patch);
  return entity;
}
function removeEntity<T extends Entity>(items: T[], entityId: unknown): { id: string; deleted: true } {
  const entity = find(items, entityId);
  unlocked(entity);
  items.splice(items.indexOf(entity), 1);
  return { id: entity.id, deleted: true };
}
function setKeyframe<T extends ObjectKeyframe | CameraKeyframe>(frames: T[], keyframe: T): T {
  const byId = frames.findIndex((frame) => frame.id === keyframe.id);
  const byTime = frames.findIndex((frame) => frame.time === keyframe.time);
  if (byId >= 0 && byTime >= 0 && byId !== byTime)
    throw new DomainError('Another keyframe already exists at this time');
  const index = byId >= 0 ? byId : byTime;
  if (index >= 0) frames[index] = keyframe;
  else frames.push(keyframe);
  frames.sort((a, b) => a.time - b.time);
  return keyframe;
}

function deleteObject(project: Project, objectId: unknown) {
  const root = find(project.objects, objectId);
  const removed = new Set([root.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of project.objects) {
      if (object.parentId && removed.has(object.parentId) && !removed.has(object.id)) {
        removed.add(object.id);
        changed = true;
      }
    }
  }
  project.objects.filter((object) => removed.has(object.id)).forEach((object) => unlocked(object));
  for (const object of project.objects.filter((object) => !removed.has(object.id))) {
    protectActorTargets(object, removed);
    if (
      (object.attachment && removed.has(object.attachment.objectId)) ||
      object.keyframes.some((frame) => frame.attachment && removed.has(frame.attachment.objectId))
    ) {
      throw new DomainError(`Detach ${object.id} before deleting its attachment target`);
    }
    if (
      (object.actor?.lookAtId && removed.has(object.actor.lookAtId)) ||
      object.keyframes.some((frame) => frame.lookAtId && removed.has(frame.lookAtId))
    ) {
      unlocked(object);
      if (object.actor?.lookAtId && removed.has(object.actor.lookAtId)) object.actor.lookAtId = null;
      object.keyframes.forEach((frame) => {
        if (frame.lookAtId && removed.has(frame.lookAtId)) frame.lookAtId = null;
      });
    }
  }
  for (const shot of project.shots) {
    if (project.production && shot.sceneId !== project.production.activeSceneId) continue;
    if ([...shot.subjectIds, ...shot.hiddenIds].some((entityId) => removed.has(entityId))) {
      unlocked(shot);
      shot.subjectIds = shot.subjectIds.filter((entityId) => !removed.has(entityId));
      shot.hiddenIds = shot.hiddenIds.filter((entityId) => !removed.has(entityId));
    }
  }
  for (const beat of project.beats) {
    if (beat.actorId && removed.has(beat.actorId)) {
      unlocked(beat);
      beat.actorId = null;
    }
  }
  project.settings.axisActorIds = project.settings.axisActorIds.filter((entityId) => !removed.has(entityId));
  project.objects = project.objects.filter((object) => !removed.has(object.id));
  return { id: root.id, deleted: true, deletedIds: [...removed] };
}

function duplicateObject(project: Project, payload: Record<string, unknown>): SceneObject {
  const source = find(project.objects, payload.id);
  const ids = new Set([source.id]);
  let added = true;
  while (added) {
    added = false;
    project.objects.forEach((object) => {
      if (
        ((object.parentId && ids.has(object.parentId)) ||
          (object.attachment && ids.has(object.attachment.objectId))) &&
        !ids.has(object.id)
      ) {
        ids.add(object.id);
        added = true;
      }
    });
  }
  const mapping = new Map(
    [...ids].map((objectId) => [
      objectId,
      objectId === source.id && payload.newId ? String(payload.newId) : id('object'),
    ]),
  );
  const clones = project.objects
    .filter((object) => ids.has(object.id))
    .map((object) => {
      const clone = structuredClone(object);
      clone.id = mapping.get(object.id)!;
      clone.locked = false;
      remapActorTargets(clone, mapping);
      for (const event of clone.motionEvents ?? []) {
        event.id = id('event');
        if (event.otherId) event.otherId = mapping.get(event.otherId) ?? event.otherId;
      }
      clone.name = object.id === source.id ? String(payload.name ?? `${source.name} 副本`) : object.name;
      clone.parentId = clone.parentId ? (mapping.get(clone.parentId) ?? clone.parentId) : null;
      if (clone.attachment)
        clone.attachment.objectId = mapping.get(clone.attachment.objectId) ?? clone.attachment.objectId;
      if (clone.actor?.lookAtId)
        clone.actor.lookAtId = mapping.get(clone.actor.lookAtId) ?? clone.actor.lookAtId;
      clone.keyframes.forEach((frame) => {
        frame.id = id('keyframe');
        if (frame.attachment)
          frame.attachment.objectId = mapping.get(frame.attachment.objectId) ?? frame.attachment.objectId;
        if (frame.lookAtId) frame.lookAtId = mapping.get(frame.lookAtId) ?? frame.lookAtId;
      });
      return clone;
    });
  project.objects.push(...clones);
  return clones.find((object) => object.id === mapping.get(source.id))!;
}

function duplicateSequence(project: Project, payload: Record<string, unknown>): Sequence {
  const source = find(project.sequences, payload.id);
  const cameras = new Map<string, string>();
  const shots = new Map<string, string>();
  const lightingPlans = new Map<string, string>();
  for (const shotId of new Set(source.clips.map((clip) => clip.shotId))) {
    const shot = find(project.shots, shotId);
    if (!cameras.has(shot.cameraId)) {
      const camera = structuredClone(find(project.cameras, shot.cameraId));
      const cameraId = id('camera');
      cameras.set(camera.id, cameraId);
      camera.id = cameraId;
      camera.name += ' 副本';
      camera.locked = false;
      camera.keyframes.forEach((frame) => {
        frame.id = id('keyframe');
      });
      project.cameras.push(camera);
    }
    const clonedShot: Shot = {
      ...structuredClone(shot),
      id: id('shot'),
      cameraId: cameras.get(shot.cameraId)!,
      locked: false,
    };
    if (shot.lightingPlanId) {
      if (!lightingPlans.has(shot.lightingPlanId)) {
        const plan = structuredClone(find(project.lightingPlans ?? [], shot.lightingPlanId));
        plan.id = id('lighting');
        plan.name = lightingCopyName(plan.name);
        plan.locked = false;
        project.lightingPlans!.push(plan);
        lightingPlans.set(shot.lightingPlanId, plan.id);
      }
      clonedShot.lightingPlanId = lightingPlans.get(shot.lightingPlanId)!;
    }
    shots.set(shotId, clonedShot.id);
    project.shots.push(clonedShot);
  }
  const sequence: Sequence = {
    ...structuredClone(source),
    id: String(payload.newId ?? id('sequence')),
    name: String(payload.name ?? `${source.name} 副本`),
    locked: false,
    clips: source.clips.map((clip) => ({ ...clip, id: id('clip'), shotId: shots.get(clip.shotId)! })),
  };
  project.sequences.push(sequence);
  const notes = project.notes.filter((note) => note.shotId && shots.has(note.shotId));
  project.notes.push(...notes.map((note) => ({ ...note, id: id('note'), shotId: shots.get(note.shotId!)! })));
  return sequence;
}

function mutate(project: Project, command: Command): unknown {
  if (lightingCommandDefinitions.some((definition) => definition.type === command.type))
    return applyLightingCommand(project, command);
  if (command.type === 'camera.preset') return applyCameraPreset(project, command);
  if (faceCommandDefinitions.some((definition) => definition.type === command.type))
    return applyFaceCommand(project, command);
  if (command.type === 'template.instantiate') return instantiateTemplate(project, command.payload);
  if (continuityCommandDefinitions.some((definition) => definition.type === command.type))
    return applyContinuityCommand(project, command.type, command.payload);
  if (synchronizationCommandDefinitions.some((definition) => definition.type === command.type))
    return applySynchronizationCommand(project, command);
  if (cameraSettingsCommandDefinitions.some((definition) => definition.type === command.type))
    return applyCameraSettingsCommand(project, command);
  if (modelCommandDefinitions.some((definition) => definition.type === command.type))
    return applyModelCommand(project, command);
  if (motionCommandDefinitions.some((definition) => definition.type === command.type))
    return applyMotionCommand(project, command);
  if (actorCommandDefinitions.some((definition) => definition.type === command.type))
    return applyActorCommand(project, command);
  if (productionCommandDefinitions.some((definition) => definition.type === command.type))
    return applyProductionCommand(project, command);
  const p = command.payload;
  switch (command.type) {
    case 'script.apply': {
      const plan = planScriptImport(project, p);
      const applied = applyCommands(project, plan.commands);
      Object.assign(project, applied.project);
      return plan.summary;
    }
    case 'clip.transition': {
      const sequence = find(project.sequences, p.sequenceId);
      unlocked(sequence);
      const clip = find(sequence.clips, p.clipId);
      unlocked(find(project.shots, clip.shotId));
      const previous = sequence.clips[sequence.clips.indexOf(clip) - 1];
      if (p.transitionIn !== undefined && previous) unlocked(find(project.shots, previous.shotId));
      for (const field of ['fadeIn', 'fadeOut', 'transitionIn'] as const) {
        if (p[field] === null) delete clip[field];
        else if (p[field] !== undefined) Object.assign(clip, { [field]: structuredClone(p[field]) });
      }
      return clip;
    }
    case 'clip.retime':
    case 'clip.trim':
    case 'clip.split': {
      const sequence = find(project.sequences, p.sequenceId);
      unlocked(sequence);
      const clip = find(sequence.clips, p.clipId);
      unlocked(find(project.shots, clip.shotId));
      const index = sequence.clips.indexOf(clip);
      if (command.type === 'clip.split') {
        const pieces = splitClip(clip, Number(p.time), String(p.rightId ?? id('clip')));
        sequence.clips.splice(index, 1, ...pieces);
        return pieces;
      }
      const next =
        command.type === 'clip.trim'
          ? trimClip(clip, Number(p.sourceIn), Number(p.sourceOut))
          : retimeClip(
              clip,
              p.retiming as ClipRetiming | null,
              p.fitSourceRange !== false,
              p.cameraTiming as CameraTiming | undefined,
            );
      sequence.clips[index] = next;
      return next;
    }
    case 'project.update':
      Object.assign(project, p);
      return { id: project.id };
    case 'project.settings':
      Object.assign(project.settings, p);
      return project.settings;
    case 'object.create': {
      const object = { ...createObject(p.type as SceneObject['type']), ...p } as SceneObject;
      project.objects.push(object);
      return object;
    }
    case 'object.update':
      return patchEntity(project.objects, p);
    case 'object.delete':
      return deleteObject(project, p.id);
    case 'object.duplicate':
      return duplicateObject(project, p);
    case 'object.keyframe.set': {
      const object = find(project.objects, p.id);
      unlocked(object);
      const keyframe = p.keyframe as ObjectKeyframe;
      return setKeyframe(object.keyframes, { ...keyframe, id: keyframe.id ?? id('keyframe') });
    }
    case 'object.keyframe.delete': {
      const object = find(project.objects, p.id);
      unlocked(object);
      return removeEntity(object.keyframes, p.keyframeId);
    }
    case 'object.group': {
      const objects = (p.ids as string[]).map((entityId) => find(project.objects, entityId));
      objects.forEach((object) => unlocked(object));
      if (new Set(objects.map((object) => object.id)).size !== objects.length)
        throw new DomainError('Group objects must be distinct');
      if (
        objects.some(
          (object) =>
            object.parentId !== objects[0]!.parentId ||
            object.attachment ||
            object.keyframes.some((frame) => frame.attachment),
        )
      )
        throw new DomainError('Group requires unattached sibling objects');
      const group = {
        ...createObject('group', p.name as string | undefined),
        id: String(p.id ?? id('group')),
        parentId: objects[0]!.parentId,
      };
      project.objects.push(group);
      objects.forEach((object) => {
        object.parentId = group.id;
      });
      return group;
    }
    case 'object.align': {
      const objects = (p.ids as string[]).map((entityId) => find(project.objects, entityId));
      objects.forEach((object) => unlocked(object));
      if (new Set(objects.map((object) => object.id)).size !== objects.length)
        throw new DomainError('Alignment objects must be distinct');
      if (
        objects.some(
          (object) =>
            object.parentId !== objects[0]!.parentId ||
            object.attachment ||
            object.keyframes.some((frame) => frame.attachment),
        )
      )
        throw new DomainError('Alignment requires unattached sibling objects');
      const axis = { x: 0, y: 1, z: 2 }[p.axis as 'x' | 'y' | 'z'];
      const values = objects.map((object) => object.position[axis]!);
      const target =
        (p.value as number | undefined) ??
        (p.mode === 'min'
          ? Math.min(...values)
          : p.mode === 'max'
            ? Math.max(...values)
            : (Math.min(...values) + Math.max(...values)) / 2);
      objects.forEach((object) => {
        const delta = target - object.position[axis]!;
        object.position[axis] = target;
        object.keyframes.forEach((frame) => {
          if (frame.position) frame.position[axis] = frame.position[axis]! + delta;
        });
      });
      return objects;
    }
    case 'camera.motion': {
      const camera = find(project.cameras, p.id);
      cameraUnlocked(project, camera);
      const track = cameraTrack(camera, p.aspect as Aspect | undefined);
      track.keyframes = buildCameraMotion(
        project,
        aspectComposition(camera, p.aspect as Aspect | undefined),
        p as CameraMotion,
      );
      return camera;
    }
    case 'camera.create': {
      const camera: ShotCamera = {
        id: id('camera'),
        name: '新摄影机',
        position: [0, 1.7, 5],
        target: [0, 1, 0],
        fov: 45,
        locked: false,
        keyframes: [],
        ...p,
      } as ShotCamera;
      project.cameras.push(camera);
      return camera;
    }
    case 'camera.update': {
      const camera = find(project.cameras, p.id);
      cameraUnlocked(project, camera, p.patch as Record<string, unknown>);
      Object.assign(camera, p.patch);
      return camera;
    }
    case 'camera.delete': {
      if (project.shots.some((shot) => shot.cameraId === p.id))
        throw new DomainError('Camera is referenced by a shot; delete or update the shot first');
      return removeEntity(project.cameras, p.id);
    }
    case 'camera.keyframe.set': {
      const camera = find(project.cameras, p.id);
      cameraUnlocked(project, camera);
      const keyframe = p.keyframe as CameraKeyframe;
      return setKeyframe(cameraTrack(camera, p.aspect as Aspect | undefined).keyframes, {
        ...keyframe,
        id: keyframe.id ?? id('keyframe'),
      });
    }
    case 'camera.keyframe.delete': {
      const camera = find(project.cameras, p.id);
      cameraUnlocked(project, camera);
      return removeEntity(cameraTrack(camera, p.aspect as Aspect | undefined).keyframes, p.keyframeId);
    }
    case 'shot.create': {
      const shot: Shot = {
        id: id('shot'),
        name: '新镜头',
        cameraId: String(p.cameraId),
        sourceIn: 0,
        sourceOut: 3,
        intent: '',
        subjectIds: [],
        hiddenIds: [],
        beatId: null,
        locked: false,
        ...p,
      } as Shot;
      project.shots.push(shot);
      return shot;
    }
    case 'shot.update':
      return patchEntity(project.shots, p);
    case 'shot.delete': {
      const shot = find(project.shots, p.id);
      unlocked(shot);
      for (const sequence of project.sequences) {
        if (sequence.clips.some((clip) => clip.shotId === shot.id)) {
          unlocked(sequence);
          sequence.clips = sequence.clips.filter((clip) => clip.shotId !== shot.id);
        }
      }
      project.notes = project.notes.filter((note) => note.shotId !== shot.id);
      return removeEntity(project.shots, shot.id);
    }
    case 'sequence.create': {
      const sequence: Sequence = {
        id: id('sequence'),
        name: '新方案',
        clips: [],
        locked: false,
        ...p,
      } as Sequence;
      project.sequences.push(sequence);
      return sequence;
    }
    case 'sequence.update':
      return patchEntity(project.sequences, p);
    case 'sequence.duplicate':
      return duplicateSequence(project, p);
    case 'sequence.delete': {
      if (project.sequences.length === 1)
        throw new DomainError('The project must retain at least one sequence');
      const result = removeEntity(project.sequences, p.id);
      if (project.activeSequenceId === p.id) project.activeSequenceId = project.sequences[0]!.id;
      return result;
    }
    case 'beat.create': {
      const beat: Beat = {
        id: id('beat'),
        label: '表演标记',
        time: 0,
        endTime: Number(p.time ?? 0),
        kind: 'action',
        actorId: null,
        text: '',
        notes: '',
        locked: false,
        ...p,
      } as Beat;
      project.beats.push(beat);
      return beat;
    }
    case 'beat.update':
      return patchEntity(project.beats, p);
    case 'beat.delete': {
      const beat = find(project.beats, p.id);
      unlocked(beat);
      project.shots.forEach((shot) => {
        if (
          project.production &&
          (shot.sceneId !== project.production.activeSceneId ||
            shot.performanceId !== project.production.activePerformanceId)
        )
          return;
        if (shot.beatId === beat.id) {
          unlocked(shot);
          shot.beatId = null;
        }
      });
      return removeEntity(project.beats, beat.id);
    }
    case 'audio.create': {
      const audio: AudioClip = {
        id: id('audio'),
        name: '参考对白',
        start: 0,
        sourceIn: 0,
        duration: 3,
        volume: 1,
        muted: false,
        locked: false,
        sync: 'source',
        ...p,
      } as AudioClip;
      project.audio.push(audio);
      return audio;
    }
    case 'audio.update':
      return patchEntity(project.audio, p);
    case 'audio.delete':
      return removeEntity(project.audio, p.id);
    case 'note.create': {
      const note: DirectorNote = { id: id('note'), shotId: null, time: 0, ...p } as DirectorNote;
      project.notes.push(note);
      return note;
    }
    case 'note.delete':
      return removeEntity(project.notes, p.id);
    default:
      if (modelingCommandDefinitions.some((definition) => definition.type === command.type))
        return applyModelingCommand(project, command);
      throw new DomainError(`Unknown command: ${command.type}`);
  }
}

/** Validate the complete result before returning; no input state changes on failure. */
export function applyCommands(
  project: Project,
  commands: Command[],
): { project: Project; results: unknown[] } {
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > 500)
    throw new DomainError('A transaction requires 1 to 500 commands');
  const draft = structuredClone(project);
  const synchronizationTransaction = createSynchronizationTransaction();
  const results: unknown[] = [];
  for (const command of commands) {
    const definition = commandDefinitions.find((item) => item.type === command.type);
    if (!definition) throw new DomainError(`Unknown command: ${command.type}`);
    const payload = definition.schema.parse(command.payload) as Record<string, unknown>;
    const synchronizationSnapshot = captureSynchronization(draft);
    const lightingSnapshot = captureLightingState(draft);
    results.push(structuredClone(mutate(draft, { type: command.type, payload })));
    applySynchronization(draft, synchronizationSnapshot, synchronizationTransaction);
    syncProduction(draft);
    validateLightingLocks(lightingSnapshot, draft);
    const entityIds = [
      ...draft.objects,
      ...draft.cameras,
      ...draft.shots,
      ...draft.sequences,
      ...draft.beats,
      ...draft.audio,
      ...draft.notes,
    ].map((entity) => entity.id);
    if (new Set(entityIds).size !== entityIds.length) throw new DomainError('Duplicate entity ID');
  }
  draft.revision = project.revision + 1;
  draft.updatedAt = new Date().toISOString();
  return { project: validateProject(draft), results };
}
