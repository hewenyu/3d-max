import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCommands, validateProject } from '../shared/commands';
import { createDemoProject } from '../shared/project';
import { resolveShotProject } from '../shared/production';
import { Store } from '../server/store';

test('public commands build a cross-scene sequence and restore its scene and performance independently', () => {
  let project = applyCommands(createDemoProject(), [{ type: 'production.initialize', payload: {} }]).project;
  const originalSceneId = project.production!.activeSceneId;
  const originalTakeId = project.production!.activePerformanceId;
  const originalObjects = structuredClone(project.objects);
  project = applyCommands(project, [
    { type: 'scene.create', payload: { id: 'set-b', performanceId: 'take-b', name: 'Second set' } },
    {
      type: 'object.create',
      payload: { id: 'second-set-object', type: 'box', name: 'Second set box', position: [20, 0, 0] },
    },
    { type: 'camera.create', payload: { id: 'camera-b', position: [20, 3, 6], target: [20, 1, 0] } },
    {
      type: 'shot.create',
      payload: { id: 'shot-b', cameraId: 'camera-b', sourceOut: 2, subjectIds: ['second-set-object'] },
    },
    {
      type: 'sequence.update',
      payload: {
        id: project.activeSequenceId,
        patch: {
          clips: [
            ...project.sequences[0]!.clips,
            { id: 'clip-b', shotId: 'shot-b', sourceIn: 0, sourceOut: 2 },
          ],
        },
      },
    },
  ]).project;
  assert.equal(project.shots.find((shot) => shot.id === 'shot-b')!.sceneId, 'set-b');
  assert.deepEqual(resolveShotProject(project, project.shots[0]!).objects, originalObjects);
  project = applyCommands(project, [
    { type: 'scene.select', payload: { sceneId: originalSceneId, performanceId: originalTakeId } },
  ]).project;
  assert.deepEqual(project.objects, originalObjects);
  assert.equal(
    resolveShotProject(
      project,
      project.shots.find((shot) => shot.id === 'shot-b')!,
    ).objects[0]!.id,
    'second-set-object',
  );
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
});

test('locked performance changes roll back atomically and reused scenes retain unrelated shot bindings', () => {
  let project = applyCommands(createDemoProject(), [{ type: 'production.initialize', payload: {} }]).project;
  const sceneId = project.production!.activeSceneId;
  const originalTakeId = project.production!.activePerformanceId;
  const objectId = project.objects.find((object) => object.type === 'actor' && !object.locked)!.id;
  project = applyCommands(project, [
    {
      type: 'performance.duplicate',
      payload: { sceneId, id: originalTakeId, name: 'Alternate', newId: 'alternate-take' },
    },
  ]).project;
  project = applyCommands(project, [
    { type: 'performance.update', payload: { sceneId, id: 'alternate-take', patch: { locked: true } } },
  ]).project;
  const before = structuredClone(project);
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'project.update', payload: { name: 'Should roll back' } },
        {
          type: 'object.keyframe.set',
          payload: { id: objectId, keyframe: { time: 0.125, position: [5, 0, 0] } },
        },
      ]),
    /Performance is locked/,
  );
  assert.deepEqual(project, before);
  assert.equal(project.shots[0]!.performanceId, originalTakeId);
  assert.throws(
    () => applyCommands(project, [{ type: 'scene.delete', payload: { id: sceneId } }]),
    /at least one/,
  );
});

test('SQLite rejects stale scene context and restores cross-scene assets/history on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-production-'));
  let store = new Store(directory);
  try {
    store.commands({ commands: [{ type: 'production.initialize', payload: {} }] });
    const first = store.project();
    const context = {
      sceneId: first.production!.activeSceneId,
      performanceId: first.production!.activePerformanceId,
    };
    store.commands({
      expectedContext: context,
      commands: [
        { type: 'scene.create', payload: { id: 'new-scene', performanceId: 'new-take', name: 'New scene' } },
      ],
    });
    assert.throws(
      () =>
        store.commands({
          expectedContext: context,
          commands: [{ type: 'object.create', payload: { type: 'box' } }],
        }),
      (error: unknown) => (error as { code: string }).code === 'CONTEXT_CONFLICT',
    );
    assert.equal(store.project().objects.length, 0);
    const snapshot = store.project();
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.project(), snapshot);
    store.travel(-1);
    assert.equal(store.project().production!.activeSceneId, context.sceneId);
    const badAssetProject = structuredClone(store.project());
    badAssetProject.production!.scenes[0]!.objects[0]!.assetUrl = '/api/assets/unknown/file';
    assert.throws(() => store.assertAssets(badAssetProject), /unavailable local asset/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
