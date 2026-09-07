# Imported models and camera presets

## Imported GLB and glTF

The object inspector's imported-model section and `model_catalog` MCP tool expose the same parsed node hierarchy, skin/joint directory and animation catalog. Each animation includes a stable index, name, duration and target channels. Inspection uses glTF Transform's mature `NodeIO` parser with an explicit local-resource reader: the selected asset and previously registered local assets are readable; filesystem paths and network requests are rejected. Upload validation still requires glTF 2.0 with embedded or registered resources.

`model_animation_set({ id, animationIndex })` selects an embedded clip by index. `null` selects the static imported pose. Existing projects without a selection continue playing their first embedded clip; legacy named selections remain supported. Missing selections fail atomically instead of silently falling back. Selection is persisted, undoable, lock-aware and shared by UI, API and MCP. Actual rendering uses Three.js GLTFLoader, SkeletonUtils and AnimationMixer; the selected animation loops at source time in preview and export.

Imported rigs retain their own skeleton and embedded animation. Automatic retargeting of built-in actor actions to arbitrary imported rigs is explicitly unavailable. Unsupported required glTF extensions return an inspection error; no decoder or remote resource is silently fetched. This catalog does not flatten the imported model into editable project objects or claim per-bone manual editing of an arbitrary imported rig.

## Camera preset command

`camera_preset` is the MCP form of the shared `camera.preset` command. The inspector calls the same command for extreme-wide, wide, medium, close, detail, high, low, two-shot and over-shoulder compositions.

- `id`, `preset`: target camera and composition kind.
- `shotId`: resolves the shot-bound scene/performance. Required for cameras shared across different scene/performance contexts.
- `subjectIds`: optional explicit subjects; otherwise the shot's subjects or visible non-ground scene objects. Two-shot and over-shoulder require exactly two subjects. Over-shoulder order is foreground, then background.
- `sourceTime`: samples objects, hierarchy, attachment, IK and acting.
- `cameraTime`: optional separate key time, defaulting to source time.
- `mode`: `base` writes editable base parameters; `keyframe` creates or updates an editable key.
- `aspect`: optional independent `16:9`, `9:16` or `1:1` composition. Other aspect tracks remain unchanged.
- `side`: `left` or `right` over-shoulder placement.

Fitting uses projected world-space bounds and both horizontal and vertical field of view. This scales from a small prop to a large landmark and includes both people in a two-shot. Medium/close/detail crop the intended body or object region. High/low change elevation; low cameras stay above the subject's lower surface. Returned data contains editable position, target, field of view, sampled bounds, subjects, clocks and approximation diagnostics. Camera locks and locks on any referencing shot prevent changes.

Basic geometry, modeled meshes and the built-in actor rig use actual sampled geometry. Imported models and compound props currently use the conservative dimensions in the shared continuity scene; their IDs are explicitly listed in `approximateSubjectIds`. The command does not claim to evaluate imported animated skin envelopes or solve environmental occlusion automatically. Director continuity checks and manual camera edits remain available for those cases.

## Verification

`tests/model-catalog.test.ts` verifies actual GLB and embedded glTF with two skeletal animation clips, hierarchy, duration, static selection, invalid selection rollback, undo, locks, and blocked external resources.

`tests/camera-presets.test.ts` verifies 160 m landmark framing in three aspects, both moving subjects, left/right over-shoulder placement, separate actor/camera clocks, inactive bound scenes and shared-camera locks.

`tests/model-presets.spec.ts` imports a real skinned GLB through the UI, switches clips through UI and official MCP, checks distinct rendered poses, undo, reload, mobile layout, 720p/24 fps H.264 export and in-app playback. Export frame 24 is compared with the actual preview at source second 1. The same test invokes UI/MCP landmark, two-shot and over-shoulder presets and archives pixel checks and desktop/mobile screenshots under `.data/full-delivery/model-presets/checks`.
