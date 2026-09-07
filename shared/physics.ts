import { z } from 'zod';

const finite = z.number().finite();
const component = finite.min(-100000).max(100000);
const vector = z.tuple([component, component, component]);

export const rigidBodySchema = z
  .object({
    mode: z.enum(['static', 'dynamic', 'kinematic']).default('dynamic'),
    shape: z.enum(['box', 'sphere', 'capsule', 'mesh']).default('box'),
    mass: finite.positive().max(1e8).default(1),
    friction: finite.min(0).max(5).default(0.6),
    restitution: finite.min(0).max(1).default(0.2),
    linearVelocity: vector.default([0, 0, 0]),
    angularVelocity: vector.default([0, 0, 0]),
    linearDamping: finite.min(0).max(100).default(0.1),
    angularDamping: finite.min(0).max(100).default(0.1),
    gravityScale: finite.min(-10).max(10).default(1),
    lockRotation: z.tuple([z.boolean(), z.boolean(), z.boolean()]).default([false, false, false]),
    ccd: z.boolean().default(true),
  })
  .strict();

export type RigidBodySettings = z.infer<typeof rigidBodySchema>;

export const physicsBakeSchema = z
  .object({
    ids: z.array(z.string().min(1).max(160)).min(1).max(64).optional(),
    start: finite.min(0).max(86400).default(0),
    duration: finite.positive().max(600).default(5),
    fps: finite.int().min(1).max(60).default(24),
    stepRate: finite.int().min(30).max(240).default(120),
    gravity: vector.default([0, -9.81, 0]),
  })
  .strict();

export type PhysicsBakeOptions = z.infer<typeof physicsBakeSchema>;
