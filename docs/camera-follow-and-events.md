# Attached Prop Follow and Motion Events

## Camera Follow

The existing `camera.motion` command and MCP `camera_motion` tool now accept subjects attached to animated actor bones, props passed between actors, detached props, and descendants of attached objects. The Web camera motion panel includes these subjects in its selector.

`shared/camera-subject.ts` selects the existing transform-only path for ordinary objects and transformed parents. When the subject depends on an attachment, it uses `ContinuityScene.sampleTransforms`, which applies the shared actor rig, gait distance, look-at behavior, attachment hierarchy, and contact constraints before reading the world matrix. Sampling does not duplicate actor animation logic. The rig is disposed after keyframe generation. Unattached vehicle and spacecraft follow does not build an actor scene.

Follow creates ordinary editable camera keys at project frame rate. Attachment handover/detachment times are included exactly, with a preceding sample and a step at the event boundary to retain both continuous approach and discrete attachment changes. `rotateWithSubject` transforms both camera position and aim through the sampled subject matrix, including moving parent transforms and bone rotations.

Optional `sequenceId` and `clipId` select an exact occurrence for time mapping. `start` and `end` remain ascending camera-clock bounds. The command samples the subject through that clip's source-time curve while writing camera-clock keyframes; the initial pose is the beginning of clip playback, including a reversed camera clock. Optional `shotId` resolves its scene and performance and must match the selected clip and camera. Without clip context, the original source-clock behavior remains. No occurrence is inferred from a repeated shot.

The UI passes the current clip automatically. Independent camera rates accept -16 through 16, with both ends and dissolve handles constrained to 0..86400 seconds. A zero-rate camera clock cannot encode a moving follow path and is rejected by the command and disabled in the generation control. Timeline camera markers map reversed clocks back to edit time. Camera keyframes remain shared by clips using the same camera; this command does not create a separate camera track for each occurrence.

Validation:

- `tests/camera-motion.test.ts`: constrained contacts, two-actor handover, transformed moving parents, attachment descendants, arbitrary seek order, non-frame-aligned handover/detach, mounted camera pose, previous dolly/orbit/vehicle regressions.
- `tests/camera-motion-timing.test.ts`: normal/source clocks, smooth ramps, independent reverse clocks, repeated clips, shot-bound inactive performances, reverse handover steps and mounted poses, context validation and clock/transition bounds.
- `tests/camera-motion-timing.spec.ts`: current repeated-clip UI generation, reverse timeline key placement and seeking, identical MCP generation, renderer frame-center agreement, repeated pixels, and desktop/mobile layout.
- Timing integration and the original attached-prop browser regression passed together in 12.2 seconds. Inspected timing evidence: `.data/camera-timing-test-results/camera-motion-timing-activ-1f5ff-e-held-prop-at-frame-center/`, including `camera-time-evidence.json`, desktop/mobile screenshots and `camera-time-render.png`.
- `tests/continuity.test.ts`: shared sampler regression checks.
- `tests/camera-prop.spec.ts`: actual UI selection/generation, MCP mounted follow and undo, MCP PNG capture before/after handover, actual renderer contact and projected-target agreement, deterministic repeated PNG, desktop/mobile layout. Final isolated run passed in 7.3 seconds.
- Inspected evidence: `.data/camera-prop-test-results/camera-prop-attached-prop--1a891-er-bones-through-a-handover/`, including `prop-follow-evidence.json`, desktop/mobile screenshots and MCP PNGs at 0.5 and 2.5 seconds.

## Motion Events

The object path/vehicle panel now offers an editable event track. Users can add, select, edit and delete collision, impact, projectile and explosion records. Fields cover source time, duration, strength, related object, and world-space position. Strength is generic event metadata and is not mislabeled as Newtons. Event records describe timing/contacts; visible effect geometry remains a separately editable effect object.

The shared `motion.events.set` command, exposed as MCP `motion_events_set`, validates and chronologically sorts complete event tracks. It uses the same transaction, revision, active scene/performance context, object/parent lock, related-object reference and synchronization rules as other edits. The UI builds edits from the latest queued project state. Deleting a synchronized event unlinks that member and removes the event in one undoable transaction; a locked synchronization group prevents changing its event time or deleting it. Other event metadata remains editable when only synchronized timing is locked.

Validation:

- `tests/motion-events.test.ts`: duplicate IDs, invalid references/durations, chronological ordering, parent locks, independent take ownership, synchronized timing propagation, locked groups, and explicit unlink-before-delete.
- `tests/motion-events.spec.ts`: actual UI creation/field edits, MCP changes reflected in UI, linked keyframe movement, group/object lock controls, atomic deletion/undo of event and group, reload, and desktop/mobile layout. Final isolated run passed in 15.4 seconds.
- Inspected evidence: `.data/motion-events-test-results/motion-events-event-UI-cre-8b49c-ame-reversible-MCP-commands/`, including `motion-events-evidence.json` and desktop/mobile screenshots.

Timeline event markers are owned by the timeline integration and are verified separately.
