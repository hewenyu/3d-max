import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { applyCommands, validateProject } from '../shared/commands';
import { createEmptyProject, createObject } from '../shared/project';
import { ActorRig } from '../shared/actor-rig';
import { FaceRig } from '../shared/face-rig';
import { ModelMorphRig } from '../shared/model-morph';
import {
  faceAnimationSchema,
  faceClipSchema,
  modelMorphSchema,
  objectFace,
  sampleFace,
} from '../shared/face-animation';
import { faceAnalysisCommands, rhubarbClip } from '../shared/face-analysis';
import { captureTemplate } from '../shared/templates';
import { ensureProduction, duplicatePerformance, selectProduction } from '../shared/production';
import type { Project } from '../shared/types';

function fixture(): Project {
  return applyCommands(createEmptyProject(), [
    { type: 'object.create', payload: { id: 'actor', type: 'actor' } },
    {
      type: 'audio.create',
      payload: {
        id: 'voice',
        name: 'Dialogue',
        url: '/api/assets/voice/file',
        start: 2,
        sourceIn: 1,
        duration: 3,
        sync: 'source',
      },
    },
  ]).project;
}
function faceClip() {
  return faceClipSchema.parse({
    id: 'speech',
    name: 'Speech',
    start: 2,
    end: 5,
    audioId: 'voice',
    cues: [
      { id: 'a', start: 0, end: 1, viseme: 'A' },
      { id: 'd', start: 1, end: 2, viseme: 'D' },
      { id: 'x', start: 2, end: 3, viseme: 'X' },
    ],
  });
}

test('face keys interpolate sparse channels independently with deterministic backward seeking', () => {
  const face = faceAnimationSchema.parse({
    base: { frown: 0.2 },
    keys: [
      { id: 'smile-a', time: 0, values: { smile: 0 }, easing: 'linear' },
      { id: 'smile-b', time: 2, values: { smile: 1 } },
      { id: 'blink-a', time: 0.8, values: { blinkLeft: 0, blinkRight: 0 } },
      { id: 'blink-b', time: 1, values: { blinkLeft: 1, blinkRight: 1 } },
      { id: 'blink-c', time: 1.2, values: { blinkLeft: 0, blinkRight: 0 } },
    ],
  });
  assert.equal(sampleFace(face, 1).values.smile, 0.5);
  assert.equal(sampleFace(face, 1).values.blinkLeft, 1);
  assert.equal(sampleFace(face, 0.5).values.blinkLeft, 0);
  assert.equal(sampleFace(face, 3).values.smile, 1);
  assert.equal(sampleFace(face, 1).values.frown, 0.2);
  assert.deepEqual(sampleFace(face, 0.9), sampleFace(face, 0.9));
});

test('relative visemes transition, blend within normalized limits and preserve expression channels', () => {
  const clip = faceClip();
  const face = faceAnimationSchema.parse({ base: { smile: 0.7 }, clips: [clip, { ...clip, id: 'second' }] });
  const value = sampleFace(face, 3.2);
  assert.equal(value.values.jawOpen, 0.9);
  assert.equal(value.values.smile, 0.7);
  assert.equal(value.visemes.D, 1);
  assert.equal(sampleFace(face, 3).values.jawOpen, 0);
  assert.ok(sampleFace(face, 3.02).values.jawOpen > 0.3);
  assert.equal(sampleFace(face, 5).values.jawOpen, 0);
  const disabled = sampleFace({ ...face, enabled: false }, 3.2);
  assert.equal(disabled.values.jawOpen, 0);
  assert.equal(disabled.values.smile, 0);
});

test('face commands reject invalid channels, overlapping cues and missing audio atomically', () => {
  const project = fixture();
  const valid = applyCommands(project, [
    { type: 'actor.face.clip.set', payload: { id: 'actor', clip: faceClip() } },
  ]).project;
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(valid))), valid);
  for (const clip of [
    { ...faceClip(), end: 1 },
    { ...faceClip(), audioId: 'missing' },
    {
      ...faceClip(),
      cues: [
        { id: 'x', start: 0, end: 2, viseme: 'A' },
        { id: 'y', start: 1, end: 3, viseme: 'D' },
      ],
    },
  ])
    assert.throws(() =>
      applyCommands(valid, [
        { type: 'project.update', payload: { name: 'Must roll back' } },
        { type: 'actor.face.clip.set', payload: { id: 'actor', clip } },
      ]),
    );
  assert.equal(valid.name, project.name);
  assert.throws(
    () => applyCommands(valid, [{ type: 'audio.delete', payload: { id: 'voice' } }]),
    /Missing lip-sync audio/,
  );
  assert.throws(() =>
    applyCommands(valid, [
      { type: 'actor.face.key.set', payload: { id: 'actor', keyframe: { time: 0, values: { jawOpen: 2 } } } },
    ]),
  );
  const keyed = applyCommands(valid, [
    {
      type: 'actor.face.key.set',
      payload: { id: 'actor', keyframe: { id: 'one', time: 0, values: { smile: 1 } } },
    },
  ]).project;
  assert.throws(
    () =>
      applyCommands(keyed, [
        {
          type: 'actor.face.key.set',
          payload: { id: 'actor', keyframe: { id: 'two', time: 0, values: { smile: 0.5 } } },
        },
      ]),
    /Duplicate face channel key/,
  );
});

test('real face meshes change jaw, lips, brows, blinks and gaze; legacy actors remain unchanged when disabled', () => {
  const actor = createObject('actor');
  const rig = new ActorRig('#cccccc');
  const count = () => {
    let total = 0;
    rig.root.traverse((child) => {
      if (child instanceof THREE.Mesh) total++;
    });
    return total;
  };
  const initial = count();
  rig.update(actor, 0, 0);
  assert.equal(count(), initial);
  actor.actor!.face = faceAnimationSchema.parse({
    base: { jawOpen: 0.9, smile: 1, blinkLeft: 1, gazeX: 1, browDown: 1 },
  });
  rig.update(actor, 0, 0);
  assert.ok(count() > initial);
  assert.equal(rig.head.getObjectByName('legacy-eye--1')!.visible, false);
  const mouth = rig.head.getObjectByName('face-mouth-opening') as THREE.Mesh;
  assert.ok(mouth.scale.y > 0.03);
  const jaw = rig.head.getObjectByName('face-jaw') as THREE.Mesh;
  assert.ok(jaw.position.y < -0.08);
  const pupil = rig.head.getObjectByName('face-pupil-1') as THREE.Mesh;
  assert.ok(pupil.scale.y < 0.001);
  assert.ok(pupil.position.x > 0.05);
  const brow = rig.head.getObjectByName('face-brow-1') as THREE.Mesh;
  assert.ok(brow.rotation.z > 0.3);
  actor.actor!.face.enabled = false;
  rig.update(actor, 0, 0);
  assert.equal(rig.head.getObjectByName('face-expression-rig')!.visible, false);
  assert.equal(rig.head.getObjectByName('legacy-eye--1')!.visible, true);
  rig.dispose();
  const head = new THREE.Group();
  const face = new FaceRig(head);
  face.update(faceAnimationSchema.parse({ base: { smile: 1 } }), 0);
  const smiled = Array.from(face.upperLip.geometry.getAttribute('position').array);
  face.update(faceAnimationSchema.parse({ base: { frown: 1 } }), 0);
  assert.notDeepEqual(Array.from(face.upperLip.geometry.getAttribute('position').array), smiled);
});

test('morph overrides restore mixer values across constant tracks, repeated seeks, disabling and remapping', () => {
  const geometry = new THREE.BoxGeometry();
  geometry.morphAttributes.position = [
    geometry.getAttribute('position').clone(),
    geometry.getAttribute('position').clone(),
  ];
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = 'Face';
  mesh.morphTargetDictionary = { jaw: 0, smile: 1 };
  const root = new THREE.Group();
  root.add(mesh);
  const mixer = new THREE.AnimationMixer(root);
  mixer
    .clipAction(
      new THREE.AnimationClip('constant', 2, [
        new THREE.NumberKeyframeTrack('Face.morphTargetInfluences[0]', [0, 2], [0.7, 0.7]),
      ]),
    )
    .play();
  const rig = new ModelMorphRig(root);
  const morph = modelMorphSchema.parse({
    face: { base: { jawOpen: 1 } },
    bindings: [{ channel: 'jawOpen', target: 'jaw' }],
  });
  for (const time of [0.5, 0.5, 0.6, 0.2]) {
    rig.reset();
    mixer.setTime(time);
    assert.ok(Math.abs(mesh.morphTargetInfluences![0]! - 0.7) < 0.0001);
    rig.update(morph, time);
    assert.equal(mesh.morphTargetInfluences![0], 1);
  }
  rig.reset();
  mixer.setTime(0.2);
  rig.update({ ...morph, face: { ...morph.face, enabled: false } }, 0.2);
  assert.ok(Math.abs(mesh.morphTargetInfluences![0]! - 0.7) < 0.0001);
  rig.update(
    modelMorphSchema.parse({
      face: { base: { smile: 0.5 } },
      bindings: [{ channel: 'smile', target: 'smile' }],
    }),
    0.2,
  );
  assert.equal(mesh.morphTargetInfluences![1], 0.5);
  rig.reset();
  assert.equal(mesh.morphTargetInfluences![1], 0);
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  geometry.dispose();
});

test('lip-sync timing groups shift the clip once and keep every relative mouth cue unchanged', () => {
  let project = fixture();
  project = applyCommands(project, faceAnalysisCommands(project, 'actor', faceClip(), true)).project;
  const cues = structuredClone(objectFace(project.objects[0]!)!.clips[0]!.cues);
  project = applyCommands(project, [
    { type: 'audio.update', payload: { id: 'voice', patch: { start: 4 } } },
  ]).project;
  assert.equal(objectFace(project.objects[0]!)!.clips[0]!.start, 4);
  assert.equal(objectFace(project.objects[0]!)!.clips[0]!.end, 7);
  assert.deepEqual(objectFace(project.objects[0]!)!.clips[0]!.cues, cues);
  assert.throws(
    () =>
      applyCommands(project, [
        { type: 'actor.face.clip.delete', payload: { id: 'actor', itemId: 'speech' } },
      ]),
    /Unlink/,
  );
});

test('face state and links are isolated across takes and template audio references are remapped', () => {
  let project = fixture();
  project = applyCommands(project, faceAnalysisCommands(project, 'actor', faceClip(), true)).project;
  const production = ensureProduction(project);
  const scene = production.scenes[0]!;
  const original = scene.performances[0]!;
  const second = duplicatePerformance(project, scene.id, original.id, 'B');
  selectProduction(project, scene.id, second.id);
  project = applyCommands(project, [
    { type: 'audio.update', payload: { id: 'voice', patch: { start: 6 } } },
  ]).project;
  assert.equal(objectFace(project.objects[0]!)!.clips[0]!.start, 6);
  selectProduction(project, scene.id, original.id);
  assert.equal(objectFace(project.objects[0]!)!.clips[0]!.start, 2);
  const template = captureTemplate(project, { kind: 'scene', name: 'Face scene', description: '' });
  const imported = applyCommands(createEmptyProject(), [
    { type: 'template.instantiate', payload: { template } },
  ]).project;
  const importedClip = objectFace(imported.objects.find((item) => item.type === 'actor')!)!.clips[0]!;
  assert.notEqual(importedClip.audioId, 'voice');
  assert.equal(importedClip.audioId, imported.audio[0]!.id);
  const assembly = captureTemplate(project, {
    kind: 'objects',
    objectIds: ['actor'],
    name: 'Face actor',
    description: '',
  });
  assert.equal(objectFace(assembly.project.objects[0]!)!.clips[0]!.audioId, null);
});

test('Rhubarb output converts phonetic mouth shapes to editable clip-relative cues at the audio trim', () => {
  const audio = fixture().audio[0]!;
  const clip = rhubarbClip(
    {
      metadata: { duration: 3.0001 },
      mouthCues: [
        { start: 0, end: 0.3, value: 'X' },
        { start: 0.3, end: 1, value: 'B' },
        { start: 1, end: 3.0001, value: 'D' },
      ],
    },
    audio,
    'phonetic',
  );
  assert.equal(clip.start, 2);
  assert.equal(clip.end, 5);
  assert.equal(clip.audioSourceIn, 1);
  assert.equal(clip.recognizer, 'rhubarb-phonetic');
  assert.equal(clip.cues[2]!.end, 3);
  assert.throws(() =>
    rhubarbClip(
      { metadata: { duration: 3 }, mouthCues: [{ start: 0, end: 1, value: 'AA' }] },
      audio,
      'phonetic',
    ),
  );
});
