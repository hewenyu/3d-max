import { DomainError } from './domain-error';
import { dequal } from 'dequal';
import { protectActorTargets } from './actor-validation';
import type { AudioClip, Beat, Project, ProjectSettings, SceneObject, Shot } from './types';
import type { SynchronizationGroup } from './synchronization';

export type ObjectPerformance = Pick<
  SceneObject,
  | 'position'
  | 'rotation'
  | 'scale'
  | 'visible'
  | 'keyframes'
  | 'actor'
  | 'morph'
  | 'attachment'
  | 'motion'
  | 'physics'
  | 'motionEvents'
  | 'rotationInterpolation'
  | 'effect'
> & { objectId: string };

export interface PerformanceVersion {
  synchronization?: SynchronizationGroup[];
  id: string;
  name: string;
  locked: boolean;
  tracks: ObjectPerformance[];
  beats: Beat[];
  audio: AudioClip[];
}

export interface SceneDefinition {
  lightingPlanId?: string;
  environment?: ProjectSettings['environment'];
  id: string;
  name: string;
  locked: boolean;
  objects: SceneObject[];
  lighting: ProjectSettings['lighting'];
  axisActorIds: string[];
  performances: PerformanceVersion[];
}

export interface StoryScene {
  id: string;
  name: string;
  sceneId: string;
  performanceId: string;
  location: string;
  timeOfDay: string;
  description: string;
}

export interface ProductionState {
  activeSceneId: string;
  activePerformanceId: string;
  scenes: SceneDefinition[];
  storyScenes: StoryScene[];
}

export type ProductionProject = Project & { production?: ProductionState };
export type ProductionShot = Shot & { sceneId?: string; performanceId?: string; storySceneId?: string };

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const copy = <T>(value: T): T => structuredClone(value);
const same = dequal;
const optionalPerformanceFields = [
  'actor',
  'morph',
  'attachment',
  'motion',
  'physics',
  'motionEvents',
  'rotationInterpolation',
  'effect',
] as const;

function trackFor(object: SceneObject): ObjectPerformance {
  const track: ObjectPerformance = {
    objectId: object.id,
    position: object.position,
    rotation: object.rotation,
    scale: object.scale,
    visible: object.visible,
    keyframes: object.keyframes,
  };
  for (const field of optionalPerformanceFields)
    if (object[field] !== undefined) Object.assign(track, { [field]: object[field] });
  return copy(track);
}

function captureTake(project: Project, id: string, name: string, locked = false): PerformanceVersion {
  return {
    ...(project.synchronization !== undefined ? { synchronization: copy(project.synchronization) } : {}),
    id,
    name,
    locked,
    tracks: project.objects.map(trackFor),
    beats: copy(project.beats),
    audio: copy(project.audio),
  };
}

function sceneObject(object: SceneObject, previous?: SceneObject): SceneObject {
  const value = copy(object);
  value.keyframes = [];
  if (previous) {
    value.position = copy(previous.position);
    value.rotation = copy(previous.rotation);
    value.scale = copy(previous.scale);
    value.visible = previous.visible;
    for (const field of optionalPerformanceFields) {
      if (previous[field] !== undefined) Object.assign(value, { [field]: copy(previous[field]) });
      else delete value[field];
    }
  }
  return value;
}

export function productionScene(project: ProductionProject, sceneId?: string): SceneDefinition | undefined {
  const production = project.production;
  return production?.scenes.find((scene) => scene.id === (sceneId ?? production.activeSceneId));
}

export function productionPerformance(
  project: ProductionProject,
  sceneId?: string,
  performanceId?: string,
): PerformanceVersion | undefined {
  const scene = productionScene(project, sceneId);
  const id =
    performanceId ??
    (project.production && scene?.id === project.production.activeSceneId
      ? project.production.activePerformanceId
      : scene?.performances[0]?.id);
  return scene?.performances.find((performance) => performance.id === id);
}

export function ensureProduction(project: ProductionProject): ProductionState {
  if (project.production) return project.production;
  const sceneId = newId('scene');
  const take = captureTake(project, newId('performance'), '表演 A');
  project.production = {
    activeSceneId: sceneId,
    activePerformanceId: take.id,
    scenes: [
      {
        id: sceneId,
        name: project.sceneName || '场景 01',
        locked: false,
        objects: project.objects.map((object) => sceneObject(object)),
        lighting: copy(project.settings.lighting),
        ...(project.settings.lightingPlanId ? { lightingPlanId: project.settings.lightingPlanId } : {}),
        ...(project.settings.environment ? { environment: copy(project.settings.environment) } : {}),
        axisActorIds: [...project.settings.axisActorIds],
        performances: [take],
      },
    ],
    storyScenes: [],
  };
  for (const shot of project.shots as ProductionShot[]) {
    shot.sceneId ??= sceneId;
    shot.performanceId ??= take.id;
  }
  return project.production;
}

function objectsFor(scene: SceneDefinition, take: PerformanceVersion): SceneObject[] {
  const tracks = new Map(take.tracks.map((track) => [track.objectId, track]));
  return scene.objects.map((object) => {
    const track = tracks.get(object.id);
    if (!track) return copy(object);
    const { objectId: _objectId, ...state } = track;
    const base = copy(object);
    for (const field of optionalPerformanceFields) delete base[field];
    return { ...base, ...copy(state) };
  });
}

/** Keep the editable projection in sync while geometry remains shared between takes. */
export function syncProduction(project: ProductionProject): void {
  if (!project.production) return;
  const scene = productionScene(project);
  const take = productionPerformance(project);
  if (!scene || !take) throw new DomainError('Active scene or performance is missing');
  const previous = new Map(scene.objects.map((object) => [object.id, object]));
  const objects = project.objects.map((object) => sceneObject(object, previous.get(object.id)));
  const captured = captureTake(project, take.id, take.name, take.locked);
  const geometryChanged =
    !same(scene.objects, objects) ||
    !same(scene.lighting, project.settings.lighting) ||
    scene.lightingPlanId !== project.settings.lightingPlanId ||
    !same(scene.environment, project.settings.environment);
  if (scene.locked && geometryChanged) throw new DomainError(`Scene is locked: ${scene.id}`);
  if (take.locked && !same(take, captured)) throw new DomainError(`Performance is locked: ${take.id}`);
  const present = new Set(objects.map((object) => object.id));
  for (const other of scene.performances) {
    if (other.id === take.id) continue;
    const removed = other.tracks.filter((track) => !present.has(track.objectId));
    if (other.locked && removed.length)
      throw new DomainError(`Object is used by locked performance: ${other.id}`);
    other.tracks = other.tracks.filter((track) => present.has(track.objectId));
    for (const track of other.tracks) {
      protectActorTargets(
        { id: track.objectId, actor: track.actor },
        new Set(removed.map((item) => item.objectId)),
      );
      if (track.attachment && !present.has(track.attachment.objectId))
        throw new DomainError(`Object is attached in performance: ${other.id}`);
      if (track.actor?.lookAtId && !present.has(track.actor.lookAtId)) {
        if (other.locked) throw new DomainError(`Look target is used by locked performance: ${other.id}`);
        track.actor.lookAtId = null;
      }
      for (const frame of track.keyframes) {
        if (frame.attachment && !present.has(frame.attachment.objectId))
          throw new DomainError(`Object is attached in performance keyframe: ${other.id}`);
        if (frame.lookAtId && !present.has(frame.lookAtId)) {
          if (other.locked) throw new DomainError(`Look target is used by locked performance: ${other.id}`);
          frame.lookAtId = null;
        }
      }
    }
    other.beats.forEach((beat) => {
      if (beat.actorId && !present.has(beat.actorId)) {
        if (other.locked || beat.locked) throw new DomainError(`Object is used by locked beat: ${beat.id}`);
        beat.actorId = null;
      }
    });
  }
  scene.name = project.sceneName;
  scene.objects = objects;
  scene.lighting = copy(project.settings.lighting);
  if (project.settings.lightingPlanId) scene.lightingPlanId = project.settings.lightingPlanId;
  else delete scene.lightingPlanId;
  if (project.settings.environment) scene.environment = copy(project.settings.environment);
  else delete scene.environment;
  scene.axisActorIds = [...project.settings.axisActorIds];
  Object.assign(take, captured);
  if (captured.synchronization === undefined) delete take.synchronization;
  for (const shot of project.shots as ProductionShot[]) {
    shot.sceneId ??= scene.id;
    shot.performanceId ??=
      shot.sceneId === scene.id ? take.id : productionScene(project, shot.sceneId)?.performances[0]?.id;
  }
}

export function selectProduction(project: ProductionProject, sceneId: string, performanceId?: string): void {
  const production = ensureProduction(project);
  syncProduction(project);
  const scene = productionScene(project, sceneId);
  const take = scene?.performances.find((item) => item.id === (performanceId ?? scene.performances[0]?.id));
  if (!scene || !take) throw new DomainError('Scene or performance does not exist');
  production.activeSceneId = scene.id;
  production.activePerformanceId = take.id;
  project.sceneName = scene.name;
  project.objects = objectsFor(scene, take);
  project.beats = copy(take.beats);
  project.audio = copy(take.audio);
  if (take.synchronization !== undefined) project.synchronization = copy(take.synchronization);
  else delete project.synchronization;
  project.settings.lighting = copy(scene.lighting);
  if (scene.lightingPlanId) project.settings.lightingPlanId = scene.lightingPlanId;
  else delete project.settings.lightingPlanId;
  if (scene.environment) project.settings.environment = copy(scene.environment);
  else delete project.settings.environment;
  project.settings.axisActorIds = [...scene.axisActorIds];
}

export function createScene(
  project: ProductionProject,
  name: string,
  options: { id?: string; sourceSceneId?: string; performanceId?: string } = {},
): SceneDefinition {
  const production = ensureProduction(project);
  syncProduction(project);
  const source = options.sourceSceneId ? productionScene(project, options.sourceSceneId) : undefined;
  if (options.sourceSceneId && !source) throw new DomainError('Source scene does not exist');
  const sceneId = options.id ?? newId('scene');
  if (production.scenes.some((scene) => scene.id === sceneId))
    throw new DomainError('Scene ID already exists');
  const scene: SceneDefinition = source
    ? {
        ...copy(source),
        id: sceneId,
        name,
        locked: false,
        performances: source.performances.map((take, index) => ({
          ...copy(take),
          id: index === 0 ? (options.performanceId ?? newId('performance')) : newId('performance'),
          locked: false,
        })),
      }
    : {
        id: sceneId,
        name,
        locked: false,
        objects: [],
        lighting: copy(project.settings.lighting),
        ...(project.settings.environment ? { environment: copy(project.settings.environment) } : {}),
        axisActorIds: [],
        performances: [
          {
            id: options.performanceId ?? newId('performance'),
            name: '表演 A',
            locked: false,
            tracks: [],
            beats: [],
            audio: [],
          },
        ],
      };
  production.scenes.push(scene);
  return scene;
}

export function duplicatePerformance(
  project: ProductionProject,
  sceneId: string,
  performanceId: string,
  name: string,
  id = newId('performance'),
): PerformanceVersion {
  ensureProduction(project);
  syncProduction(project);
  const scene = productionScene(project, sceneId);
  const source = scene?.performances.find((take) => take.id === performanceId);
  if (!scene || !source) throw new DomainError('Source performance does not exist');
  if (scene.locked) throw new DomainError(`Scene is locked: ${scene.id}`);
  if (project.production!.scenes.some((item) => item.performances.some((take) => take.id === id)))
    throw new DomainError('Performance ID already exists');
  const take = { ...copy(source), id, name, locked: false };
  scene.performances.push(take);
  return take;
}

export function bindShotProduction(
  project: ProductionProject,
  shotId: string,
  sceneId: string,
  performanceId: string,
): ProductionShot {
  ensureProduction(project);
  const shot = (project.shots as ProductionShot[]).find((item) => item.id === shotId);
  const take = productionPerformance(project, sceneId, performanceId);
  if (!shot || !take) throw new DomainError('Shot, scene or performance does not exist');
  if (shot.locked) throw new DomainError(`Shot is locked: ${shot.id}`);
  const objectIds = new Set(productionScene(project, sceneId)!.objects.map((object) => object.id));
  if ([...shot.subjectIds, ...shot.hiddenIds].some((id) => !objectIds.has(id)))
    throw new DomainError('Shot subjects must exist in the bound scene');
  if (shot.beatId && !take.beats.some((beat) => beat.id === shot.beatId))
    throw new DomainError('Shot beat must exist in the bound performance');
  shot.sceneId = sceneId;
  shot.performanceId = performanceId;
  delete shot.storySceneId;
  return shot;
}

export function resolveShotProject(
  project: ProductionProject,
  shot: ProductionShot | null,
  options: { useStoredPerformance?: boolean } = {},
): Project {
  if (!project.production || !shot?.sceneId) return project;
  const scene = productionScene(project, shot.sceneId);
  const take = productionPerformance(project, shot.sceneId, shot.performanceId);
  if (!scene || !take) throw new DomainError('Shot references a missing scene or performance');
  if (
    !options.useStoredPerformance &&
    scene.id === project.production.activeSceneId &&
    take.id === project.production.activePerformanceId
  )
    return project;
  return {
    ...project,
    sceneName: scene.name,
    objects: objectsFor(scene, take),
    beats: copy(take.beats),
    audio: copy(take.audio),
    synchronization: copy(take.synchronization),
    settings: {
      ...project.settings,
      lighting: copy(scene.lighting),
      lightingPlanId: scene.lightingPlanId,
      environment: copy(scene.environment),
      axisActorIds: [...scene.axisActorIds],
    },
  };
}

export function affectedShots(
  project: ProductionProject,
  sceneId: string,
  performanceId?: string,
): ProductionShot[] {
  return (project.shots as ProductionShot[]).filter(
    (shot) => shot.sceneId === sceneId && (!performanceId || shot.performanceId === performanceId),
  );
}

export function comparePerformances(
  project: ProductionProject,
  sceneId: string,
  leftId: string,
  rightId: string,
) {
  const left = productionPerformance(project, sceneId, leftId);
  const right = productionPerformance(project, sceneId, rightId);
  if (!left || !right) throw new DomainError('Comparison performance does not exist');
  const rightTracks = new Map(right.tracks.map((track) => [track.objectId, track]));
  const leftIds = new Set(left.tracks.map((track) => track.objectId));
  return {
    changedObjectIds: left.tracks
      .filter((track) => !same(track, rightTracks.get(track.objectId)))
      .map((track) => track.objectId),
    addedObjectIds: right.tracks
      .filter((track) => !leftIds.has(track.objectId))
      .map((track) => track.objectId),
    beatsChanged: !same(left.beats, right.beats),
    audioChanged: !same(left.audio, right.audio),
    synchronizationChanged: !same(left.synchronization ?? [], right.synchronization ?? []),
  };
}
