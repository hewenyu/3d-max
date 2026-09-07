import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeContinuity, applyContinuityCommand } from '../shared/continuity';
import { createEmptyProject, createObject } from '../shared/project';
import { actorAnimationSchema } from '../shared/actor-animation';
import { productionRenderFixture } from './fixtures/production-render';
import type { Project } from '../shared/types';

function fixture(): Project {
  const project = createEmptyProject('Continuity');
  project.settings.aspect = '16:9';
  const first = createObject('actor', 'First');
  first.id = 'first';
  first.position = [-1, 0, 0];
  first.actor!.lookAtId = 'second';
  first.keyframes = [
    { id: 'walk-start', time: 0, position: [-1, 0, 0] },
    { id: 'pose-change', time: 2, pose: { rightArm: 130 }, lookAtId: null, easing: 'step' },
    { id: 'walk-end', time: 4, position: [1, 0, 0], easing: 'linear' },
  ];
  const second = createObject('actor', 'Second');
  second.id = 'second';
  second.position = [1.5, 0, 0];
  const prop = createObject('phone');
  prop.id = 'phone';
  prop.attachment = { objectId: first.id, bone: 'rightHand', offset: [0, 0, 0] };
  prop.keyframes = [
    { id: 'handover', time: 2, attachment: { objectId: second.id, bone: 'leftHand', offset: [0, 0, 0] } },
  ];
  const wall = createObject('wall');
  wall.id = 'wall';
  wall.position = [0, 0, 2];
  wall.dimensions = [8, 3, 0.1];
  const offscreen = createObject('box');
  offscreen.id = 'offscreen';
  offscreen.position = [50, 0, 0];
  project.objects = [first, second, prop, wall, offscreen];
  project.settings.axisActorIds = [first.id, second.id];
  project.cameras = [
    {
      id: 'front',
      name: 'Front',
      position: [0, 1.5, 5],
      target: [0, 1, 0],
      fov: 45,
      locked: false,
      keyframes: [],
    },
    {
      id: 'back',
      name: 'Back',
      position: [0, 1.5, -5],
      target: [0, 1, 0],
      fov: 45,
      locked: false,
      keyframes: [],
    },
  ];
  project.shots = [
    {
      id: 'front-shot',
      name: 'Front',
      cameraId: 'front',
      sourceIn: 0,
      sourceOut: 1,
      intent: '',
      subjectIds: [first.id, offscreen.id],
      hiddenIds: [],
      beatId: null,
      locked: false,
    },
    {
      id: 'back-shot',
      name: 'Back',
      cameraId: 'back',
      sourceIn: 2,
      sourceOut: 3,
      intent: '',
      subjectIds: [first.id],
      hiddenIds: [],
      beatId: null,
      locked: false,
    },
  ];
  project.sequences[0].clips = [
    { id: 'front-clip', shotId: 'front-shot', sourceIn: 0, sourceOut: 1 },
    { id: 'back-clip', shotId: 'back-shot', sourceIn: 2, sourceOut: 3 },
  ];
  return project;
}

test('computed cut checks report axis, screen motion, gaze, action and prop changes with time evidence', () => {
  const project = fixture();
  const report = analyzeContinuity(project, { sampleRate: 4 });
  const rules = new Set(report.findings.map((finding) => finding.rule));
  for (const rule of [
    'axis-crossing',
    'screen-direction',
    'eyeline-switch',
    'action-phase',
    'prop-state',
    'subject-out-of-frame',
    'subject-occluded',
  ])
    assert.ok(rules.has(rule as never), `${rule} was not reported`);
  const axis = report.findings.find((finding) => finding.rule === 'axis-crossing')!;
  assert.equal(axis.shotId, 'back-shot');
  assert.equal(axis.otherShotId, 'front-shot');
  assert.equal(axis.sequenceTime, 1);
  assert.equal(axis.sourceTime, 2);
  const hidden = report.findings.find((finding) => finding.rule === 'subject-occluded')!;
  assert.ok(hidden.objectIds.includes('wall'));
  assert.equal(hidden.evidence.geometry, 'sampled-mesh-rays');
  assert.ok(hidden.sequenceEndTime > hidden.sequenceTime, 'repeated samples should aggregate');
  assert.deepEqual(analyzeContinuity(project, { sampleRate: 4 }), report);
});

test('camera swept collision catches a thin wall between samples and actual IK reports unreachable contacts', () => {
  const project = fixture();
  project.cameras[0].keyframes = [
    { id: 'camera-end', time: 1, position: [0, 1.5, 0], target: [0, 1, -1], fov: 45, easing: 'linear' },
  ];
  project.objects[0].actor!.animation = actorAnimationSchema.parse({
    constraints: [
      {
        id: 'unreachable',
        effector: 'rightHand',
        start: 0,
        end: 4,
        target: { kind: 'world', position: [30, 5, 0] },
      },
    ],
  });
  const report = analyzeContinuity(project, { sampleRate: 2 });
  const collision = report.findings.find(
    (finding) => finding.rule === 'camera-collision' && finding.objectIds.includes('wall'),
  )!;
  assert.ok(collision);
  assert.equal(collision.evidence.test, 'swept-segment');
  assert.equal(collision.evidence.geometry, 'mesh');
  const contact = report.findings.find((finding) => finding.rule === 'contact-error')!;
  assert.equal(contact.evidence.status, 'unreachable');
  assert.equal(contact.evidence.reachable, false);
  assert.ok(Number(contact.evidence.errorMeters) > 20);
});

test('intentional exceptions persist for the same evidence and expire when camera content changes', () => {
  const project = fixture();
  const original = analyzeContinuity(project, { sampleRate: 2 });
  const axis = original.findings.find((finding) => finding.rule === 'axis-crossing')!;
  applyContinuityCommand(project, 'continuity.ignore', {
    findingId: axis.id,
    reason: 'Intentional reverse angle',
  });
  const ignored = analyzeContinuity(project, { sampleRate: 2 }).findings.find(
    (finding) => finding.id === axis.id,
  )!;
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.ignoreReason, 'Intentional reverse angle');
  project.cameras[0].fov = 50;
  const revised = analyzeContinuity(project, { sampleRate: 2 }).findings.find(
    (finding) => finding.rule === 'axis-crossing',
  )!;
  assert.notEqual(revised.id, axis.id);
  assert.equal(revised.ignored, false);
  applyContinuityCommand(project, 'continuity.ignore', { findingId: axis.id, reason: null });
  assert.deepEqual(project.continuity?.ignored, []);
});

test('different sets do not create false action or axis matches from duplicate object IDs', () => {
  const project = productionRenderFixture();
  const report = analyzeContinuity(project, { sampleRate: 2 });
  assert.equal(
    report.findings.some(
      (finding) =>
        finding.shotId === 'shot-3' &&
        ['axis-crossing', 'action-phase', 'prop-state', 'screen-direction'].includes(finding.rule),
    ),
    false,
  );
  assert.throws(() => analyzeContinuity(project, { maxSamples: 2 }), /above/);
});
