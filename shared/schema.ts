import { z } from 'zod';
import type { Project } from './types';
import { clipDuration, hasSpeedRamp, retimingSourceDuration } from './time-map';
import { transitionIssues } from './transitions';
import { modelingSchema } from './modeling';
import { createProductionSchema, validateProduction } from './production-schema';
import { resolveShotProject } from './production';
import { lightingPlanSchema, lightingSchema, validateLightingPlans } from './lighting-plans';
import { continuityStateSchema } from './continuity-types';
import { DomainError } from './domain-error';
import { actorAnimationSchema } from './actor-animation';
import { validateActorTargets } from './actor-validation';
import {
  effectSchema,
  motionEventSchema,
  motionPathSchema,
  vehicleSchema,
  validateMotionObject,
} from './motion';
import { rigidBodySchema } from './physics';
import { cameraCompositionsSchema, cameraOpticsSchema, safeAreaSchema } from './camera-optics';
import { synchronizationSchema, validateSynchronization } from './synchronization';
import { faceAnimationSchema, modelMorphSchema, validateFace } from './face-animation';

const finite = z.number().finite();
export const identifier = z.string().min(1).max(160);
export const timeSchema = finite.min(0).max(86400);
export const vec3Schema = z.tuple([finite, finite, finite]);
export const positiveVec3Schema = z.tuple([finite.positive(), finite.positive(), finite.positive()]);
export const objectTypeSchema = z.enum([
  'box',
  'sphere',
  'cylinder',
  'plane',
  'wall',
  'door',
  'window',
  'sofa',
  'table',
  'chair',
  'actor',
  'phone',
  'group',
  'model',
]);
export const actionSchema = z.enum(['idle', 'walk', 'sit', 'talk']);
export const easingSchema = z.enum(['linear', 'smooth', 'step']);
export const poseSchema = z
  .object({
    headPitch: finite,
    headYaw: finite,
    leftArm: finite,
    rightArm: finite,
    leftLeg: finite,
    rightLeg: finite,
  })
  .strict();
export const attachmentSchema = z
  .object({
    objectId: identifier,
    bone: z.enum(['rightHand', 'leftHand', 'head', 'root']),
    offset: vec3Schema,
  })
  .strict();
export const objectKeyframeSchema = z
  .object({
    id: identifier,
    time: timeSchema,
    position: vec3Schema.optional(),
    rotation: vec3Schema.optional(),
    scale: positiveVec3Schema.optional(),
    pose: poseSchema.partial().optional(),
    action: actionSchema.optional(),
    lookAtId: identifier.nullable().optional(),
    attachment: attachmentSchema.nullable().optional(),
    easing: easingSchema.optional(),
  })
  .strict();
export const objectSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(200),
    type: objectTypeSchema,
    parentId: identifier.nullable(),
    position: vec3Schema,
    rotation: vec3Schema,
    scale: positiveVec3Schema,
    dimensions: positiveVec3Schema,
    visible: z.boolean(),
    locked: z.boolean(),
    tone: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    keyframes: z.array(objectKeyframeSchema),
    actor: z
      .object({
        action: actionSchema,
        speed: finite.min(0).max(30),
        pose: poseSchema,
        lookAtId: identifier.nullable(),
        animation: actorAnimationSchema.optional(),
        face: faceAnimationSchema.optional(),
      })
      .strict()
      .optional(),
    attachment: attachmentSchema.nullable().optional(),
    assetUrl: z.string().max(4096).optional(),
    animationName: z.string().max(200).optional(),
    animationIndex: z.number().int().min(0).max(10000).nullable().optional(),
    morph: modelMorphSchema.optional(),
    modeling: modelingSchema.optional(),
    motion: motionPathSchema.optional(),
    vehicle: vehicleSchema.optional(),
    physics: rigidBodySchema.optional(),
    motionEvents: z.array(motionEventSchema).optional(),
    effect: effectSchema.optional(),
    rotationInterpolation: z.enum(['linear', 'quaternion']).optional(),
  })
  .strict();
export const cameraKeyframeSchema = z
  .object({
    id: identifier,
    time: timeSchema,
    position: vec3Schema,
    target: vec3Schema,
    fov: finite.min(5).max(150),
    easing: easingSchema,
  })
  .strict();
export const cameraSchema = z
  .object({
    optics: cameraOpticsSchema.optional(),
    compositions: cameraCompositionsSchema.optional(),
    id: identifier,
    name: z.string().min(1).max(200),
    position: vec3Schema,
    target: vec3Schema,
    fov: finite.min(5).max(150),
    locked: z.boolean(),
    keyframes: z.array(cameraKeyframeSchema),
  })
  .strict();
export const shotSchema = z
  .object({
    lightingPlanId: identifier.optional(),
    sceneId: identifier.optional(),
    performanceId: identifier.optional(),
    storySceneId: identifier.optional(),
    id: identifier,
    name: z.string().min(1).max(200),
    cameraId: identifier,
    sourceIn: timeSchema,
    sourceOut: timeSchema,
    intent: z.string().max(10000),
    subjectIds: z.array(identifier),
    hiddenIds: z.array(identifier),
    beatId: identifier.nullable(),
    locked: z.boolean(),
  })
  .strict();
export const speedSegmentSchema = z
  .object({
    duration: finite.positive().max(86400),
    fromSpeed: finite.min(0.0625).max(16),
    toSpeed: finite.min(0.0625).max(16),
    easing: z.enum(['constant', 'linear', 'smooth']),
    curveIn: finite.min(0).max(1).optional(),
    curveOut: finite.min(0).max(1).optional(),
  })
  .strict();
export const retimingSchema = z
  .object({
    segments: z.array(speedSegmentSchema).min(1).max(256),
    audio: z.enum(['follow', 'warp', 'mute']),
  })
  .strict();
export const cameraTimingSchema = z
  .object({
    mode: z.enum(['source', 'independent']),
    sourceIn: timeSchema.optional(),
    rate: finite.min(-16).max(16).optional(),
  })
  .strict();
export const clipSchema = z
  .object({
    id: identifier,
    shotId: identifier,
    sourceIn: timeSchema,
    sourceOut: timeSchema,
    retiming: retimingSchema.optional(),
    cameraTiming: cameraTimingSchema.optional(),
    fadeIn: finite.positive().max(86400).optional(),
    fadeOut: finite.positive().max(86400).optional(),
    transitionIn: z
      .object({ type: z.literal('dissolve'), duration: finite.positive().max(86400) })
      .strict()
      .optional(),
  })
  .strict();
export const sequenceSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(200),
    clips: z.array(clipSchema),
    locked: z.boolean(),
  })
  .strict();
export const beatSchema = z
  .object({
    id: identifier,
    label: z.string().min(1).max(300),
    time: timeSchema,
    endTime: timeSchema,
    kind: z.enum(['dialogue', 'pause', 'reaction', 'reveal', 'action']),
    actorId: identifier.nullable(),
    text: z.string().max(10000),
    notes: z.string().max(10000),
    locked: z.boolean(),
  })
  .strict();
export const audioSchema = z
  .object({
    fadeIn: timeSchema.optional(),
    fadeOut: timeSchema.optional(),
    fadeCurve: z.enum(['linear', 'equalPower']).optional(),
    id: identifier,
    name: z.string().min(1).max(200),
    url: z.string().min(1).max(4096),
    start: timeSchema,
    sourceIn: timeSchema,
    duration: finite.positive().max(86400),
    volume: finite.min(0).max(2),
    muted: z.boolean(),
    locked: z.boolean(),
    sync: z.enum(['source', 'sequence']),
  })
  .strict();
export const noteSchema = z
  .object({
    id: identifier,
    shotId: identifier.nullable(),
    time: timeSchema,
    text: z.string().min(1).max(10000),
  })
  .strict();
export const settingsSchema = z
  .object({
    lightingPlanId: identifier.optional(),
    environment: z
      .object({
        ground: z.boolean(),
        background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        groundTone: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .strict()
      .optional(),
    safeArea: safeAreaSchema.optional(),
    fps: finite.int().min(1).max(60),
    aspect: z.enum(['16:9', '9:16', '1:1']),
    resolution: z.union([z.literal(720), z.literal(1080)]),
    lighting: lightingSchema,
    axisActorIds: z.array(identifier).max(2),
  })
  .strict();
export const projectSchema = z
  .object({
    lightingPlans: z.array(lightingPlanSchema).max(1000).optional(),
    continuity: continuityStateSchema.optional(),
    synchronization: synchronizationSchema.optional(),
    production: createProductionSchema({
      object: objectSchema,
      beat: beatSchema,
      audio: audioSchema,
      lighting: settingsSchema.shape.lighting,
      environment: settingsSchema.shape.environment,
    }).optional(),
    schemaVersion: z.literal(1),
    id: identifier,
    name: z.string().min(1).max(200),
    sceneName: z.string().max(200),
    revision: finite.int().min(0),
    objects: z.array(objectSchema),
    cameras: z.array(cameraSchema),
    shots: z.array(shotSchema),
    sequences: z.array(sequenceSchema).min(1),
    activeSequenceId: identifier,
    beats: z.array(beatSchema),
    audio: z.array(audioSchema),
    notes: z.array(noteSchema),
    settings: settingsSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError(message, 'VALIDATION_ERROR');
}

function uniqueIds(items: { id: string }[], kind: string) {
  assert(new Set(items.map((item) => item.id)).size === items.length, `Duplicate ${kind} ID`);
}

function checkKeyframes(frames: { id: string; time: number }[], owner: string) {
  uniqueIds(frames, `${owner} keyframe`);
  assert(
    new Set(frames.map((frame) => frame.time)).size === frames.length,
    `Duplicate keyframe time on ${owner}`,
  );
}

/** Parse first, then verify relationships so imported and commanded projects share invariants. */
export function validateProject(input: unknown): Project {
  const p = projectSchema.parse(input);
  validateLightingPlans(p);
  const entities = [
    ...p.objects,
    ...p.cameras,
    ...p.shots,
    ...p.sequences,
    ...p.beats,
    ...p.audio,
    ...p.notes,
  ];
  uniqueIds(entities, 'entity');
  for (const audio of p.audio) {
    assert((audio.fadeIn ?? 0) <= audio.duration, `Audio fade-in exceeds clip duration: ${audio.id}`);
    assert((audio.fadeOut ?? 0) <= audio.duration, `Audio fade-out exceeds clip duration: ${audio.id}`);
  }
  const objects = new Map(p.objects.map((item) => [item.id, item]));
  const cameras = new Set(p.cameras.map((item) => item.id));
  const shots = new Map(p.shots.map((item) => [item.id, item]));
  const hasObject = (id: string | null | undefined) => id == null || objects.has(id);
  assert(
    p.sequences.some((s) => s.id === p.activeSequenceId),
    'Active sequence does not exist',
  );
  p.objects.forEach((object) => {
    validateActorTargets(object, objects);
    validateFace(object, p);
    validateMotionObject(object);
    if (object.physics?.shape === 'mesh')
      assert(object.physics.mode === 'static', 'Mesh collision shapes require a static rigid body');
    assert(
      !object.vehicle || (object.type !== 'actor' && object.type !== 'group'),
      'Vehicle geometry requires a mesh object',
    );
    uniqueIds(object.motionEvents ?? [], `${object.id} motion event`);
    for (const event of object.motionEvents ?? [])
      assert(hasObject(event.otherId), `Missing motion event target: ${event.id}`);
    assert(hasObject(object.parentId), `Missing parent for ${object.id}`);
    assert(hasObject(object.attachment?.objectId), `Missing attachment target for ${object.id}`);
    assert(hasObject(object.actor?.lookAtId), `Missing look-at target for ${object.id}`);
    assert(object.type !== 'actor' || object.actor, `Actor state required for ${object.id}`);
    assert(object.type === 'actor' || !object.actor, `Actor state only allowed on actors: ${object.id}`);
    if (object.attachment && object.attachment.bone !== 'root')
      assert(objects.get(object.attachment.objectId)?.type === 'actor', 'Bone attachments require an actor');
    checkKeyframes(object.keyframes, object.id);
    object.keyframes.forEach((frame) => {
      assert(hasObject(frame.lookAtId), `Missing keyframe look-at target for ${object.id}`);
      assert(hasObject(frame.attachment?.objectId), `Missing keyframe attachment target for ${object.id}`);
      assert(
        object.type === 'actor' || (!frame.pose && !frame.action && frame.lookAtId === undefined),
        `Actor keyframe properties require an actor: ${object.id}`,
      );
      if (frame.attachment && frame.attachment.bone !== 'root')
        assert(objects.get(frame.attachment.objectId)?.type === 'actor', 'Bone attachments require an actor');
    });
  });
  // Check the effective transform graph at every discrete attachment change.
  const times = new Set([
    0,
    ...p.objects.flatMap((o) => o.keyframes.filter((k) => k.attachment !== undefined).map((k) => k.time)),
  ]);
  for (const time of times) {
    const parents = new Map<string, string | null>();
    p.objects.forEach((object) => {
      let attachment = object.attachment;
      [...object.keyframes]
        .sort((a, b) => a.time - b.time)
        .forEach((frame) => {
          if (frame.time <= time && frame.attachment !== undefined) attachment = frame.attachment;
        });
      parents.set(object.id, attachment?.objectId ?? object.parentId);
    });
    for (const object of p.objects) {
      const visited = new Set<string>();
      let next: string | null | undefined = object.id;
      while (next) {
        assert(!visited.has(next), `Transform hierarchy cycle at ${object.id}`);
        visited.add(next);
        next = parents.get(next);
      }
    }
  }
  // Parent graphs must also be valid while attachments temporarily override them.
  for (const object of p.objects) {
    const visited = new Set<string>();
    let next: string | null | undefined = object.id;
    while (next) {
      assert(!visited.has(next), `Parent hierarchy cycle at ${object.id}`);
      visited.add(next);
      next = objects.get(next)?.parentId;
    }
  }
  p.cameras.forEach((camera) => {
    checkKeyframes(camera.keyframes, camera.id);
    if (camera.optics) checkKeyframes(camera.optics.keyframes, `${camera.id} optics`);
    const compositions = Object.values(camera.compositions ?? {});
    for (const composition of compositions) checkKeyframes(composition.keyframes, `${camera.id} composition`);
    const views = [
      camera,
      ...camera.keyframes,
      ...compositions.flatMap((value) => [value, ...value.keyframes]),
    ];
    views.forEach((view) =>
      assert(
        view.position.some((v, i) => Math.abs(v - view.target[i]!) > 1e-6),
        `Camera ${camera.id} position and target must differ`,
      ),
    );
  });
  p.shots.forEach((shot) => {
    assert(
      p.production || (!shot.sceneId && !shot.performanceId && !shot.storySceneId),
      `Shot ${shot.id} requires a production library`,
    );
    const shotProject = resolveShotProject(p, shot);
    const shotObjects = new Set(shotProject.objects.map((object) => object.id));
    const shotBeats = new Set(shotProject.beats.map((beat) => beat.id));
    assert(cameras.has(shot.cameraId), `Missing camera for ${shot.id}`);
    const optics = p.cameras.find((camera) => camera.id === shot.cameraId)?.optics;
    for (const focus of optics ? [optics, ...optics.keyframes] : [])
      assert(
        !focus.focusTargetId || shotObjects.has(focus.focusTargetId),
        `Missing focus target for shot ${shot.id}`,
      );
    assert(shot.sourceOut > shot.sourceIn, `Shot ${shot.id} must have positive duration`);
    assert(
      shot.subjectIds.every((id) => shotObjects.has(id)) && shot.hiddenIds.every((id) => shotObjects.has(id)),
      `Missing shot object for ${shot.id}`,
    );
    assert(shot.beatId === null || shotBeats.has(shot.beatId), `Missing beat for ${shot.id}`);
  });
  p.sequences.forEach((sequence) => {
    uniqueIds(sequence.clips, `${sequence.id} clip`);
    for (const issue of transitionIssues(sequence, shots)) assert(false, issue);
    sequence.clips.forEach((clip) => {
      const shot = shots.get(clip.shotId);
      assert(shot, `Missing shot for clip ${clip.id}`);
      assert(clip.sourceOut > clip.sourceIn, `Clip ${clip.id} must have positive duration`);
      if (clip.retiming) {
        for (const segment of clip.retiming.segments) {
          assert(
            (segment.curveOut ?? 1) > (segment.curveIn ?? 0),
            'Speed segment curveOut must exceed curveIn',
          );
          assert(
            segment.easing !== 'constant' || segment.fromSpeed === segment.toSpeed,
            'Constant speed segment endpoints must match',
          );
        }
        assert(
          Math.abs(retimingSourceDuration(clip.retiming) - (clip.sourceOut - clip.sourceIn)) <
            1e-6 * Math.max(1, clip.sourceOut - clip.sourceIn),
          `Clip ${clip.id} speed curve must integrate to its source interval`,
        );
        assert(
          clip.retiming.audio !== 'follow' || !hasSpeedRamp(clip.retiming),
          'Continuously ramped clips require warp or mute source audio; constant-speed follow preserves pitch',
        );
      }
      assert(clipDuration(clip) <= 86400, `Clip ${clip.id} edit duration exceeds 24 hours`);
      if (clip.cameraTiming?.mode === 'independent') {
        const cameraEnd =
          (clip.cameraTiming.sourceIn ?? clip.sourceIn) + clipDuration(clip) * (clip.cameraTiming.rate ?? 1);
        assert(
          cameraEnd >= 0 && cameraEnd <= 86400,
          `Clip ${clip.id} camera time must remain inside 0..86400 seconds`,
        );
      }
      assert(
        clip.sourceIn >= shot.sourceIn && clip.sourceOut <= shot.sourceOut,
        `Clip ${clip.id} falls outside shot source range`,
      );
    });
  });
  p.beats.forEach((beat) => {
    assert(beat.endTime >= beat.time, `Beat ${beat.id} end precedes start`);
    assert(hasObject(beat.actorId), `Missing actor for beat ${beat.id}`);
    assert(
      beat.actorId === null || objects.get(beat.actorId)?.type === 'actor',
      `Beat ${beat.id} target must be an actor`,
    );
  });
  p.notes.forEach((note) =>
    assert(note.shotId === null || shots.has(note.shotId), `Missing shot for note ${note.id}`),
  );
  assert(
    p.settings.axisActorIds.every((id) => objects.get(id)?.type === 'actor'),
    'Axis targets must be actors',
  );
  assert(new Set(p.settings.axisActorIds).size === p.settings.axisActorIds.length, 'Axis actors must differ');
  validateSynchronization(p);
  validateProduction(p, validateProject);
  return p;
}
