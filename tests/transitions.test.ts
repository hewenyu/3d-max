import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommands, validateProject } from '../shared/commands';
import { sampleSequenceOpacity, sampleSequenceTransition, sampleClipHandle } from '../shared/transitions';
import { sequenceDuration } from '../shared/timeline';
import { splitClip } from '../shared/time-map';
import { transitionFixture } from './fixtures/transitions';

test('centered dissolves advance both real shot handles continuously without changing duration', () => {
  const project = transitionFixture();
  assert.equal(sequenceDuration(project), 8);
  assert.equal(sampleSequenceTransition(project, 3.49), null);
  assert.equal(sampleSequenceTransition(project, 4.5), null);
  const start = sampleSequenceTransition(project, 3.5)!;
  const middle = sampleSequenceTransition(project, 4)!;
  const end = sampleSequenceTransition(project, 4.49)!;
  assert.equal(start.progress, 0);
  assert.equal(start.incoming.sourceTime, 0.5);
  assert.equal(middle.progress, 0.5);
  assert.equal(middle.outgoing.sourceTime, 5);
  assert.equal(middle.incoming.sourceTime, 1);
  assert.ok(end.outgoing.sourceTime > 5);
  assert.ok(end.incoming.sourceTime > 1);
  assert.equal(middle.outgoing.shot?.sceneId, project.shots[0].sceneId);
  assert.equal(middle.incoming.shot?.sceneId, 'scene-second');
});

test('retimed handles preserve endpoint velocity and an independent camera clock', () => {
  const clip = {
    id: 'retimed',
    shotId: 'shot',
    sourceIn: 10,
    sourceOut: 16,
    retiming: {
      audio: 'mute' as const,
      segments: [{ duration: 3, fromSpeed: 1, toSpeed: 3, easing: 'linear' as const }],
    },
    cameraTiming: { mode: 'independent' as const, sourceIn: 20, rate: 0.5 },
  };
  assert.equal(sampleClipHandle(clip, -0.5).sourceTime, 9.5);
  assert.equal(sampleClipHandle(clip, -0.5).cameraTime, 19.75);
  assert.equal(sampleClipHandle(clip, 3.5).sourceTime, 17.5);
  assert.equal(sampleClipHandle(clip, 3.5).cameraTime, 21.75);
});

test('shared commands reject unavailable source handles and conflicting windows atomically', () => {
  const project = transitionFixture();
  const sequenceId = project.sequences[0].id;
  const before = JSON.stringify(project);
  assert.throws(
    () =>
      applyCommands(project, [
        {
          type: 'clip.transition',
          payload: { sequenceId, clipId: 'clip-2', transitionIn: { type: 'dissolve', duration: 3 } },
        },
      ]),
    /source handles/,
  );
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'clip.transition', payload: { sequenceId, clipId: 'clip-1', fadeOut: 1 } },
      ]),
    /outgoing dissolve/,
  );
  assert.throws(
    () =>
      applyCommands(project, [
        {
          type: 'clip.transition',
          payload: {
            sequenceId,
            clipId: 'clip-1',
            fadeIn: null,
            transitionIn: { type: 'dissolve', duration: 1 },
          },
        },
      ]),
    /First clip/,
  );
  assert.equal(JSON.stringify(project), before);
  const applied = applyCommands(project, [
    { type: 'clip.transition', payload: { sequenceId, clipId: 'clip-2', transitionIn: null, fadeIn: 0.5 } },
  ]).project;
  assert.equal(applied.sequences[0].clips[1].transitionIn, undefined);
  assert.equal(applied.sequences[0].clips[1].fadeIn, 0.5);
  const overlap = structuredClone(project);
  overlap.sequences[0].clips[0].fadeIn = 4;
  assert.throws(() => validateProject(overlap), /overlap/);
});

test('fade endpoints and split clips retain only their original outer-edge transitions', () => {
  const project = transitionFixture();
  assert.equal(sampleSequenceOpacity(project, 0), 0);
  assert.equal(sampleSequenceOpacity(project, 0.5), 0.5);
  assert.equal(sampleSequenceOpacity(project, 1), 1);
  assert.equal(sampleSequenceOpacity(project, 7.5), 0.5);
  assert.equal(sampleSequenceOpacity(project, 8), 0);
  const [left, right] = splitClip(project.sequences[0].clips[1], 2, 'right');
  assert.equal(left.transitionIn?.type, 'dissolve');
  assert.equal(left.fadeOut, undefined);
  assert.equal(right.transitionIn, undefined);
  assert.equal(right.fadeIn, undefined);
  assert.equal(right.fadeOut, 1);
});
