# Audio Editing And Crossfades

Reference audio supports source trim, duration, 0..2 linear gain, mute, clock selection and optional `fadeIn`, `fadeOut`, `fadeCurve`. The director inspector and public `audio_create` / `audio_update` commands edit the same persisted values. Fade durations are seconds on the audio clip's own clock: source seconds for `sync=source`, edit seconds for `sync=sequence`. Each fade must fit inside the audio duration. If the two fades overlap within a short clip their envelopes multiply.

`linear` uses a linear amplitude ramp. `equalPower` uses a quarter-sine ramp. Overlapping one audio clip's fade-out with another clip's fade-in creates an editable audio crossfade; complementary equal-power ramps preserve summed squared gains for unrelated sources. Visual transitions do not silently add or alter audio fades.

The shared `audioEnvelope` / `audioGain` functions evaluate the same phase used by playback and export. A shot cut, source trim or speed segment does not restart a fade:

- Ordinary browser audio retains native pitch preservation and uses a real Web Audio gain node. Gain above 1 is supported; the previous HTMLAudio volume clamp is removed. A 5 ms native smoothing constant avoids coarse animation-frame volume steps.
- Warped audio schedules gain automation against integrated source time, including a seek into the middle of a speed ramp. The same scheduler renders the offline warped waveform.
- FFmpeg applies `afade` against absolute asset source time before trimming and time stretching. The `tri` and `qsin` curves match the shared linear/equal-power definitions.

Audio remains scoped to the shot's scene and performance. Explicit overlapping tracks can crossfade where both are in scope. Automatic cross-scene audio handles and J/L-cut generation are not inferred from visual dissolve settings.

`tests/audio-envelope.test.ts` verifies envelope energy, transactional validation and actual FFmpeg samples across source cuts, trims and time stretching. `tests/audio-envelope.spec.ts` verifies UI/MCP persistence, native browser gain above 1 and the mobile inspector. The warp-audio browser suite compares sampled offline gain to the shared source-time envelope, including playback seeks. Evidence is written to `/tmp/whiteframe-audio-fade-qa`.
