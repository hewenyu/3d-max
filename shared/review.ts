import { z } from 'zod';

const id = z.string().min(1).max(160);
export const reviewPublishSchema = z
  .object({
    jobId: id,
    title: z.string().trim().min(1).max(200),
  })
  .strict();
export const reviewInviteSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    role: z.enum(['reviewer', 'viewer']),
  })
  .strict();
export const reviewCommentSchema = z
  .object({
    requestId: id,
    time: z.number().finite().min(0),
    text: z.string().trim().min(1).max(10000),
    replyTo: id.optional(),
  })
  .strict();
export const reviewUpdateSchema = z
  .object({
    id,
    expectedVersion: z.number().int().min(1),
    text: z.string().trim().min(1).max(10000).optional(),
    status: z.enum(['open', 'resolved']).optional(),
  })
  .strict()
  .refine((input) => input.text !== undefined || input.status !== undefined, 'Choose an edit');

export interface ReviewPublication {
  id: string;
  projectId: string;
  jobId: string;
  title: string;
  projectRevision: number;
  duration: number;
  fps: number;
  createdAt: string;
}
export interface ReviewPrincipal {
  id: string;
  name: string;
  publicationId: string;
  role: 'owner' | 'reviewer' | 'viewer';
}
export interface ReviewInvite extends Omit<ReviewPrincipal, 'role'> {
  role: 'reviewer' | 'viewer';
  revoked: boolean;
  createdAt: string;
}
export interface ReviewComment {
  id: string;
  publicationId: string;
  author: { id: string; name: string };
  time: number;
  text: string;
  replyTo?: string;
  status: 'open' | 'resolved';
  version: number;
  createdAt: string;
  updatedAt: string;
}
