import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { constraintInspectSchema, viewportRequestSchema } from '../shared/viewport';
import { ApiError, errorBody } from './errors';
import type { RenderService } from './render';

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const guard = async (run: () => Promise<CallToolResult>): Promise<CallToolResult> => {
  try {
    return await run();
  } catch (error) {
    return { ...json(errorBody(error)), isError: true };
  }
};

export function registerViewportTools(server: McpServer, render: RenderService) {
  server.registerTool(
    'scene_view_capture',
    {
      description:
        'Render an isolated project snapshot through the actual 3D engine without an open editor. Returns a PNG, observation camera, rendered object transforms and all contact results. Context kinds explicitly select sequence time (including speed ramps and independent camera timing), shot-relative time, or absolute source time and scene/performance. Edit/top views observe the selected scene/take; camera view follows the shot. Observation positions/targets/pan are world-space meters, Y up; orbit angles and FOV are degrees. Supports helpers and safe-frame overlays. Optional projectId/expectedRevision reject stale snapshots.',
      inputSchema: viewportRequestSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (input) =>
      guard(async () => {
        const { dataUrl, ...details } = await render.viewport(input);
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,'))
          throw new ApiError('INVALID_FRAME', 'Renderer did not return a PNG frame', 500);
        const data = dataUrl.slice('data:image/png;base64,'.length);
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
          throw new ApiError('INVALID_FRAME', 'Renderer returned invalid PNG data', 500);
        return {
          content: [
            { type: 'text', text: JSON.stringify(details) },
            { type: 'image', mimeType: 'image/png', data },
          ],
        };
      }),
  );
  server.registerTool(
    'contact_constraints_inspect',
    {
      description:
        'Evaluate every actor contact constraint at an explicit sequence, shot-relative, or source timestamp using the actual rendered scene and shared IK solver, without an open editor. Returns object IDs and solved/inactive/missing-target/unreachable/partial status, effector/target world positions, error in meters, reached/reachable flags and effective weight. Includes exact source/camera clocks and immutable project revision. objectIds optionally restricts the selected scene.',
      inputSchema: constraintInspectSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (input) => guard(async () => json(await render.inspectConstraints(input))),
  );
}
