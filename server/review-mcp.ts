import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  reviewCommentSchema,
  reviewInviteSchema,
  reviewPublishSchema,
  reviewUpdateSchema,
  type ReviewPrincipal,
} from '../shared/review';
import { errorBody } from './errors';
import type { ReviewService } from './review-service';

const result = (run: () => unknown): CallToolResult => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(run()) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorBody(error)) }] };
  }
};
const publicationId = z.string().min(1).max(160);

export function registerReviewOwnerTools(server: McpServer, reviews: ReviewService, url: string) {
  server.registerTool(
    'review_details',
    {
      description:
        'Read owner review details, including all existing invitations and revocation status, comments and the immutable publication. Invitation tokens are never returned by this read.',
      inputSchema: { publicationId },
    },
    ({ publicationId }) => result(() => reviews.ownerDetails(publicationId)),
  );
  server.registerTool(
    'review_list',
    {
      description: 'List immutable exported video revisions published for team review.',
      inputSchema: {},
    },
    () => result(() => reviews.publications()),
  );
  server.registerTool(
    'review_publish',
    {
      description:
        'Publish an existing completed render for timecoded team review. The captured video and project revision stay fixed.',
      inputSchema: reviewPublishSchema.shape,
    },
    (input) => result(() => reviews.publish(input)),
  );
  server.registerTool(
    'review_invite',
    {
      description:
        'Create a named, revocable reviewer or view-only invitation restricted to one publication. The token is returned once. Creating an invitation does not send it to anyone.',
      inputSchema: reviewInviteSchema.extend({ publicationId }).shape,
    },
    ({ publicationId, ...input }) =>
      result(() => {
        const created = reviews.invite(publicationId, input);
        return {
          ...created,
          url: `${url}/#invite=${encodeURIComponent(created.token)}`,
          mcpUrl: `${url}/mcp`,
        };
      }),
  );
  server.registerTool(
    'review_revoke',
    {
      description: 'Revoke a review invitation and its browser sessions immediately.',
      inputSchema: { publicationId, id: z.string().min(1).max(160) },
    },
    (input) => result(() => reviews.revoke(input.publicationId, input.id)),
  );
  server.registerTool(
    'review_comments',
    {
      description:
        'Read timecoded comments, replies, author identities, resolution status and optimistic versions for one review.',
      inputSchema: { publicationId },
    },
    (input) => result(() => reviews.comments(reviews.owner(input.publicationId))),
  );
  server.registerTool(
    'review_comment_add',
    {
      description:
        'Add a director comment or thread reply, with an idempotent request ID and video time in seconds.',
      inputSchema: reviewCommentSchema.extend({ publicationId }).shape,
    },
    ({ publicationId, ...input }) => result(() => reviews.addComment(reviews.owner(publicationId), input)),
  );
  server.registerTool(
    'review_comment_update',
    {
      description:
        'Edit, resolve or reopen a review comment. expectedVersion prevents overwriting a concurrent review edit.',
      inputSchema: reviewUpdateSchema.innerType().extend({ publicationId }).shape,
    },
    ({ publicationId, ...input }) => result(() => reviews.updateComment(reviews.owner(publicationId), input)),
  );
}

export function createReviewMcp(reviews: ReviewService, principal: ReviewPrincipal) {
  const server = new McpServer({ name: 'whiteframe-review', version: '1.0.0' });
  server.registerTool(
    'review_get',
    {
      description:
        'Read the single video revision and discussion authorized by this invitation. This endpoint does not expose the editor or other projects.',
      inputSchema: {},
    },
    () =>
      result(() => ({
        publication: reviews.publication(principal.publicationId),
        principal,
        comments: reviews.comments(principal),
      })),
  );
  if (principal.role !== 'viewer') {
    server.registerTool(
      'review_comment_add',
      {
        description:
          'Add a timecoded review comment or reply with an idempotent request ID. Author identity comes from the invitation.',
        inputSchema: reviewCommentSchema.shape,
      },
      (input) => result(() => reviews.addComment(principal, input)),
    );
    server.registerTool(
      'review_comment_update',
      {
        description: 'Edit your own comment or resolve/reopen your own thread, guarded by expectedVersion.',
        inputSchema: reviewUpdateSchema.innerType().shape,
      },
      (input) => result(() => reviews.updateComment(principal, input)),
    );
  }
  return server;
}
