import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareViewport, viewportRequestSchema, constraintInspectSchema } from '../shared/viewport';
import { createEmptyProject } from '../shared/project';
import { productionRenderFixture } from './fixtures/production-render';

test('observation snapshots select shot-bound scenes and takes without changing the editable project', () => {
  const project = productionRenderFixture();
  const original = structuredClone(project);
  const alternate = prepareViewport(project, { kind: 'sequence', time: 2.5 });
  assert.equal(alternate.context.shotId, 'shot-2');
  assert.equal(alternate.context.performanceId, 'take-alternate');
  assert.equal(alternate.context.sourceTime, 0.5);
  assert.equal(alternate.project.production?.activePerformanceId, 'take-alternate');
  assert.deepEqual(alternate.project.objects[0].position, [1.4, 0, 0.8]);
  const second = prepareViewport(project, { kind: 'shot', shotId: 'shot-3', time: 1 });
  assert.equal(second.project.objects[1].type, 'cylinder');
  assert.equal(second.project.production?.activeSceneId, 'scene-second');
  assert.equal(second.context.sceneId, 'scene-second');
  assert.equal(second.context.sequenceTime, null);
  second.project.objects[0].position[0] = 900;
  second.project.production!.scenes[0].name = 'Changed copy';
  assert.deepEqual(project, original);
});

test('sequence, shot and source clocks remain distinct with retiming and independent cameras', () => {
  const project = productionRenderFixture();
  project.shots[0].sourceIn = 10;
  project.shots[0].sourceOut = 12;
  project.sequences[0].clips = [
    {
      id: 'retimed',
      shotId: 'shot-1',
      sourceIn: 10,
      sourceOut: 12,
      retiming: {
        audio: 'mute',
        segments: [{ duration: 4, fromSpeed: 0.5, toSpeed: 0.5, easing: 'constant' }],
      },
      cameraTiming: { mode: 'independent', sourceIn: 20, rate: 2 },
    },
  ];
  const sequence = prepareViewport(project, { kind: 'sequence', time: 3 });
  assert.equal(sequence.context.sourceTime, 11.5);
  assert.equal(sequence.context.cameraTime, 26);
  assert.equal(sequence.frame.sourceTime, undefined, 'sequence sampling must retain independent camera time');
  const shot = prepareViewport(project, { kind: 'shot', shotId: 'shot-1', time: 1 });
  assert.equal(shot.context.sourceTime, 11);
  assert.equal(shot.context.cameraTime, 11);
  assert.equal(shot.frame.sourceTime, 11);
  const source = prepareViewport(project, { kind: 'source', sourceTime: 19, sceneId: 'scene-second' });
  assert.equal(source.context.sourceTime, 19);
  assert.equal(source.context.cameraTime, 19);
  assert.equal(source.context.performanceId, 'take-second');
  assert.equal(source.project.objects[1].type, 'cylinder');
});

test('observation context rejects invalid identities and out-of-range clocks instead of silently clamping', () => {
  const project = productionRenderFixture();
  for (const context of [
    { kind: 'shot', shotId: 'missing', time: 0 },
    { kind: 'sequence', sequenceId: 'missing', time: 0 },
    { kind: 'source', sceneId: 'missing', sourceTime: 0 },
    { kind: 'source', sceneId: 'scene-second', performanceId: 'missing', sourceTime: 0 },
  ] as const)
    assert.throws(() => prepareViewport(project, context), { code: 'NOT_FOUND' });
  assert.throws(
    () =>
      prepareViewport(project, { kind: 'source', shotId: 'shot-1', sceneId: 'scene-second', sourceTime: 0 }),
    { code: 'INVALID_CONTEXT' },
  );
  assert.throws(() => prepareViewport(project, { kind: 'shot', shotId: 'shot-1', time: 3 }), {
    code: 'INVALID_TIME',
  });
  assert.throws(() => prepareViewport(project, { kind: 'sequence', time: 7 }), { code: 'INVALID_TIME' });
  assert.equal(prepareViewport(createEmptyProject(), { kind: 'sequence', time: 0 }).context.sourceTime, 0);
});

test('viewport boundaries reject mixed clocks, nonfinite cameras and excess dimensions', () => {
  assert.equal(viewportRequestSchema.parse({}).context.kind, 'sequence');
  for (const input of [
    { context: { kind: 'sequence', time: 1, sourceTime: 2 } },
    { context: { kind: 'source', sourceTime: -1 } },
    { context: { kind: 'shot', time: 0 } },
    { observation: { position: [Infinity, 1, 2] } },
    { observation: { fov: 180 } },
    { width: 2000 },
    { view: 'free' },
  ])
    assert.equal(viewportRequestSchema.safeParse(input).success, false);
  assert.equal(
    constraintInspectSchema.safeParse({ context: { kind: 'source', sourceTime: 2 }, view: 'top' }).success,
    false,
  );
});
