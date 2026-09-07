# Web And MCP Capability Parity

The user's [scope decision](scope-decisions.md) requires every usable Web capability to be available to external agents through MCP. The built-in chat, external generative 3D integrations and professional DCC extensions named in that decision are not required. This document supplements the durable feature map in [acceptance-entrypoints.md](acceptance-entrypoints.md); neither protocol discovery nor a successful generic edit proves all UI behavior.

## Capability Map

| Web capability                                                                                                         | Public MCP entry                                                                                                                               | Shared implementation and verification                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project, scene, performance, model, pose, path, camera, edit, dialogue, audio, lighting, templates and reusable assets | Standalone domain tools from `tools/list`, `edit_batch`, project/template/model/speech service tools                                           | Existing [feature map](acceptance-entrypoints.md); commands share schema, Store, locks, revision checking and SQLite undo history                                                                        |
| Asset upload up to 100 MiB                                                                                             | `asset_import` for small files; `transfer_begin`, `transfer_chunk`, `transfer_status`, `transfer_commit`, `transfer_cancel` for the full limit | `server/assets.ts`, `server/transfers.ts`; `transfers.test.ts`, `transfer-mcp.test.ts` exercise real bytes, restart and atomic publication                                                               |
| Portable project upload up to 512 MiB                                                                                  | `project_package_import` or the same chunk tools with `kind: "project-package"`                                                                | Same project-package validation and SQLite install transaction as Web; actual four-film MCP restoration is a separate delivery gate                                                                      |
| Undo/redo availability and history travel                                                                              | `history_status`, `history_undo`, `history_redo`                                                                                               | `Store.history/travel`; real SDK and HTTP comparison in `review-service.test.ts` and service catalog                                                                                                     |
| Owner publication details and existing invitation management                                                           | `review_details`, `review_invite`, `review_revoke`; existing publication/comment tools                                                         | `ReviewService.ownerDetails`; Web/MCP return identical publication, principal, comments and invitation records without revealing tokens; invited reviewer endpoint retains its restricted catalog        |
| Current selection, multi-selection, clear selection and context                                                        | `workspace_list`, `workspace_get`, `workspace_apply` with `selection`                                                                          | Actual React selection and inspector; guarded browser acknowledgement, independently targeted tabs                                                                                                       |
| Free, top and photography views; pan/orbit/dolly/focus; current observation camera                                     | `workspace_apply` with `view`, `observation`, `focus`; `workspace_get`                                                                         | Shared SceneEngine navigation and actual read-back. Save a read observation through existing camera commands, then create/update a shot using existing shot/sequence commands                            |
| Scene preview seek, frame stepping, start/end, play/pause, loop and mute                                               | `workspace_apply` with `transport`                                                                                                             | Existing `usePlayback`; returned sequence/source/camera clocks preserve retiming                                                                                                                         |
| Select a timeline clip                                                                                                 | `workspace_apply` with `clip`                                                                                                                  | Positions preview and selects its camera. To also enter a shot's scene/take for editing, call `scene_select` with the shot's binding first, then use the returned project revision for workspace control |
| Translate/rotate/scale tool, snap, helpers and safe frame                                                              | `workspace_apply` with `settings`                                                                                                              | Existing state handlers and engine setters; viewport PNG can include actual overlays                                                                                                                     |
| Side panels, mobile panels, inspector tabs, base/keyframe mode and scene-library tabs                                  | `workspace_apply` with `panels`                                                                                                                | Registered mounted surfaces reuse their actual state handlers                                                                                                                                            |
| New/open/import/export/MCP/script/review/continuity dialogs                                                            | `workspace_apply` with `dialog`; underlying operations use corresponding project/render/script/review/continuity tools                         | Browser surface control plus shared business operations; OS file pickers are replaced by actual MCP file transfer, downloadable bytes/URLs and equivalent imports                                        |
| Synchronized sequence comparison and cut review                                                                        | `workspace_apply` with `comparison`, `cut_review`; `workspace_get`                                                                             | Actual comparison times, playback, ready states, left/right sequence and cut checklist. Both headless images can use a fixed project revision                                                            |
| Export controls and completed-video list                                                                               | `render_start`, `render_status`, `render_cancel`                                                                                               | Existing immutable snapshots, options and real files. Retry reads failed options and submits a new `render_start` with current project revision                                                          |
| Open exported video, play/pause, seek, volume, mute, playback rate, retry and close                                    | `workspace_apply` with `video`; `workspace_get`                                                                                                | Actual mounted VideoPlayer returns decoded media state, loading, duration, errors and playback state                                                                                                     |
| Browser fullscreen                                                                                                     | `workspace_apply` with `fullscreen`                                                                                                            | Real browser request and read-back. User-activation restrictions return a structured error rather than success                                                                                           |
| Actual current viewport screenshot and evaluated geometry/constraints                                                  | `viewport_capture`, `viewport_inspect` with explicit workspace ID                                                                              | Current engine PNG, rendered world transforms and all constraint results; current project and browser revisions accompany the result                                                                     |
| Arbitrary observation preview and all contact diagnostics without an open editor                                       | `scene_view_capture`, `contact_constraints_inspect`                                                                                            | Isolated snapshot, actual SceneEngine and shared solver, explicit sequence/shot/source clocks and scene/take selection; MCP returns actual PNG image blocks                                              |

## Workspace Contract

`workspace_list` returns explicit tab IDs, connection freshness and the last reported state. Use `workspace_get` for a fresh browser read. Every directed operation requires `workspaceId`, `projectId` and `expectedRevision`; `expectedWorkspaceRevision` additionally guards against intervening user navigation or selection. Project edits use the normal persisted commands and their own revision/history contract. Workspace controls do not create project history entries.

`workspace_apply` requires a stable `requestId`. The server sends one request over a dedicated SSE connection; the browser validates its context, invokes the actual handlers, waits for the result and posts its acknowledgement. Repeating the same request returns its original outcome. Reusing an ID with different input fails. A tab cannot claim another tab's session, and registration/report/acknowledgement credentials are not exposed by the public list.

A disconnected, stale, loading or changed workspace returns a structured error. Requests time out after 15 seconds; an unacknowledged command has an uncertain outcome, not an implied rollback. Read current state before issuing a new command, and keep the same request ID for a transport retry. Sessions and UI state are transient; a server restart establishes a new session. Business documents, assets, upload receipts and history stay in SQLite and its referenced files.

Browser-native fullscreen or audible autoplay can require a user gesture. The MCP response must reflect the actual browser result. This restriction does not prevent muted playback, seeking, screenshots, durable editing, headless preview or video export.

The server allows 128 registered workspaces and 10,000 retained apply requests per session. Serialized apply request/result payloads share a 32 MiB retry-cache budget; a reported state is limited to 4 MiB. New applies that exceed the reservation budget fail before delivery. An oversized acknowledgement retains an explicit uncertain-outcome error, so repeating its request ID cannot execute the command again. Reads and captures are released after completion. Disconnected sessions become eligible for cleanup after 30 minutes; cleanup runs when registering a workspace.

## Agent Call Examples

The following objects are arguments to the MCP SDK's `client.callTool(...)`. Replace example IDs and revisions with values from `project_get` and `workspace_list`; they are not built-in scene or tab IDs. Check `isError` before using a result. JSON data is in a `content` block with `type: "text"`.

To control a particular open Web editor, first request its actual state:

```json
{
  "name": "workspace_get",
  "arguments": {
    "workspaceId": "workspace-id-from-list",
    "projectId": "project-id-from-get",
    "expectedRevision": 42
  }
}
```

Use the returned workspace `revision` as `expectedWorkspaceRevision`. This example moves that editor's free observation camera. Keep the complete request unchanged for retries; use a new `requestId` for a different action. Subsequent commands use the latest returned revisions.

```json
{
  "name": "workspace_apply",
  "arguments": {
    "workspaceId": "workspace-id-from-list",
    "projectId": "project-id-from-get",
    "expectedRevision": 42,
    "expectedWorkspaceRevision": 7,
    "requestId": "director-observation-001",
    "command": {
      "type": "observation",
      "view": "edit",
      "position": [4, 3, 6],
      "target": [0, 1, 0],
      "fov": 45
    }
  }
}
```

For an isolated observation without an open Web editor, select an explicit scene, performance and absolute source time. This does not move a user's viewport or change the saved project. Distances are meters, Y is up, angles are degrees and times are seconds.

```json
{
  "name": "scene_view_capture",
  "arguments": {
    "projectId": "project-id-from-get",
    "expectedRevision": 42,
    "context": {
      "kind": "source",
      "sceneId": "scene-id-from-project",
      "performanceId": "performance-id-from-scene",
      "sourceTime": 3.5
    },
    "view": "edit",
    "width": 1280,
    "height": 720,
    "observation": {
      "position": [4, 3, 6],
      "target": [0, 1, 0],
      "fov": 45
    }
  }
}
```

Keep both returned content blocks: the JSON includes project revision, resolved clocks, camera and evaluated geometry/constraints; the `image` block contains the actual PNG in base64 with `mimeType: "image/png"`. Preserve or decode those image bytes rather than discarding everything except the text block. `viewport_capture` uses the same image-block convention for an explicitly selected live Web workspace.

Inspect contacts at the same source time without requesting a PNG:

```json
{
  "name": "contact_constraints_inspect",
  "arguments": {
    "projectId": "project-id-from-get",
    "expectedRevision": 42,
    "context": {
      "kind": "source",
      "sceneId": "scene-id-from-project",
      "performanceId": "performance-id-from-scene",
      "sourceTime": 3.5
    },
    "objectIds": ["actor-id-from-scene"]
  }
}
```

The response includes every constraint on the selected actor, including inactive ones, with actual effector/target world positions, effective weight, error in meters and `solved`, `inactive`, `missing-target`, `unreachable` or `partial` status. Omit `objectIds` to inspect all actors. Use `{"kind":"shot","shotId":"...","time":1}` for shot-relative time, or `{"kind":"sequence","sequenceId":"...","time":1}` for edit time with retiming and independent camera clocks. Headless `view: "camera"` requires a shot in the selected context; it does not accept observation overrides.

## Chunked Transfers

Compute the complete file SHA-256 and call `transfer_begin` with `kind`, `name`, raw `size`, lowercase `sha256` and a stable `requestId`. Upload zero-based chunks of the returned `chunkBytes` size, except for the final remainder, with canonical base64 and each chunk's SHA-256. The server supports out-of-order chunks and identical retries. `transfer_status` exposes accepted digests and missing indexes. Conflicting replacement requires the old digest explicitly.

`transfer_commit` checks all chunks and the full hash, invokes the same validation as Web and atomically stores the imported result with its completion receipt. Repeating commit after a disconnect or restart returns the original result without duplicating the import or reactivating a different project. Failed validation retains the upload for correction. Cancel unfinished uploads to release staged files and reservations.

Retain the transfer ID and commit result: an asset import returns its actual local asset ID/name/URL, and a package import returns the restored editable project. After an interrupted call, `transfer_status` with that ID includes the final result; a repeated commit also returns it. This protocol transfers the file's real binary contents through base64 chunks, not a server-local file path. Download URLs returned by package export and completed render jobs identify the produced files; fetch and retain their response bytes for delivery.

## Verification Status

The capability map is verified by the shared command/service tests, actual workspace and headless browser tests, and [four real MCP-only package restorations](../.data/full-delivery/final-candidate-09/mcp-package-checks-complete/suite-report.json). The package suite uses 335 chunks and 492 successful public calls, checks all 257 original history snapshots and referenced binary content, edits/undoes, re-exports representative shots and verifies persistence after a real restart.

The [final candidate 10 runtime check](../.data/full-delivery/final-candidate-10/bounded-runtime-checks/runtime-report.json) verifies actual served source/build bytes, all four accepted projects and video hashes, and desktop/mobile MCP control of the real viewport and video player. Its 164 main-endpoint tool definitions exactly match candidate 09. These bounded checks supplement the broader candidate 08/09 evidence through the recorded source comparisons; they do not relabel earlier films or HTTP restoration as new MCP-only work. Engineering coverage and Git delivery are tracked separately in [full-delivery-matrix.md](full-delivery-matrix.md).

The frozen candidate 10 [completion report](../.data/full-delivery/final-candidate-10/checks-completion/verification-completed.json) and [current SDK audit](../.data/full-delivery/final-candidate-10/checks-completion/mcp-coverage-current.json) pass. All 165 distinct names across owner and review scopes have successful standalone invocations, including each of the 164 owner tools. The catalog checks each principal independently. The original missing-analyzer test environment failure remains recorded alongside the passing configured rerun; it did not require an application change.
