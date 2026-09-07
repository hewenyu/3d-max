import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoProject, createObject } from '../shared/project';
import {
  affectedShots,
  bindShotProduction,
  comparePerformances,
  createScene,
  duplicatePerformance,
  ensureProduction,
  productionPerformance,
  productionScene,
  resolveShotProject,
  selectProduction,
  syncProduction,
  type ProductionProject,
} from '../shared/production';
import { validateProduction } from '../shared/production-schema';
import { validateProject } from '../shared/schema';

test('performance versions isolate initial transforms, keyframes and dialogue while sharing geometry', () => {
  const project: ProductionProject = createDemoProject();
  const state = ensureProduction(project);
  const sceneId = state.activeSceneId;
  const originalTakeId = state.activePerformanceId;
  const actorId = project.objects.find((object) => object.type === 'actor')!.id;
  const originalActor = structuredClone(project.objects.find((object) => object.id === actorId)!);
  const alternate = duplicatePerformance(project, sceneId, originalTakeId, 'Different performance');
  selectProduction(project, sceneId, alternate.id);
  const actor = project.objects.find((object) => object.id === actorId)!;
  actor.position = [10, 0, 3];
  actor.keyframes = [{ id: 'alternate-key', time: 1.25, position: [15, 0, 4] }];
  actor.dimensions = [1, 2.1, 0.9];
  project.beats[0]!.text = 'Alternate dialogue';
  syncProduction(project);
  assert.deepEqual(comparePerformances(project, sceneId, originalTakeId, alternate.id).changedObjectIds, [
    actorId,
  ]);
  assert.equal(comparePerformances(project, sceneId, originalTakeId, alternate.id).beatsChanged, true);
  selectProduction(project, sceneId, originalTakeId);
  const restored = project.objects.find((object) => object.id === actorId)!;
  assert.deepEqual(restored.position, originalActor.position);
  assert.deepEqual(restored.keyframes, originalActor.keyframes);
  assert.deepEqual(restored.dimensions, [1, 2.1, 0.9]);
  assert.notEqual(project.beats[0]!.text, 'Alternate dialogue');
  assert.equal(affectedShots(project, sceneId, originalTakeId).length, project.shots.length);
  assert.equal(affectedShots(project, sceneId, alternate.id).length, 0);
  validateProduction(project, validateProject);
});

test('shots resolve their bound scene and take while a different scene remains active for editing', () => {
  const project: ProductionProject = createDemoProject();
  const state = ensureProduction(project);
  const originalSceneId = state.activeSceneId;
  const originalTakeId = state.activePerformanceId;
  const originalObjects = structuredClone(project.objects);
  const second = createScene(project, 'Second location', { id: 'scene-two', performanceId: 'take-two' });
  selectProduction(project, second.id);
  project.objects.push({
    ...createObject('box', 'Only in scene two'),
    id: 'scene-two-box',
    position: [30, 2, 0],
  });
  syncProduction(project);
  const originalView = resolveShotProject(project, project.shots[0]!);
  assert.deepEqual(originalView.objects, originalObjects);
  assert.equal(project.objects.length, 1);
  const shot = {
    ...structuredClone(project.shots[0]!),
    id: 'second-shot',
    subjectIds: ['scene-two-box'],
    hiddenIds: [],
    beatId: null,
  };
  project.shots.push(shot);
  bindShotProduction(project, shot.id, second.id, second.performances[0]!.id);
  selectProduction(project, originalSceneId, originalTakeId);
  const secondView = resolveShotProject(project, shot);
  assert.equal(secondView.objects[0]!.name, 'Only in scene two');
  assert.deepEqual(secondView.objects[0]!.position, [30, 2, 0]);
  assert.deepEqual(project.objects, originalObjects);
  validateProduction(project, validateProject);
});

test('reused scenes have independent geometry and locked takes refuse animation changes', () => {
  const project: ProductionProject = createDemoProject();
  const state = ensureProduction(project);
  const originalId = state.activeSceneId;
  const reused = createScene(project, 'Reused set', { sourceSceneId: originalId });
  selectProduction(project, reused.id);
  project.objects[0]!.dimensions = [90, 1, 90];
  syncProduction(project);
  selectProduction(project, originalId);
  assert.notDeepEqual(project.objects[0]!.dimensions, [90, 1, 90]);
  const take = productionPerformance(project)!;
  take.locked = true;
  project.objects[0]!.position[0] += 2;
  assert.throws(() => syncProduction(project), /Performance is locked/);
});

test('inactive performances are validated, including attachment cycles and missing references', () => {
  const project: ProductionProject = createDemoProject();
  const state = ensureProduction(project);
  const take = duplicatePerformance(project, state.activeSceneId, state.activePerformanceId, 'Invalid take');
  take.tracks[0]!.attachment = { objectId: take.tracks[0]!.objectId, bone: 'root', offset: [0, 0, 0] };
  assert.throws(() => validateProduction(project, validateProject), /cycle/);
  take.tracks[0]!.attachment = null;
  take.tracks[0]!.objectId = 'missing-object';
  assert.throws(() => validateProduction(project, validateProject), /Invalid performance tracks/);
  assert.equal(productionScene(project)!.id, state.activeSceneId);
});

test('active stored takes and workspace projections are independently validated on import', () => {
  const project = createDemoProject();
  ensureProduction(project);
  const invalidTrack = structuredClone(project);
  invalidTrack.production!.scenes[0].performances[0].tracks[0].attachment = {
    objectId: 'not-in-scene',
    bone: 'root',
    offset: [0, 0, 0],
  };
  assert.throws(() => validateProject(invalidTrack), /Missing attachment target/);
  const invalidBeat = structuredClone(project);
  invalidBeat.production!.scenes[0].performances[0].beats[0].actorId = 'missing-actor';
  assert.throws(() => validateProject(invalidBeat), /actor/);
  const inconsistent = structuredClone(project);
  inconsistent.objects[0].dimensions[0] += 1;
  assert.throws(() => validateProject(inconsistent), /workspace does not match/);
  const valid = validateProject(project);
  assert.deepEqual(valid.objects, project.objects);
});
