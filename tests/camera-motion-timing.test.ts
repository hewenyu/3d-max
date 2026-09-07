import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { applyCommands, validateProject } from '../shared/commands';
import { createEmptyProject, createObject } from '../shared/project';
import { sampleCamera, sampleObject, sampleTimeline } from '../shared/timeline';
import { cameraToClipTime, clipDuration, sampleClipTime, sourceToClipTime } from '../shared/time-map';
import { createCameraSubjectSampler } from '../shared/camera-subject';
import type { Project, SequenceClip } from '../shared/types';
import { attachedCameraFixture } from './fixtures/camera-prop';
import { transitionFixture } from './fixtures/transitions';

function fixture() {
  const project = createEmptyProject('Explicit camera timing');
  const subject = createObject('box');
  subject.id = 'subject';
  subject.keyframes = [{ id: 'move', time: 3, position: [6, 0, 0], rotation: [0, 90, 0], easing: 'linear' }];
  project.objects = [subject];
  project.cameras = [
    {
      id: 'camera',
      name: 'Camera',
      position: [2, 3, 7],
      target: [0, 0, 0],
      fov: 45,
      keyframes: [],
      locked: false,
    },
  ];
  project.shots = [
    {
      id: 'shot',
      name: 'Shot',
      cameraId: 'camera',
      sourceIn: 0,
      sourceOut: 3,
      intent: '',
      subjectIds: ['subject'],
      hiddenIds: [],
      beatId: null,
      locked: false,
    },
  ];
  project.sequences[0].clips = [{ id: 'clip', shotId: 'shot', sourceIn: 0, sourceOut: 3 }];
  return project;
}

const ramp: SequenceClip['retiming'] = {
  audio: 'mute',
  segments: [{ duration: 3, fromSpeed: 0.25, toSpeed: 1.75, easing: 'smooth' }],
};

function follow(project: Project, clip = project.sequences[0].clips[0]) {
  const first = sampleClipTime(clip, 0).cameraTime;
  const last = sampleClipTime(clip, clipDuration(clip)).cameraTime;
  return applyCommands(project, [
    {
      type: 'camera.motion',
      payload: {
        id: project.cameras[0].id,
        motion: 'follow',
        subjectId: project.shots[0].subjectIds[0],
        sequenceId: project.activeSequenceId,
        clipId: clip.id,
        shotId: clip.shotId,
        start: Math.min(first, last),
        end: Math.max(first, last),
      },
    },
  ]).project;
}

for (const kind of ['source', 'independent-ramp', 'reverse-ramp'] as const)
  test(`follow uses the exact ${kind} clip clock at every output frame`, () => {
    const project = fixture();
    const clip = project.sequences[0].clips[0];
    if (kind !== 'source') {
      clip.retiming = ramp;
      clip.cameraTiming = {
        mode: 'independent',
        sourceIn: kind === 'reverse-ramp' ? 8 : 10,
        rate: kind === 'reverse-ramp' ? -2 : 0.5,
      };
    }
    const updated = follow(project);
    const first = sampleTimeline(updated, 0);
    assert.deepEqual(first.camera!.position, project.cameras[0].position);
    const offset = new Vector3(...first.camera!.position).sub(new Vector3(...first.camera!.target));
    for (let frame = 0; frame <= 72; frame++) {
      const sampled = sampleTimeline(updated, frame / 24);
      const expected = sampleObject(project.objects[0], sampled.sourceTime).position;
      expected[1] += project.objects[0].dimensions[1] / 2;
      assert.ok(new Vector3(...sampled.camera!.target).distanceTo(new Vector3(...expected)) < 1e-8);
      assert.ok(
        new Vector3(...sampled.camera!.position)
          .sub(new Vector3(...sampled.camera!.target))
          .distanceTo(offset) < 1e-8,
      );
    }
    assert.deepEqual(project.cameras[0].keyframes, []);
  });

test('repeated shots use the explicitly selected clip, and a shot binding uses its stored performance', () => {
  let project = fixture();
  project.sequences[0].clips.push({
    id: 'repeated',
    shotId: 'shot',
    sourceIn: 1,
    sourceOut: 3,
    cameraTiming: { mode: 'independent', sourceIn: 10, rate: 1 },
  });
  project = applyCommands(project, [{ type: 'production.initialize', payload: {} }]).project;
  const { activeSceneId: sceneId, activePerformanceId: performanceId } = project.production!;
  project = applyCommands(project, [
    {
      type: 'performance.duplicate',
      payload: { sceneId, id: performanceId, name: 'Other take', newId: 'other' },
    },
    { type: 'object.update', payload: { id: 'subject', patch: { position: [100, 0, 0], keyframes: [] } } },
  ]).project;
  const updated = follow(project, project.sequences[0].clips[1]);
  assert.deepEqual(sampleCamera(updated.cameras[0], 10).target, [2, 0.5, 0]);
  assert.deepEqual(sampleCamera(updated.cameras[0], 12).target, [6, 0.5, 0]);
  assert.deepEqual(updated.objects[0].position, [100, 0, 0]);
  assert.equal(updated.production!.activePerformanceId, 'other');
  const legacy = applyCommands(project, [
    {
      type: 'camera.motion',
      payload: { id: 'camera', motion: 'follow', subjectId: 'subject', start: 0, end: 3 },
    },
  ]).project;
  assert.deepEqual(legacy.cameras[0].keyframes.at(-1)!.target, [100, 0.5, 0]);
});

test('reverse camera clocks preserve exact handover events and mounted camera poses', () => {
  const project = attachedCameraFixture();
  const prop = project.objects.find((item) => item.id === 'handover-prop')!;
  prop.keyframes[0].time = 1.513;
  const clip = project.sequences[0].clips[0];
  clip.retiming = ramp;
  clip.cameraTiming = { mode: 'independent', sourceIn: 8, rate: -2 };
  const updated = follow(project);
  const eventTime = sampleClipTime(clip, sourceToClipTime(clip, 1.513)).cameraTime;
  const camera = updated.cameras[0];
  const sampler = createCameraSubjectSampler(project, prop.id);
  try {
    assert.ok(camera.keyframes.some((key) => key.time === eventTime));
    assert.equal(camera.keyframes.find((key) => key.time === eventTime + 1e-7)!.easing, 'step');
    assert.ok(
      new Vector3(...sampleCamera(camera, eventTime).target).distanceTo(sampler.position(1.513)) < 1e-8,
    );
    for (const cameraTime of [eventTime - 1e-7, eventTime + 1e-7]) {
      const sourceTime = sampleClipTime(clip, cameraToClipTime(clip, cameraTime)).sourceTime;
      assert.ok(
        new Vector3(...sampleCamera(camera, cameraTime).target).distanceTo(sampler.position(sourceTime)) <
          1e-6,
      );
    }
    const mounted = applyCommands(project, [
      {
        type: 'camera.motion',
        payload: {
          id: camera.id,
          motion: 'follow',
          subjectId: prop.id,
          rotateWithSubject: true,
          sequenceId: project.activeSequenceId,
          clipId: clip.id,
          start: 2,
          end: 8,
        },
      },
    ]).project.cameras[0];
    const inverse = sampler.matrix(0).invert();
    const mountPosition = new Vector3(...project.cameras[0].position).applyMatrix4(inverse);
    const mountTarget = new Vector3(...project.cameras[0].target).applyMatrix4(inverse);
    for (let frame = 0; frame <= 72; frame++) {
      const timing = sampleClipTime(clip, frame / 24);
      const transform = sampler.matrix(timing.sourceTime);
      const sampled = sampleCamera(mounted, timing.cameraTime);
      assert.ok(
        new Vector3(...sampled.position).distanceTo(mountPosition.clone().applyMatrix4(transform)) < 1e-8,
      );
      assert.ok(
        new Vector3(...sampled.target).distanceTo(mountTarget.clone().applyMatrix4(transform)) < 1e-8,
      );
    }
  } finally {
    sampler.dispose();
  }
});

test('camera motion rejects incomplete or mismatched context and frozen or invalid clock ranges atomically', () => {
  const project = fixture();
  const before = structuredClone(project);
  const base = { id: 'camera', motion: 'follow', subjectId: 'subject', start: 0, end: 3 };
  for (const [patch, message] of [
    [{ clipId: 'clip' }, /together/],
    [{ sequenceId: project.activeSequenceId, clipId: 'missing' }, /not found/],
    [{ sequenceId: project.activeSequenceId, clipId: 'clip', shotId: 'missing' }, /specified shot/],
    [{ sequenceId: project.activeSequenceId, clipId: 'clip', end: 4 }, /camera-time range/],
  ] as const)
    assert.throws(
      () => applyCommands(project, [{ type: 'camera.motion', payload: { ...base, ...patch } }]),
      message,
    );
  assert.deepEqual(project, before);
  project.sequences[0].clips[0].cameraTiming = { mode: 'independent', sourceIn: 1, rate: 0 };
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'camera.motion', payload: { ...base, sequenceId: project.activeSequenceId, clipId: 'clip' } },
      ]),
    /frozen/,
  );
  project.sequences[0].clips[0].cameraTiming = { mode: 'independent', sourceIn: 1, rate: -1 };
  assert.throws(() => validateProject(project), /0\.\.86400/);
  const dissolve = transitionFixture();
  dissolve.sequences[0].clips[0].cameraTiming = { mode: 'independent', sourceIn: 4, rate: -1 };
  assert.throws(() => validateProject(dissolve), /camera time outside/);
});
