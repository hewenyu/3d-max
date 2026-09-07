import { createEmptyProject, createObject } from '../../shared/project';
import {
  bindShotProduction,
  createScene,
  ensureProduction,
  selectProduction,
  syncProduction,
} from '../../shared/production';
import { validateProject } from '../../shared/schema';

export function transitionFixture() {
  const project = createEmptyProject('Transition verification');
  project.settings.aspect = '16:9';
  project.settings.environment = { ground: false, background: '#dde9e1', groundTone: '#d1d7d3' };
  const marker = createObject('box', 'Moving foreground');
  marker.id = 'marker';
  marker.dimensions = [1, 1.6, 1];
  marker.position = [-1, 0, 0];
  marker.tone = '#546258';
  marker.keyframes = [{ id: 'move', time: 6, position: [1, 0, 0], easing: 'linear' }];
  project.objects = [marker];
  project.cameras = [
    {
      id: 'camera',
      name: 'Frontal',
      position: [0, 1, 6],
      target: [0, 1, 0],
      fov: 42,
      locked: false,
      keyframes: [],
      optics: {
        enabled: true,
        focusDistance: 5,
        focusTargetId: null,
        fStop: 2.8,
        sensorWidthMm: 36,
        keyframes: [],
      },
    },
  ];
  project.shots = [1, 2].map((number) => ({
    id: `shot-${number}`,
    name: `Shot ${number}`,
    cameraId: 'camera',
    sourceIn: 0,
    sourceOut: 6,
    intent: '',
    subjectIds: ['marker'],
    hiddenIds: [],
    beatId: null,
    locked: false,
  }));
  project.sequences[0].clips = [
    { id: 'clip-1', shotId: 'shot-1', sourceIn: 1, sourceOut: 5, fadeIn: 1 },
    {
      id: 'clip-2',
      shotId: 'shot-2',
      sourceIn: 1,
      sourceOut: 5,
      transitionIn: { type: 'dissolve', duration: 1 },
      fadeOut: 1,
    },
  ];
  const production = ensureProduction(project);
  const first = production.activeSceneId;
  const firstTake = production.activePerformanceId;
  const second = createScene(project, 'Second set', {
    id: 'scene-second',
    sourceSceneId: first,
    performanceId: 'take-second',
  });
  selectProduction(project, second.id, 'take-second');
  project.objects[0].type = 'sphere';
  project.objects[0].dimensions = [1.8, 1.8, 1.8];
  project.objects[0].tone = '#b3bcc4';
  project.objects[0].position = [1, 0, 0];
  project.objects[0].keyframes = [{ id: 'other-move', time: 6, position: [-1, 0, 0], easing: 'linear' }];
  project.settings.environment = { ground: false, background: '#1b2834', groundTone: '#d1d7d3' };
  syncProduction(project);
  bindShotProduction(project, 'shot-2', second.id, 'take-second');
  selectProduction(project, first, firstTake);
  return validateProject(project);
}
