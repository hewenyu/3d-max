import { createDemoProject, createObject } from '../../shared/project';
import {
  bindShotProduction,
  createScene,
  duplicatePerformance,
  ensureProduction,
  selectProduction,
  syncProduction,
} from '../../shared/production';

export function productionRenderFixture() {
  const project = createDemoProject();
  project.id = 'production-render-fixture';
  project.sceneName = 'First set';
  project.settings.aspect = '16:9';
  const actor = createObject('actor', 'Performer');
  actor.id = 'shared-actor';
  actor.position = [-1.5, 0, 0];
  actor.actor!.action = 'walk';
  actor.keyframes = [
    { id: 'walk-start', time: 0, position: [-1.5, 0, 0], easing: 'linear' },
    { id: 'walk-end', time: 2, position: [-0.5, 0, 0], easing: 'linear' },
  ];
  const box = createObject('box', 'Set marker');
  box.id = 'shared-marker';
  box.position = [0.9, 0, -0.5];
  box.dimensions = [1.3, 1.5, 0.8];
  project.objects = [actor, box];
  project.beats = [];
  project.audio = [];
  project.settings.axisActorIds = [];
  project.cameras = [
    {
      ...project.cameras[0],
      id: 'camera-production',
      position: [0, 2.4, 6.5],
      target: [0, 0.9, 0],
      fov: 43,
      keyframes: [],
    },
  ];
  project.shots = project.shots.slice(0, 3).map((shot, index) => ({
    ...shot,
    id: `shot-${index + 1}`,
    cameraId: 'camera-production',
    sourceIn: 0,
    sourceOut: 2,
    subjectIds: [actor.id],
    hiddenIds: [],
    beatId: null,
  }));
  project.sequences = [
    {
      id: 'sequence-production',
      name: 'Three bindings',
      locked: false,
      clips: project.shots.map((shot, index) => ({
        id: `clip-${index + 1}`,
        shotId: shot.id,
        sourceIn: 0,
        sourceOut: 2,
      })),
    },
  ];
  project.activeSequenceId = 'sequence-production';
  const state = ensureProduction(project);
  const sceneId = state.activeSceneId;
  const takeId = state.activePerformanceId;
  const alternate = duplicatePerformance(project, sceneId, takeId, 'Alternate', 'take-alternate');
  selectProduction(project, sceneId, alternate.id);
  const alternateActor = project.objects[0];
  alternateActor.position = [1.4, 0, 0.8];
  alternateActor.keyframes = [
    { id: 'alternate-start', time: 0, position: [1.4, 0, 0.8], easing: 'linear' },
    { id: 'alternate-end', time: 2, position: [2.9, 0, 0.8], easing: 'linear' },
  ];
  syncProduction(project);
  bindShotProduction(project, 'shot-2', sceneId, alternate.id);
  const second = createScene(project, 'Second set', {
    id: 'scene-second',
    sourceSceneId: sceneId,
    performanceId: 'take-second',
  });
  selectProduction(project, second.id, 'take-second');
  project.objects[1].type = 'cylinder';
  project.objects[1].dimensions = [3, 2.7, 3];
  project.objects[1].position = [0, 0, -0.8];
  project.objects[1].tone = '#66716b';
  project.objects[0].position = [-2, 0, 0];
  project.objects[0].keyframes = [];
  syncProduction(project);
  bindShotProduction(project, 'shot-3', second.id, 'take-second');
  selectProduction(project, sceneId, takeId);
  return project;
}
