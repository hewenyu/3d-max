# Lighting Plans

The original PRD's section 4.6, line 186, deferred reusable lighting setups. This module implements named, editable white-model lighting plans using the existing directional key light and ambient light parameters. It does not add professional material nodes, arbitrary light rigs or light animation.

## Data And Resolution

`Project.lightingPlans` stores up to 1,000 named plans. Each has a stable ID, name, lock state and four parameters: key intensity (0-10), ambient intensity (0-5), azimuth in degrees and elevation (-90 to 90 degrees). Both intensities use the same renderer scaling as the original base lighting. Angles and all other values must be finite.

A scene keeps its original `lighting` parameters and may select `lightingPlanId` as its default. The active scene projects these fields into `project.settings`; inactive scenes retain independent values. A shot may select its own `lightingPlanId`. The resolution order is:

1. Shot override, when filming a shot.
2. The shot's bound scene default, or the active scene default in the free/top viewport.
3. The corresponding scene's original base lighting.

An absent binding preserves older projects' rendering. Clearing a binding restores inheritance without copying over base values. A shot override remains attached to the shot when its scene/performance or camera changes. Takes within the same scene share its default lighting. Editing a plan affects all scenes and shots referencing it; command results include scene IDs, effective shot IDs and direct shot IDs. The environment panel also lists affected shot names.

`shared/lighting-plans.ts` supplies the same resolver for the main viewport and render engine. `SceneEngine.applySample` resolves lighting for every sample, including cuts between shots that share the same scene/performance resource binding. Preview images, sequence comparisons, transition samples and single-shot/sequence exports therefore use the same values. Render jobs keep their existing immutable project snapshots, including plans and bindings.

## Editing And Reuse

The environment tab contains the scene default selector and a separate plan editor. The editor creates, duplicates, renames, locks/unlocks and deletes unused plans, and edits all four numeric parameters. Selecting a plan for editing does not change its bindings. The shot tab has a separate lighting override selector, including an explicit scene-default option and its inherited name.

Duplicating a plan copies independent values and leaves existing bindings intact. Default duplicate names reserve room for the suffix within the 200-character limit, including names containing surrogate pairs. Duplicating an edit sequence also duplicates its directly bound shot lighting plans, preserving sharing among shots inside that new sequence. Scene-default lighting remains shared along with the existing scene geometry and performance. Scene copies retain their default plan reference. Scene templates capture only the required plans and remap them into independently editable plan IDs for each instance; object-only templates carry no lighting binding.

Plans are part of the validated project JSON stored in SQLite, so autosave, project import/export, project packages and undo/redo preserve them without a separate database or asset file. Required plan references are checked on imports as well as edits.

## MCP

All operations are shared domain commands, automatically registered through the official MCP server and usable inside `edit_batch`. Standard `projectId`, `expectedContext`, `expectedRevision` and `requestId` fields remain available. `project_get` exposes the plan library and bindings.

| Tool | Parameters |
| --- | --- |
| `lighting_plan_create` | `name`, optional `id` and `lighting`; omitted values copy the current resolved scene lighting |
| `lighting_plan_update` | `id`, `patch` containing `name`, `lighting` or `locked` |
| `lighting_plan_duplicate` | `id`, optional `newId` and `name` |
| `lighting_plan_delete` | `id`; all default/direct references must first be removed |
| `lighting_scene_bind` | `planId` or `null`; optional `sceneId`, otherwise the current scene |
| `lighting_shot_bind` | `shotId`, `planId` or `null` |

Locked plans only accept a separate unlock operation. Indirect changes to a locked scene, locked shot or shot in a locked sequence are rejected, including changes made through generic `project_settings` or `shot_update` commands. Unrelated plans remain editable. Deleting a referenced plan returns `IN_USE` and the affected IDs. Invalid values, missing IDs, revision conflicts and failed batches leave the saved project unchanged.

## Verification

- `tests/lighting-plans.test.ts`: eight domain checks cover precedence, inactive scenes, legacy fallback, independent duplication, referenced deletion, direct/indirect locks, invalid inputs, atomic rollback, sequence copies, maximum-length duplicate names and independently restored scene templates.
- `tests/lighting-service.test.ts`: official MCP discovery and successful invocation of all six tools, identical HTTP state, SQLite reopening, history undo/redo, idempotent retry, stale revision and locked-reference rejection.
- The targeted domain/service run also includes templates, production commands, production state and resource-cache regressions: 22 checks pass.
- `tests/lighting-plans.spec.ts`: actual environment/shot UI controls invoke all six commands; MCP edits update the UI, locked references disable controls, and reload/undo preserve state. Desktop and 390-pixel mobile controls are exercised, with real mobile numeric editing and undo.
- Immediate mobile editing followed by MCP undo exposed a shared input-display race: coalesced saved-value changes left a stale local draft visible. Number and text inputs now show drafts only while focused, and show saved values after blur. The test verifies immediate numeric and name undo; existing desktop/mobile camera controls, editor workflows and actual manual modeling also pass. The editor MCP-configuration check now compares the displayed endpoint with the service's actual connection URL so isolated ports are supported.
- The browser check renders a 3-second H.264 1280x720/24fps sequence with 72 decoded frames, using one camera and scene with two lighting plans. Changing a plan after export starts leaves the video snapshot intact. Four decoded video frames must match corresponding PNGs at SSIM >0.98. Actual MCP PNG bytes match the same frame rendered through the export bridge; same-pose images differ between plans, animation changes pixels, and repeated seeking reproduces identical PNGs.

Isolated module evidence is under `.data/lighting-test-results/lighting-plans-editable-sc-3baa1-d-match-real-PNG-MP4-frames/`, including `verification.json`, the editable `project.json`, `lighting-sequence.mp4`, decoded/expected frame pairs, same-pose lighting comparisons and desktop/mobile screenshots. The built frontend is `.data/lighting-dist`; its temporary test service uses port 4240 and isolated SQLite storage. These module results do not replace final frozen-source acceptance or resolve the other historical scope rows.
