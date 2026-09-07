import { z } from 'zod';
import { cameraMotionSchema } from './camera-motion';
import { modelingCommandDefinitions } from './modeling';
import { productionCommandDefinitions } from './production-commands';
import { actorCommandDefinitions } from './actor-commands';
import { motionCommandDefinitions } from './motion';
import { aspectSchema, cameraSettingsCommandDefinitions } from './camera-commands';
import { modelCommandDefinitions } from './model-catalog';
import { cameraPresetCommandDefinitions } from './camera-presets';
import { continuityCommandDefinitions } from './continuity-types';
import { templateCommandDefinitions } from './templates';
import { synchronizationCommandDefinitions } from './synchronization-operations';
import { faceCommandDefinitions } from './face-commands';
import { scriptApplySchema } from './script-schema';
import { lightingCommandDefinitions } from './lighting-commands';
import {
  audioSchema,
  beatSchema,
  cameraKeyframeSchema,
  cameraSchema,
  identifier,
  noteSchema,
  objectKeyframeSchema,
  objectSchema,
  objectTypeSchema,
  sequenceSchema,
  settingsSchema,
  shotSchema,
  cameraTimingSchema,
  retimingSchema,
  clipSchema,
  timeSchema,
} from './schema';

const remove = z.object({ id: identifier }).strict();
const update = <T extends z.AnyZodObject>(schema: T) =>
  z.object({ id: identifier, patch: schema.omit({ id: true }).partial().strict() }).strict();
const create = <T extends z.AnyZodObject>(schema: T) => schema.partial().strict();
const keyframeDelete = z.object({ id: identifier, keyframeId: identifier }).strict();

export const commandDefinitions: { type: string; description: string; schema: z.AnyZodObject }[] = [
  ...lightingCommandDefinitions,
  ...productionCommandDefinitions,
  ...modelingCommandDefinitions,
  ...actorCommandDefinitions,
  ...motionCommandDefinitions,
  ...cameraSettingsCommandDefinitions,
  ...modelCommandDefinitions,
  ...cameraPresetCommandDefinitions,
  ...continuityCommandDefinitions,
  ...templateCommandDefinitions,
  ...synchronizationCommandDefinitions,
  ...faceCommandDefinitions,
  {
    type: 'script.apply',
    description:
      'Apply a reviewed Fountain/JSON script breakdown as one atomic editable scene/performance/actor/beat/camera/shot/sequence import. Use script_parse first; estimated durations and unresolved blocking remain explicit. options.sceneIds selects a subset for batching; imports expand to at most 500 shared commands. createCoverage=false creates one wide shot per scene.',
    schema: scriptApplySchema,
  },
  {
    type: 'clip.transition',
    description:
      'Set visual fadeIn/fadeOut in edit seconds or transitionIn={type:dissolve,duration}; null removes a field. Dissolves are centered on the incoming cut and use real source handles in both shots. Outside a trimmed clip, source time advances at its endpoint speed and independent camera time keeps its rate. Transition windows cannot overlap and handles must remain inside shot source ranges. Sequence duration and source intervals are unchanged. Audio fades are configured separately on audio clips. Single-shot exports omit sequence transitions.',
    schema: z
      .object({
        sequenceId: identifier,
        clipId: identifier,
        fadeIn: clipSchema.shape.fadeIn.unwrap().nullable().optional(),
        fadeOut: clipSchema.shape.fadeOut.unwrap().nullable().optional(),
        transitionIn: clipSchema.shape.transitionIn.unwrap().nullable().optional(),
      })
      .strict(),
  },
  {
    type: 'clip.retime',
    description:
      'Set an integrated speed curve on an edit clip. Segment duration is edit seconds; source advance is the integral of fromSpeed/toSpeed with constant, linear or smooth ramps. fitSourceRange defaults true and scales segment durations to preserve the clip source interval. audio=warp continuously follows ramps with natural pitch changes through native audio resampling; audio=follow preserves pitch for constant-speed spans; audio=mute silences source audio. Independent sequence audio remains continuous. Null retiming resets 1x. Optional independent cameraTiming samples camera animation on its own clock.',
    schema: z
      .object({
        sequenceId: identifier,
        clipId: identifier,
        retiming: retimingSchema.nullable(),
        fitSourceRange: z.boolean().optional(),
        cameraTiming: cameraTimingSchema.optional(),
      })
      .strict(),
  },
  {
    type: 'clip.trim',
    description:
      'Trim inside an existing clip source interval while preserving the exact speed curve and independent camera timing. Source animation and events are not changed.',
    schema: z
      .object({ sequenceId: identifier, clipId: identifier, sourceIn: timeSchema, sourceOut: timeSchema })
      .strict(),
  },
  {
    type: 'clip.split',
    description:
      'Split a clip at its local EDIT time in seconds, preserving source continuity, exact ramp curves, audio policy, and independent camera time on both pieces.',
    schema: z
      .object({
        sequenceId: identifier,
        clipId: identifier,
        time: timeSchema,
        rightId: identifier.optional(),
      })
      .strict(),
  },
  {
    type: 'camera.motion',
    description:
      'Generate editable camera keyframes: hold, dolly_in/out, pan, truck, pedestal, orbit, follow. start/end are ascending camera-clock bounds; without clip context they retain source-time behavior. Provide sequenceId+clipId to map acting through that exact clip retiming and independent/reverse camera clock; frozen camera clocks are rejected. Optional shotId resolves the bound scene/performance and must match the clip/camera. No clip is inferred for repeated shots. Distance is meters, angle degrees. Follow supports animated parents/bones, contact constraints and handovers; rotateWithSubject mounts position and aim to the subject. Optional aspect edits its independent composition. Replaces keys only within [start,end]; cameras shared by clips share these keys.',
    schema: cameraMotionSchema,
  },
  {
    type: 'project.update',
    description: 'Update project name, scene name, or active sequence.',
    schema: z
      .object({
        name: z.string().min(1).max(200).optional(),
        sceneName: z.string().max(200).optional(),
        activeSequenceId: identifier.optional(),
      })
      .strict(),
  },
  {
    type: 'project.settings',
    description:
      'Update output format, frame rate, lighting and actor axis. Units are meters, rotations degrees, Y is up.',
    schema: settingsSchema.partial().strict(),
  },
  {
    type: 'object.create',
    description:
      'Create a scene object. Actors face +Z and their origin is at the feet. Transform coordinates are local to the parent or attachment.',
    schema: objectSchema.partial().extend({ type: objectTypeSchema }).strict(),
  },
  {
    type: 'object.update',
    description:
      'Update an object with {id,patch}. A locked entity must first be explicitly unlocked using only {locked:false}.',
    schema: update(objectSchema)
      .extend({ patch: objectSchema.omit({ id: true, type: true }).partial().strict() })
      .strict(),
  },
  {
    type: 'object.delete',
    description:
      'Delete object and descendants. Referenced bone attachment targets must first be detached. Locked affected entities block the transaction.',
    schema: remove,
  },
  {
    type: 'object.duplicate',
    description: 'Duplicate an object hierarchy with independent IDs and animation.',
    schema: z
      .object({ id: identifier, name: z.string().min(1).max(200).optional(), newId: identifier.optional() })
      .strict(),
  },
  {
    type: 'object.keyframe.set',
    description:
      'Set a source-time keyframe; missing id is generated. Existing time or ID is replaced. Sparse properties interpolate independently; action and attachment hold until next event.',
    schema: z
      .object({
        id: identifier,
        keyframe: objectKeyframeSchema.extend({ id: identifier.optional() }).strict(),
      })
      .strict(),
  },
  {
    type: 'object.keyframe.delete',
    description: 'Delete an object keyframe by keyframeId.',
    schema: keyframeDelete,
  },
  {
    type: 'object.group',
    description: 'Group unlocked sibling objects, preserving their local transforms.',
    schema: z
      .object({
        ids: z.array(identifier).min(1),
        id: identifier.optional(),
        name: z.string().min(1).max(200).optional(),
      })
      .strict(),
  },
  {
    type: 'object.align',
    description:
      'Align sibling object origins on an axis to minimum, center, or maximum selected position, or to explicit value.',
    schema: z
      .object({
        ids: z.array(identifier).min(2),
        axis: z.enum(['x', 'y', 'z']),
        mode: z.enum(['min', 'center', 'max']).optional(),
        value: z.number().finite().optional(),
      })
      .strict(),
  },
  {
    type: 'camera.create',
    description: 'Create an animated camera. FOV is vertical degrees. Keyframes use source time.',
    schema: create(cameraSchema),
  },
  {
    type: 'camera.update',
    description: 'Update camera parameters or keyframes with {id,patch}.',
    schema: update(cameraSchema),
  },
  {
    type: 'camera.delete',
    description: 'Delete an unreferenced camera. Delete its shots first if referenced.',
    schema: remove,
  },
  {
    type: 'camera.keyframe.set',
    description:
      'Set camera source-time animation keyframe. Missing id is generated; existing time or ID is replaced. Optional aspect edits that independent composition.',
    schema: z
      .object({
        id: identifier,
        keyframe: cameraKeyframeSchema.extend({ id: identifier.optional() }).strict(),
        aspect: aspectSchema.optional(),
      })
      .strict(),
  },
  {
    type: 'camera.keyframe.delete',
    description: 'Delete camera keyframe by keyframeId.',
    schema: keyframeDelete.extend({ aspect: aspectSchema.optional() }).strict(),
  },
  {
    type: 'shot.create',
    description: 'Create a shot referencing a camera and source performance time interval.',
    schema: create(shotSchema).extend({ cameraId: identifier }).strict(),
  },
  {
    type: 'shot.update',
    description:
      'Update shot intent, camera, subjects or source range. Referencing clips must remain within source range.',
    schema: update(shotSchema),
  },
  {
    type: 'shot.delete',
    description:
      'Delete shot and remove its sequence clips and director notes. Locked referencing sequences prevent deletion.',
    schema: remove,
  },
  {
    type: 'sequence.create',
    description: 'Create an edit sequence. Each clip references a shot and its own source interval.',
    schema: create(sequenceSchema),
  },
  {
    type: 'sequence.update',
    description:
      'Update a sequence with {id,patch}; clips is a complete ordered replacement, supporting trim, repetition and reordering.',
    schema: update(sequenceSchema),
  },
  {
    type: 'sequence.delete',
    description: 'Delete a sequence; the project must retain at least one sequence.',
    schema: remove,
  },
  {
    type: 'sequence.duplicate',
    description:
      'Duplicate an edit with independent shots, camera parameters and camera keyframes; scene performance remains shared.',
    schema: z
      .object({ id: identifier, name: z.string().min(1).max(200).optional(), newId: identifier.optional() })
      .strict(),
  },
  {
    type: 'beat.create',
    description: 'Create a source-time dialogue, pause, reaction, reveal or action marker.',
    schema: create(beatSchema),
  },
  {
    type: 'beat.update',
    description: 'Update source-time performance marker with {id,patch}.',
    schema: update(beatSchema),
  },
  {
    type: 'beat.delete',
    description: 'Delete a performance marker and clear its shot links.',
    schema: remove,
  },
  {
    type: 'audio.create',
    description:
      'Add reference audio. sync=source follows editorial source time; sync=sequence plays continuously on edit time. Optional fadeIn/fadeOut use seconds on that audio clock and fadeCurve is linear or equalPower. Overlap audio clips for a crossfade; fades retain their phase across shot cuts and speed changes.',
    schema: create(audioSchema)
      .extend({ url: z.string().min(1).max(4096) })
      .strict(),
  },
  {
    type: 'audio.update',
    description:
      'Update reference audio source trim, duration, volume (0..2), fadeIn/fadeOut/fadeCurve or clock with {id,patch}. Fade lengths cannot exceed audio duration. Source trim changes require lip-sync cue review.',
    schema: update(audioSchema),
  },
  { type: 'audio.delete', description: 'Delete reference audio from project.', schema: remove },
  {
    type: 'note.create',
    description: 'Add director note at a sequence time or linked shot source time.',
    schema: create(noteSchema)
      .extend({ text: z.string().min(1).max(10000) })
      .strict(),
  },
  { type: 'note.delete', description: 'Delete director note.', schema: remove },
];
