import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createObject } from '../shared/project';
import { syncProduction } from '../shared/production';
import { gaitDistance, SceneResourceCache } from '../src/engine/SceneResources';
import type { BuiltObject } from '../src/engine/ObjectFactory';
import { productionRenderFixture } from './fixtures/production-render';

const signal = () => new AbortController().signal;

test('scene resources reuse geometry across takes and revisions without sharing duplicate scene IDs', async () => {
  const project = productionRenderFixture();
  let builds = 0;
  const disposed = new Set<BuiltObject>();
  const cache = new SceneResourceCache(
    async () => {
      builds++;
      return { root: new THREE.Group() };
    },
    (object) => {
      assert.equal(disposed.has(object), false, 'a resource must only be disposed once');
      disposed.add(object);
    },
  );
  const first = (await cache.prepare(project, signal()))!;
  assert.equal(builds, 4);
  const original = first.shots.get('shot-1')!;
  const alternate = first.shots.get('shot-2')!;
  const second = first.shots.get('shot-3')!;
  assert.equal(original.objects.get('shared-actor'), alternate.objects.get('shared-actor'));
  assert.notEqual(original.objects.get('shared-actor'), second.objects.get('shared-actor'));
  assert.equal(original.workspace, true);
  assert.equal(alternate.workspace, false);
  assert.equal(gaitDistance(original.distances.get('shared-actor'), 2, 1), 1);
  assert.equal(gaitDistance(alternate.distances.get('shared-actor'), 2, 1), 1.5);
  project.objects[0].position[0] = -3;
  syncProduction(project);
  const next = (await cache.prepare(project, signal()))!;
  first.release();
  assert.equal(builds, 4);
  assert.equal(disposed.size, 0);
  assert.equal(next.workspace.objects.get('shared-actor'), original.objects.get('shared-actor'));
  next.release();
  assert.equal(disposed.size, 4);
});

test('cancelled and failed preloads preserve live resources and dispose delayed results', async () => {
  const project = productionRenderFixture();
  let resolveSlow!: (object: BuiltObject) => void;
  const disposed: BuiltObject[] = [];
  const cache = new SceneResourceCache(
    async (object) => {
      if (object.name === 'slow')
        return new Promise<BuiltObject>((resolve) => {
          resolveSlow = resolve;
        });
      if (object.name === 'broken') throw new Error('load failed');
      return { root: new THREE.Group() };
    },
    (object) => disposed.push(object),
  );
  const live = (await cache.prepare(project, signal()))!;
  const slow = structuredClone(project);
  slow.objects.push(createObject('box', 'slow'));
  syncProduction(slow);
  const controller = new AbortController();
  const pending = cache.prepare(slow, controller.signal);
  await Promise.resolve();
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(disposed.length, 0);
  const delayed = { root: new THREE.Group() };
  resolveSlow(delayed);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(disposed, [delayed]);
  const broken = structuredClone(project);
  broken.objects.push(createObject('box', 'broken'));
  syncProduction(broken);
  await assert.rejects(cache.prepare(broken, signal()), /load failed/);
  assert.equal(disposed.length, 1);
  live.release();
  assert.equal(disposed.length, 5);
});
