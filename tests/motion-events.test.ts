import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommands } from '../shared/commands';
import { createEmptyProject, createObject } from '../shared/project';
import { motionEventSchema } from '../shared/motion';
import {
  ensureProduction,
  duplicatePerformance,
  selectProduction,
  syncProduction,
} from '../shared/production';

function fixture() {
  const project = createEmptyProject('Events');
  const object = createObject('box');
  object.id = 'source';
  const target = createObject('box');
  target.id = 'target';
  object.keyframes = [{ id: 'key', time: 2, position: [1, 0, 0] }];
  project.objects = [object, target];
  return project;
}
const event = motionEventSchema.parse({
  id: 'event',
  time: 1,
  kind: 'impact',
  otherId: 'target',
  position: [0, 1, 0],
});
test('event commands validate, sort and replace event tracks while preserving locked parents and take ownership', () => {
  let project = applyCommands(fixture(), [
    {
      type: 'motion.events.set',
      payload: { id: 'source', events: [{ ...event, id: 'late', time: 4 }, event] },
    },
  ]).project;
  assert.deepEqual(
    project.objects[0].motionEvents!.map((item) => item.time),
    [1, 4],
  );
  const snapshot = structuredClone(project);
  for (const events of [[event, event], [{ ...event, otherId: 'missing' }], [{ ...event, duration: -1 }]])
    assert.throws(() =>
      applyCommands(project, [{ type: 'motion.events.set', payload: { id: 'source', events } }]),
    );
  assert.deepEqual(project, snapshot);
  project.objects[1].type = 'group';
  project.objects[1].locked = true;
  project.objects[0].parentId = 'target';
  assert.throws(
    () => applyCommands(project, [{ type: 'motion.events.set', payload: { id: 'source', events: [] } }]),
    /locked/,
  );
  project = fixture();
  const production = ensureProduction(project);
  const scene = production.scenes[0];
  const initial = scene.performances[0].id;
  duplicatePerformance(project, scene.id, initial, 'Alternate', 'alternate');
  selectProduction(project, scene.id, 'alternate');
  project = applyCommands(project, [
    { type: 'motion.events.set', payload: { id: 'source', events: [event] } },
  ]).project;
  syncProduction(project);
  selectProduction(project, scene.id, initial);
  assert.equal(project.objects[0].motionEvents, undefined);
  selectProduction(project, scene.id, 'alternate');
  assert.equal(project.objects[0].motionEvents![0].id, event.id);
});
test('event time edits drive synchronization and linked deletion requires explicit atomic unlink', () => {
  let project = applyCommands(fixture(), [
    { type: 'motion.events.set', payload: { id: 'source', events: [event] } },
    {
      type: 'sync.group.set',
      payload: {
        group: {
          id: 'sync',
          name: 'Hit',
          members: [
            { kind: 'motion-event', objectId: 'source', id: event.id },
            { kind: 'keyframe', objectId: 'source', id: 'key' },
          ],
        },
      },
    },
  ]).project;
  project = applyCommands(project, [
    { type: 'motion.events.set', payload: { id: 'source', events: [{ ...event, time: 3 }] } },
  ]).project;
  assert.equal(project.objects[0].keyframes[0].time, 4);
  assert.throws(
    () => applyCommands(project, [{ type: 'motion.events.set', payload: { id: 'source', events: [] } }]),
    /Unlink/,
  );
  project.synchronization![0].locked = true;
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'motion.events.set', payload: { id: 'source', events: [{ ...event, time: 5 }] } },
      ]),
    /locked/,
  );
  project.synchronization![0].locked = false;
  project = applyCommands(project, [
    {
      type: 'sync.member.remove',
      payload: { id: 'sync', member: { kind: 'motion-event', objectId: 'source', id: event.id } },
    },
    { type: 'motion.events.set', payload: { id: 'source', events: [] } },
  ]).project;
  assert.deepEqual(project.objects[0].motionEvents, []);
  assert.deepEqual(project.synchronization, []);
  assert.equal(project.objects[0].keyframes[0].time, 4);
});
