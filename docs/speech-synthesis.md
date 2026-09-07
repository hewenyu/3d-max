# Temporary Dialogue Synthesis

The Director panel can generate speech from dialogue text and place the resulting WAV file on the source timeline. This provides audible timing for previs, existing Rhubarb lip-sync analysis and white-model MP4 export.

## Local Engines

- macOS: built-in `say`, using the voices installed on that machine. `WHITEFRAME_SAY_PATH` overrides `/usr/bin/say`.
- Other platforms: install `espeak-ng`; `WHITEFRAME_ESPEAK_PATH` overrides its executable path. It is also usable on macOS.
- Both require FFmpeg and ffprobe on `PATH`. Synthesized files are normalized to mono 48 kHz PCM WAV and measured with ffprobe.
- `GET /api/speech/catalog` and MCP `speech_catalog` report exact installed voice IDs, languages and dependency diagnostics. Missing engines do not prevent editing/importing existing audio.

This is local temporary voice synthesis, not voice cloning, an emotional acting model or downstream AI video generation. Voice availability depends on the host. Rate uses each engine's words-per-minute control; language-specific timing comes from the measured output rather than a word-count estimate.

## Shared Operation

`POST /api/speech/synthesize` and MCP `speech_synthesize` call the same service. Required fields are `engine`, `voice`, `text`, `projectId`, `expectedRevision` and `requestId`. Optional fields are `rate` (80..350, default 180), `start`, `actorId`, `beatId`, `name` and `expectedContext`.

The operation synthesizes plain text, creates a real local asset, creates a source-time audio clip, and creates or updates a dialogue beat. A synchronization group links the beat and audio start so later timing edits move them together. Selecting `beatId` preserves the beat's actor/start unless overridden. Measured audio duration sets the beat's end; existing audio remains editable as an alternate and can be muted or deleted. Maximum input is 5000 characters and maximum output is 300 seconds; overlong output is rejected without truncation. Speech control codes and SSML are not supported.

The response extends `CommandResponse` with `speech: { audioId, beatId, assetId, url, duration, engine, voice, rate }`. Pass its `audioId` to `actor_face_lipsync_analyze` and apply the returned commands using the analysis revision/context. The face clip joins the same beat/audio synchronization group. Normal source-time playback, fades, retiming and export then apply.

## State Guarantees

Generation captures project revision and scene/performance context before invoking the native engine and rechecks them before committing. Existing beat, synchronization and performance locks are validated through shared editing commands. One history entry includes dialogue and audio; undo keeps the binary asset for redo and portable history.

Asset metadata and project edits commit in one SQLite transaction through `Store.commands`. Each attempt owns a unique generated file. Failed or superseded attempts remove only their own file. A stable request ID replays the stored response, including after restart; same-process duplicate requests share one pending generation, and concurrent Store instances converge on the first committed result. Reusing the request ID with different input returns `IDEMPOTENCY_CONFLICT`.

## Verification

`tests/speech-service.test.ts` covers durable and parallel retries, cross-instance file ownership, atomic rollback on revision/project changes, locks, undo/redo, inactive take preservation and dependency diagnostics. `tests/speech.spec.ts` generates actual Chinese speech through the UI and MCP, plays the generated audio, derives editable Rhubarb mouth cues, checks changing rendered pixels, and exports an 8-second 720p24 H264/AAC video with a non-silent decoded audio track. Its native-engine acceptance requires installed Chinese speech and Rhubarb capabilities; no fixture audio substitutes for synthesis.
