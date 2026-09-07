import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { applyCommands } from '../shared/commands';
import { createEmptyProject, createObject } from '../shared/project';
import { transitionFixture } from './fixtures/transitions';
import type { Project } from '../shared/types';

function fixture() {
  const project = createEmptyProject('Presets');
  const tower = createObject('box', 'Landmark');
  tower.id = 'tower';
  tower.dimensions = [80, 160, 60];
  tower.position = [300, 0, -80];
  project.objects = [tower];
  project.cameras = [
    {
      id: 'camera',
      name: 'Preset camera',
      position: [0, 3, 8],
      target: [0, 1, 0],
      fov: 40,
      keyframes: [],
      locked: false,
    },
  ];
  project.shots = [
    {
      id: 'shot',
      name: 'Landmark shot',
      cameraId: 'camera',
      sourceIn: 0,
      sourceOut: 10,
      subjectIds: ['tower'],
      hiddenIds: [],
      intent: '',
      beatId: null,
      locked: false,
    },
  ];
  return project;
}
function preset(project: Project, extra: Record<string, unknown>) {
  return applyCommands(project, [
    { type: 'camera.preset', payload: { id: 'camera', shotId: 'shot', preset: 'wide', ...extra } },
  ]);
}
test('wide presets fit a 160m landmark across landscape, portrait and square with scale-aware editable positions', () => {
  for (const aspect of ['16:9', '9:16', '1:1'] as const) {
    const project = fixture();
    const result = preset(project, { aspect });
    const camera = result.project.cameras[0].compositions![aspect]!;
    assert.deepEqual(result.project.cameras[0].position, project.cameras[0].position);
    const lens = new PerspectiveCamera(
      camera.fov,
      aspect === '16:9' ? 16 / 9 : aspect === '9:16' ? 9 / 16 : 1,
      0.025,
      2000,
    );
    lens.position.fromArray(camera.position);
    lens.lookAt(new Vector3(...camera.target));
    lens.updateMatrixWorld(true);
    for (const x of [260, 340])
      for (const y of [0, 160])
        for (const z of [-110, -50]) {
          const point = new Vector3(x, y, z).project(lens);
          assert.ok(
            Math.abs(point.x) < 0.85 && Math.abs(point.y) < 0.85 && point.z < 1,
            JSON.stringify(point),
          );
        }
    const farther = preset(project, { aspect, preset: 'extreme_wide' }).project.cameras[0].compositions![
      aspect
    ]!;
    assert.ok(
      new Vector3(...farther.position).distanceTo(new Vector3(...farther.target)) >
        new Vector3(...camera.position).distanceTo(new Vector3(...camera.target)) * 1.35,
    );
  }
});
test('dual-subject and shoulder presets use animated world bounds and preserve independent key times', () => {
  const project = fixture();
  const first = createObject('actor', 'Foreground');
  first.id = 'first';
  first.position = [-2, 0, 0];
  const second = createObject('actor', 'Background');
  second.id = 'second';
  second.position = [2, 0, 0];
  second.keyframes = [{ id: 'moving', time: 4, position: [10, 0, 0], easing: 'linear' }];
  project.objects = [first, second];
  project.shots[0].subjectIds = ['first', 'second'];
  const pair = preset(project, {
    preset: 'two_shot',
    sourceTime: 4,
    cameraTime: 1,
    mode: 'keyframe',
    aspect: '9:16',
  });
  const frame = pair.project.cameras[0].compositions!['9:16']!.keyframes[0];
  assert.equal(frame.time, 1);
  assert.ok(frame.target[0] > 3.8 && frame.target[0] < 4.2);
  assert.deepEqual(pair.project.cameras[0].keyframes, []);
  const left = preset(project, { preset: 'over_shoulder', sourceTime: 4, side: 'left' }).project.cameras[0];
  const right = preset(project, { preset: 'over_shoulder', sourceTime: 4, side: 'right' }).project.cameras[0];
  assert.ok(left.target[0] > 9.5 && left.position[0] < -2);
  assert.ok(left.position[2] * right.position[2] < 0);
  assert.throws(() => preset(project, { preset: 'over_shoulder', subjectIds: ['first'] }), /exactly two/);
  assert.throws(() => preset(project, { subjectIds: ['missing'] }), /absent/);
});
test('presets resolve a bound inactive scene, respect locks and reject ambiguous shared cameras', () => {
  const project = transitionFixture();
  assert.throws(
    () => applyCommands(project, [{ type: 'camera.preset', payload: { id: 'camera', preset: 'wide' } }]),
    /Specify shotId/,
  );
  const result = applyCommands(project, [
    { type: 'camera.preset', payload: { id: 'camera', shotId: 'shot-2', preset: 'wide', sourceTime: 0 } },
  ]);
  assert.equal(result.project.cameras[0].target[0], 1);
  project.shots[0].locked = true;
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'camera.preset', payload: { id: 'camera', shotId: 'shot-2', preset: 'wide' } },
      ]),
    /locked/,
  );
});
