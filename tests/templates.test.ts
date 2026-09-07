import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCommands } from '../shared/commands';
import { createDemoProject, createEmptyProject } from '../shared/project';
import { captureTemplate } from '../shared/templates';
import { resolveShotProject } from '../shared/production';
import { Store } from '../server/store';
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
  updateTemplate,
} from '../server/template-service';
import type { Project } from '../shared/types';

function sourceProject() {
  const demo = createDemoProject();
  return applyCommands(demo, [
    {
      type: 'actor.clip.set',
      payload: { id: 'actor-a', clip: { id: 'attack', action: 'punch', start: 1, end: 2 } },
    },
    {
      type: 'sync.group.set',
      payload: {
        group: {
          id: 'attack-cue',
          name: 'Dialogue attack cue',
          members: [
            { kind: 'actor-clip', objectId: 'actor-a', id: 'attack', anchor: 'start' },
            { kind: 'beat', id: demo.beats[0].id, anchor: 'end' },
          ],
        },
      },
    },
    { type: 'production.initialize', payload: {} },
  ]).project;
}

test('object templates include attachment/gaze dependencies and instantiate independently with atomic locks', () => {
  const source = sourceProject();
  const before = structuredClone(source);
  const template = captureTemplate(source, {
    name: 'Phone interaction',
    kind: 'objects',
    objectIds: ['phone'],
  });
  assert.deepEqual(
    new Set(template.project.objects.map((object) => object.id)),
    new Set(['phone', 'actor-a', 'actor-b']),
  );
  assert.equal(template.project.production, undefined);
  assert.equal(template.project.synchronization, undefined);
  assert.deepEqual(source, before);
  const first = applyCommands(createEmptyProject(), [
    { type: 'template.instantiate', payload: { template } },
  ]);
  const second = applyCommands(first.project, [{ type: 'template.instantiate', payload: { template } }]);
  assert.equal(second.project.objects.length, 8);
  const firstIds = new Set(first.project.objects.map((object) => object.id));
  const newObjects = second.project.objects.filter((object) => !firstIds.has(object.id));
  const phone = newObjects.find((object) => object.type === 'phone')!;
  const owner = newObjects.find((object) => object.id === phone.attachment!.objectId)!;
  assert.equal(owner.name, source.objects.find((object) => object.id === 'actor-b')!.name);
  assert.ok(
    newObjects.some((object) => object.id === owner.keyframes.find((frame) => frame.lookAtId)!.lookAtId),
  );
  assert.ok(!source.objects.some((object) => object.id === phone.id));
  const changed = applyCommands(second.project, [
    { type: 'object.update', payload: { id: phone.id, patch: { dimensions: [0.2, 0.3, 0.02] } } },
  ]).project;
  assert.deepEqual(
    changed.objects.filter((object) => firstIds.has(object.id)),
    first.project.objects,
  );
  assert.deepEqual(source, before);
  const initialized = applyCommands(changed, [{ type: 'production.initialize', payload: {} }]).project;
  const locked = applyCommands(initialized, [
    {
      type: 'performance.update',
      payload: {
        sceneId: initialized.production!.activeSceneId,
        id: initialized.production!.activePerformanceId,
        patch: { locked: true },
      },
    },
  ]).project;
  const lockedBefore = structuredClone(locked);
  assert.throws(
    () => applyCommands(locked, [{ type: 'template.instantiate', payload: { template } }]),
    /Performance is locked/,
  );
  assert.deepEqual(locked, lockedBefore);
});

test('scene templates retain cameras, edits and timing while new scenes and imported takes stay independent', () => {
  const source = sourceProject();
  const template = captureTemplate(source, { name: 'Living room coverage', kind: 'scene' });
  const instantiate = (project: Project) =>
    applyCommands(project, [{ type: 'template.instantiate', payload: { template } }]).project;
  const first = instantiate(createEmptyProject('Target'));
  const firstShot = first.shots[0];
  const firstView = structuredClone(resolveShotProject(first, firstShot));
  const second = instantiate(first);
  assert.equal(second.production!.scenes.length, 3);
  assert.equal(second.shots.length, source.shots.length * 2);
  assert.equal(second.cameras.length, source.cameras.length * 2);
  const group = second.synchronization![0];
  const actorRef = group.members.find((member) => member.kind === 'actor-clip')!;
  const beatRef = group.members.find((member) => member.kind === 'beat')!;
  assert.ok('objectId' in actorRef);
  const actorId = actorRef.objectId;
  assert.ok(second.objects.some((object) => object.id === actorId));
  assert.ok('id' in beatRef && second.beats.some((beat) => beat.id === beatRef.id));
  const changed = applyCommands(second, [
    {
      type: 'actor.clip.set',
      payload: {
        id: actorId,
        clip: { id: 'attack', action: 'punch', start: 2, end: 3 },
      },
    },
  ]).project;
  assert.deepEqual(resolveShotProject(changed, firstShot).objects, firstView.objects);
  assert.deepEqual(resolveShotProject(changed, firstShot).beats, firstView.beats);
  assert.equal(changed.beats[0].time, second.beats[0].time + 1);
  assert.notEqual(changed.activeSequenceId, first.activeSequenceId);
  assert.deepEqual(template.project.objects, source.objects);
});

test('SQLite template library survives restart, rejects stale captures and revisions, and preserves copies after deletion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteframe-templates-'));
  let store = new Store(directory);
  try {
    const project = store.newProject('Library source', 'demo');
    const input = {
      projectId: project.id,
      expectedRevision: project.revision,
      requestId: 'save-once',
      kind: 'scene',
      name: 'Reusable scene',
    };
    const saved = saveTemplate(store, input);
    assert.deepEqual(saveTemplate(store, input), saved);
    assert.throws(() => saveTemplate(store, { ...input, name: 'Different' }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(listTemplates(store).length, 1);
    store.close();
    store = new Store(directory);
    assert.equal(getTemplate(store, saved.id).content.project.objects.length, project.objects.length);
    const revision = updateTemplate(store, {
      id: saved.id,
      expectedRevision: saved.revision,
      name: 'Renamed',
      description: 'Director set',
    });
    assert.equal(revision.revision, 1);
    assert.throws(
      () => updateTemplate(store, { id: saved.id, expectedRevision: 0, name: 'Stale', description: '' }),
      { code: 'REVISION_CONFLICT' },
    );
    const target = store.newProject('New project', 'empty');
    assert.throws(() => saveTemplate(store, { ...input, requestId: 'wrong-project' }), {
      code: 'PROJECT_CONFLICT',
    });
    const result = store.commands({
      projectId: target.id,
      requestId: 'place-once',
      commands: [
        {
          type: 'template.instantiate',
          payload: { template: getTemplate(store, saved.id).content },
        },
      ],
    });
    assert.equal(result.project.objects.length, project.objects.length);
    deleteTemplate(store, { id: saved.id });
    assert.deepEqual(listTemplates(store), []);
    assert.deepEqual(store.project(), result.project);
    assert.equal(store.travel(-1).objects.length, 0);
    assert.equal(store.travel(1).objects.length, project.objects.length);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
