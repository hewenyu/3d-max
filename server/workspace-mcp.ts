import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { workspaceCommandSchema } from '../shared/workspace';
import { errorBody } from './errors';
import type { WorkspaceService } from './workspace-service';

const id = z.string().min(1).max(200);
const readFields = {
  workspaceId: id.describe(
    'Explicit browser workspace ID from workspace_list; never implicitly selects a tab.',
  ),
  projectId: id,
  expectedRevision: z.number().int().min(0),
  expectedWorkspaceRevision: z.number().int().min(0).optional(),
};
const result = async (run: () => unknown | Promise<unknown>): Promise<CallToolResult> => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await run()) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorBody(error)) }] };
  }
};

export function registerWorkspaceTools(server: McpServer, workspaces: WorkspaceService) {
  server.registerTool(
    'workspace_list',
    {
      description:
        'List actual browser editor workspaces, connection freshness and last reported state. Read a specific workspace for fresh state; project editing and headless preview tools do not require an open browser.',
      inputSchema: {},
    },
    () => result(() => workspaces.list()),
  );
  server.registerTool(
    'workspace_get',
    {
      description:
        'Read fresh actual selection, observation cameras, time/source/camera clocks, tools, panels, comparison, cut review and exported player state from one connected editor. Project/revision guards prevent targeting a stale tab.',
      inputSchema: readFields,
    },
    ({ workspaceId, ...input }) =>
      result(() => workspaces.request(workspaceId, { ...input, id: randomUUID(), operation: 'get' })),
  );
  server.registerTool(
    'workspace_apply',
    {
      description:
        'Control the actual editor selection, observation view/navigation/focus, preview playback, tool/overlay/panel modes, dialogs, synchronized comparison, cut review and exported video player. Reuses Web handlers. A stable requestId replays the original outcome without executing twice. Requires a connected workspace; native fullscreen/audible playback may return an explicit browser activation error. Read actual state after an uncertain timeout before issuing a new request.',
      inputSchema: { ...readFields, requestId: id, command: workspaceCommandSchema },
    },
    ({ workspaceId, requestId, ...input }) =>
      result(() => workspaces.request(workspaceId, { ...input, id: requestId, operation: 'apply' })),
  );
  server.registerTool(
    'viewport_inspect',
    {
      description:
        'Inspect actual browser-rendered object transforms and every contact constraint result at the current workspace frame, including source/camera time and solved/inactive/failed states. Requires the explicit connected editor workspace.',
      inputSchema: { ...readFields, objectIds: z.array(id).max(10000).optional() },
    },
    ({ workspaceId, objectIds, ...input }) =>
      result(() =>
        workspaces.request(workspaceId, {
          ...input,
          id: randomUUID(),
          operation: 'inspect',
          options: { objectIds },
        }),
      ),
  );
  server.registerTool(
    'viewport_capture',
    {
      description:
        'Capture the actual connected editor observation or photography viewport as PNG, optionally including current safe-frame/composition overlays. Returns the exact workspace state alongside an MCP image. For headless capture use scene_view_capture.',
      inputSchema: { ...readFields, overlays: z.boolean().default(true) },
    },
    async ({ workspaceId, overlays, ...input }) => {
      try {
        const captured = (await workspaces.request(workspaceId, {
          ...input,
          id: randomUUID(),
          operation: 'capture',
          options: { overlays },
        })) as { state: unknown; dataUrl: string };
        return {
          content: [
            { type: 'text', text: JSON.stringify({ state: captured.state }) },
            {
              type: 'image',
              mimeType: 'image/png',
              data: captured.dataUrl.slice('data:image/png;base64,'.length),
            },
          ],
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorBody(error)) }] };
      }
    },
  );
}
