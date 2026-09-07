# Facial Performance And Lip Sync

Built-in actors store optional `actor.face`; imported glTF models store `morph.face` and `morph.bindings`. Existing actors with no enabled face retain their previous rendered appearance. Each performance version captures its own face tracks, and scene templates remap their audio references. Object-only templates preserve editable cues while detaching external audio references.

The face sampler evaluates 15 normalized channels. Expression, eyelid and mouth channels use 0..1; horizontal and vertical gaze use -1..1. Sparse expression keys interpolate each channel independently using linear, smooth or step interpolation. The built-in Three rig changes brows, eyelids, pupils, lip geometry, mouth opening and a movable lower jaw. This is simplified white-model acting, not a production facial scan or a muscle simulation.

Lip-sync clips use source-time start/end and relative A..H/X cues. The A..F mouth shapes and extended G/H/X shapes follow Rhubarb's convention. Cue intervals must be ordered, non-overlapping and inside the clip. Clip weight, fade-in/out and a short mouth-shape transition remain editable. Expression channels survive lip-sync blending; mouth channels combine normalized active clip weights. Seeking backwards and rendering frames out of order produce the same result.

## Audio Recognition

`actor_face_lipsync_analyze` calls Rhubarb Lip Sync 1.14.0 against an uploaded audio asset. It crops the selected audio clip, decodes mono 16 kHz PCM with FFmpeg, and returns real phonetic recognition as editable cues. It does not infer phonemes from an amplitude envelope. Analysis is limited to 300 seconds per request.

- `phonetic` is Rhubarb's language-independent recognizer. Chinese and other non-English speech are supported as an initial blocking pass and require manual cue review; it is not a Mandarin phoneme aligner.
- `pocketsphinx` is English-only. Optional English dialogue text can help that recognizer.
- Audio must use the source clock. Independent sequence music does not drive the face. Retimed shots sample the same source-time face tracks as the body animation.
- Changing an audio source trim after recognition requires regenerating or manually editing cues. `audioSourceIn` records the trim analyzed. T04 links move clip boundaries and audio together, preserving relative cue times; they do not rerun recognition.

The read-only analysis response includes project ID, revision and scene/performance context, plus commands. Apply them using `edit_batch` with those same guards. The UI performs that guarded application automatically after its Analyze command and rejects a result if the project changed while recognition ran. `linkTiming` joins or creates a synchronization group with an `actor-face-clip` member.

Set `WHITEFRAME_RHUBARB_PATH` to the executable and preserve its sibling `res/` models. `actor_face_catalog` reports availability, engine version and compatibility. Missing or incompatible executables produce an explicit service error; manual/imported face editing remains available. Native Apple Silicon build instructions are in [rhubarb-native-build.md](rhubarb-native-build.md). Frozen-runtime launchers should use an absolute `WHITEFRAME_RHUBARB_PATH` because their working directory differs from the authoring checkout.

## Imported Models

`model_morph_catalog` reads actual glTF target names and exposes stable `mesh:N/primitive:N` keys. `model_morph_bindings_set` maps expression channels or `viseme:A` through `viseme:X` to these targets. Omitting `mesh` maps all matching targets; a primitive key scopes all instances of that source primitive. Mapping scale and offset are editable and final influences clamp to 0..1. A model without morph targets cannot acquire a facial rig through mapping alone.

The glTF mixer runs before face overrides. Each override saves the animation's current weight and restores it before the next mixer sample, including repeated seeks and constant tracks. Disabling the face or removing a mapping therefore preserves embedded animation. Valid models without normals receive computed vertex normals for white-model rendering.

## Public Editing Tools

`actor_face_set`, `actor_face_key_set/delete`, `actor_face_clip_set/delete`, and `actor_face_cue_set/delete` are the same atomic domain commands used by the inspector. Face clips export/import as editable JSON. Object/take locks, undo/redo, revision guards and synchronization membership validation apply normally.

JSON cue import captures the project and active scene/performance before reading the file. Switching contexts while the browser reads the file rejects the delayed edit, including when the destination contains an actor with the same ID.

## Verification

`tests/face-animation.test.ts` covers normalized blending, sparse channels, actual face geometry, legacy appearance, mixer restoration, invalid/orphan data, timing links and take/template isolation. `tests/face-animation.spec.ts` uploads real Chinese speech and glTF morph data through public MCP, runs Rhubarb, edits results through the UI, checks desktop/mobile rendering, and exports an eight-second H264/AAC 1280x720 video with 192 frames. Evidence is in `/tmp/whiteframe-face-qa`.

`tests/face-import-races.spec.ts` delays browser `File.text()`, switches project or performance through real MCP, and verifies both destinations remain unchanged. Normal import and undo still work after the rejection. Both checks passed in 8.0 seconds; inspected guard screenshots are under `.data/face-import-test-results/`.
