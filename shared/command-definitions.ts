import { z } from 'zod';
import { cameraMotionSchema } from './camera-motion';
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
} from './schema';

const remove = z.object({ id: identifier }).strict();
const update = <T extends z.AnyZodObject>(schema: T) =>
  z.object({ id: identifier, patch: schema.omit({ id: true }).partial().strict() }).strict();
const create = <T extends z.AnyZodObject>(schema: T) => schema.partial().strict();
const keyframeDelete = z.object({ id: identifier, keyframeId: identifier }).strict();

export const commandDefinitions: { type: string; description: string; schema: z.AnyZodObject }[] = [
  {
    type: 'camera.motion',
    description:
      'Generate editable camera keyframes over source time: hold, dolly_in/out, pan, truck, pedestal, orbit, follow. Distance is meters, angle degrees. Follow supports transformed parent groups; attached props require manual keyframes. Replaces camera keys only within [start,end].',
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
      'Set camera source-time animation keyframe. Missing id is generated; existing time or ID is replaced.',
    schema: z
      .object({
        id: identifier,
        keyframe: cameraKeyframeSchema.extend({ id: identifier.optional() }).strict(),
      })
      .strict(),
  },
  {
    type: 'camera.keyframe.delete',
    description: 'Delete camera keyframe by keyframeId.',
    schema: keyframeDelete,
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
      'Add reference audio. sync=source follows editorial source time; sync=sequence plays continuously on edit time.',
    schema: create(audioSchema)
      .extend({ url: z.string().min(1).max(4096) })
      .strict(),
  },
  {
    type: 'audio.update',
    description: 'Update reference audio timing, level or sync mode with {id,patch}.',
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
