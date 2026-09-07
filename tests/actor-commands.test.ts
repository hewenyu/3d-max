import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommands, validateProject } from '../shared/commands';
import { createEmptyProject } from '../shared/project';
import { resolveShotProject } from '../shared/production';
import type { Project } from '../shared/types';

function fixture(): Project {
  return applyCommands(createEmptyProject(), [
    { type: 'object.create', payload: { type: 'group', id: 'pair' } },
    { type: 'object.create', payload: { type: 'actor', id: 'actor', parentId: 'pair' } },
    { type: 'object.create', payload: { type: 'box', id: 'prop', parentId: 'pair' } },
    {
      type: 'actor.clip.set',
      payload: { id: 'actor', clip: { id: 'punch', action: 'punch', start: 1, end: 2 } },
    },
    {
      type: 'actor.constraint.set',
      payload: {
        id: 'actor',
        constraint: {
          id: 'contact',
          effector: 'rightHand',
          start: 1.3,
          end: 1.5,
          target: { kind: 'object', objectId: 'prop', offset: [0, 0.1, 0] },
        },
      },
    },
  ]).project;
}

test('action commands preserve editable defaults, joint channels, and atomic validation', () => {
  const project = fixture();
  const animation = project.objects.find((object) => object.id === 'actor')!.actor!.animation!;
  assert.equal(animation.clips[0]!.speed, 1);
  assert.equal(animation.constraints[0]!.tolerance, 0.02);
  const before = structuredClone(project);
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'project.update', payload: { name: 'Must roll back' } },
        {
          type: 'actor.clip.set',
          payload: { id: 'actor', clip: { id: 'bad', action: 'kick', start: 5, end: 4 } },
        },
      ]),
    /End must follow start/,
  );
  assert.deepEqual(project, before);
  const keyed = applyCommands(project, [
    {
      type: 'actor.joint-key.set',
      payload: {
        id: 'actor',
        keyframe: { id: 'elbow', joint: 'rightElbow', time: 1.4, rotation: [-90, 0, 0] },
      },
    },
    {
      type: 'actor.joint-key.set',
      payload: { id: 'actor', keyframe: { id: 'knee', joint: 'leftKnee', time: 1.4, rotation: [30, 0, 0] } },
    },
  ]).project;
  assert.equal(keyed.objects.find((object) => object.id === 'actor')!.actor!.animation!.jointKeys.length, 2);
  assert.throws(
    () =>
      applyCommands(keyed, [
        {
          type: 'actor.joint-key.set',
          payload: {
            id: 'actor',
            keyframe: { id: 'other', joint: 'rightElbow', time: 1.4, rotation: [0, 0, 0] },
          },
        },
      ]),
    /already exists/,
  );
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(keyed))), keyed);
});

test('IK targets prevent orphan deletion and duplicate hierarchies remap internal targets', () => {
  const project = fixture();
  assert.throws(
    () => applyCommands(project, [{ type: 'object.delete', payload: { id: 'prop' } }]),
    /Remove IK constraint contact/,
  );
  assert.throws(
    () =>
      applyCommands(project, [
        {
          type: 'actor.constraint.set',
          payload: {
            id: 'actor',
            constraint: {
              id: 'missing',
              effector: 'leftHand',
              start: 0,
              end: 1,
              target: { kind: 'object', objectId: 'missing' },
            },
          },
        },
      ]),
    /Missing IK target/,
  );
  assert.throws(
    () =>
      applyCommands(project, [
        {
          type: 'actor.constraint.set',
          payload: {
            id: 'actor',
            constraint: {
              id: 'bone',
              effector: 'leftHand',
              start: 0,
              end: 1,
              target: { kind: 'object', objectId: 'prop', bone: 'head' },
            },
          },
        },
      ]),
    /requires an actor/,
  );
  const copied = applyCommands(project, [
    { type: 'object.duplicate', payload: { id: 'pair', newId: 'pair-copy' } },
  ]).project;
  const children = copied.objects.filter((object) => object.parentId === 'pair-copy');
  const actor = children.find((object) => object.type === 'actor')!;
  const prop = children.find((object) => object.type === 'box')!;
  const target = actor.actor!.animation!.constraints[0]!.target;
  assert.equal(target.kind === 'object' && target.objectId, prop.id);
  const deleted = applyCommands(project, [
    { type: 'actor.constraint.delete', payload: { id: 'actor', itemId: 'contact' } },
    { type: 'object.delete', payload: { id: 'prop' } },
  ]).project;
  assert.ok(!deleted.objects.some((object) => object.id === 'prop'));
});

test('actor tracks remain independent across takes and inactive constraints protect shared geometry', () => {
  let project = applyCommands(fixture(), [{ type: 'production.initialize', payload: {} }]).project;
  const sceneId = project.production!.activeSceneId;
  const takeId = project.production!.activePerformanceId;
  project = applyCommands(project, [
    { type: 'performance.duplicate', payload: { sceneId, id: takeId, newId: 'take-b', name: 'Alternate' } },
  ]).project;
  project = applyCommands(project, [
    {
      type: 'actor.clip.set',
      payload: { id: 'actor', clip: { id: 'punch', action: 'block', start: 2, end: 3 } },
    },
    { type: 'actor.constraint.delete', payload: { id: 'actor', itemId: 'contact' } },
  ]).project;
  const original = resolveShotProject(project, {
    sceneId,
    performanceId: takeId,
  } as Project['shots'][number]);
  assert.equal(
    original.objects.find((object) => object.id === 'actor')!.actor!.animation!.clips[0]!.action,
    'punch',
  );
  assert.throws(
    () => applyCommands(project, [{ type: 'object.delete', payload: { id: 'prop' } }]),
    /Remove IK constraint contact/,
  );
  project = applyCommands(project, [
    { type: 'performance.update', payload: { sceneId, id: 'take-b', patch: { locked: true } } },
  ]).project;
  assert.throws(
    () => applyCommands(project, [{ type: 'actor.clip.delete', payload: { id: 'actor', itemId: 'punch' } }]),
    /Performance is locked/,
  );
  const invalid = structuredClone(project);
  const target = invalid.production!.scenes[0]!.performances[0]!.tracks.find(
    (track) => track.objectId === 'actor',
  )!.actor!.animation!.constraints[0]!.target;
  if (target.kind === 'object') target.objectId = 'unavailable';
  assert.throws(() => validateProject(invalid), /Missing IK target/);
});
