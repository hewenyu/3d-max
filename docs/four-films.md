# Four Films: Delivery Evidence

Audit date: 2026-09-07. This document identifies the four accepted film artifacts and the evidence behind their required content. The latest application checks are recorded under [Final Application Revalidation](#final-application-revalidation); the current application is candidate 10 at [http://127.0.0.1:4219](http://127.0.0.1:4219), with playback, download and editable-package links in [delivery-runtime.md](delivery-runtime.md). Overall application and release acceptance is recorded separately in [full-delivery-matrix.md](full-delivery-matrix.md).

All paths below are relative to `.data/full-delivery/productions/` unless stated otherwise. Each theme directory contains the editable `export-project.json`, `export-job.json`, actual MP4, `ffprobe.json`, `review/review.json`, contact sheets, MCP journal and portable project package. `project.json`, `delivery-project.json` and source transfer packages can represent earlier authoring states; use the final export snapshot and revision listed here.

## Artifact Identity

All four final jobs are `completed`, with H.264 video, AAC audio, 1280 x 720, 24 fps, 16:9, `includeAudio=true` and `burnIn=false`. Together they contain 12,108 encoded video frames over 504.5 seconds (8 minutes 24.5 seconds). Each individual film exceeds or meets the required 120 seconds and 2,880 frames.

| Film         | Editable official project ID           | Revision | Final job ID                           | Seconds | Frames | MP4 bytes |
| ------------ | -------------------------------------- | -------- | -------------------------------------- | ------: | -----: | --------: |
| Martial arts | `f4f4b53b-fd4d-4002-8591-0f3e566fc8f7` | 34       | `2143a917-acc5-4fd2-8e0a-bf338d7c416d` |     134 |   3216 |  17276444 |
| Racing       | `a54636d3-bdba-402c-bdd1-01b2568cfda1` | 41       | `01b4ea92-0b82-4d37-9c13-c839be5583fb` |   122.5 |   2940 |   9974443 |
| Space combat | `f6fea4fb-95eb-48ae-b8eb-60d2b1129c68` | 106      | `b4cd9819-778b-475c-84cc-277fc6c6831d` |     120 |   2880 |   6040305 |
| Tourism      | `91b48286-6aa3-4823-b93b-f9259c28026b` | 72       | `6b3b8927-e2ac-4286-936d-8190fab5d287` |     128 |   3072 |   9019589 |

The following SHA-256 values were checked against the actual files, independently of their report strings.

| Actual video path     | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `martial/martial.mp4` | `6640c26ae80ed54977ba21865dd64171d9a1a80c960d6f4048225dd8ae01c5d1` |
| `racing/racing.mp4`   | `48ba73f686246fb1fa99ed06dc73fa982a9ad92fc5c362cc4bfce78c81269ae7` |
| `space/space.mp4`     | `b04723f299969f9d5129b1301c3a8ca0867831b089675c2331b2e71d74f0d650` |
| `tourism/tourism.mp4` | `e3c80d3c3bb131b2a3f5d134b877123a7fdca480fe2be1c3aa9a941ef755f035` |

The separate `<theme>-video.mp4` files are the downloads used by the full playback review and carry these same hashes. Tourism's diagnostic film also has the same final video hash; its earlier diagnostic project revision is not the delivered editable revision.

### Runtime Provenance

These films were produced with the frozen renderer in `.data/releases/film-render-01`, whose `runtime-manifest.json` records source hash `2d828adec487e2ea30a27e19140d7385503c1c8e06e7b5ce304b66c4d92999d2`, created at `2026-09-07T02:04:48.154Z`. This is a source manifest hash, not a Git commit. Later product changes require their own final runtime regression.

The official production API was `http://127.0.0.1:4210`. The space package was subsequently exported by the current package service on 4225 from an isolated snapshot, preserving the accepted r106 project and film. Package transport changes do not change the film renderer provenance.

`racing/runtime-review/runtime-verification.json` compares 30 rendered samples against the official film, confirms the accepted project snapshot and served video bytes, and records SSIM 0.995653 or higher. `tourism/frozen-runtime-comparison.json` records matching hashes for 49 renderer/domain source files, while the diagnostic and final MP4 hashes establish the actual video identity. Neither report substitutes for the new final application regression.

## Review Method And Limits

The existing reviews downloaded the actual completed job, counted all decoded video frames with `ffprobe`, ran full `ffmpeg` decoding with black/freeze detection, played the complete film in the application, and captured desktop/mobile screenshots. This audit reread those records and inspected all 17 existing contact sheets. It did not replay or rerender the full films.

Every review records `fullInAppPlayback.completed=true`, no JavaScript errors, zero detected black spans, and zero frozen spans longer than one second. The contact sheets use one sample per two-second interval, in reading order, 16 cells per sheet. Their approximate intervals are sheet 1: 0-32s, sheet 2: 32-64s, sheet 3: 64-96s, sheet 4: 96-128s, and martial sheet 5: 128-134s. They locate content but do not prove the timing of subsecond contacts; the source timeline, numeric reports and full playback supply that evidence. Black unused tail cells are sheet padding, not video frames.

| Film         | Full playback endpoint | Browser total frame counter | Dropped display frames | Independently decoded encoded frames |
| ------------ | ---------------------: | --------------------------: | ---------------------: | -----------------------------------: |
| Martial arts |                   134s |                        3217 |                    301 |                                 3216 |
| Racing       |                 122.5s |                        2943 |                    488 |                                 2940 |
| Space combat |                   120s |                        2886 |                     93 |                                 2880 |
| Tourism      |                   128s |                        3076 |                     69 |                                 3072 |

Browser counters include display scheduling and earlier player activity; they are not encoded frame counts. Playback completed under concurrent workstation load, with dropped display frames as recorded above. This evidence proves complete media and successful playback, not flawless realtime presentation on every device. Full decoding and sparse visual inspection also do not establish pixel-perfect absence of every possible intersection.

Some earlier fields are stale: racing and tourism `ffprobe.json.visualReview` still say pending, and racing/space `production-report.json.review` retain pre-export wording. The matching final `review/review.json` records, final job/revision/hash and actual file checks establish which review applies. The older space r90 film is not the accepted r106 film.

## Mandatory Content By Film

All intervals below use seconds on the final edit timeline. Source time is explicitly identified where speed changes make it different. Shot identifiers, source intervals and independent camera settings were read from the final export snapshots, then checked against the existing rendered sheets and review records.

### Martial Arts

The 30-object courtyard project contains two named actors, 16 cameras/shots, 23 authored exchanges, five contact constraints and 16 audio placements from three retained assets.

| Required content                                                | Final shot/time evidence                                           | Rendered and numeric evidence                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Space establishment and two-person confrontation                | `martial-shot-0`, 0-8s; shot 1, 8-16s                              | Sheet 1 opens on both actors in the same courtyard, then a closer two-person exchange.                                                                    |
| Attack/defense changes, block, dodge and low attacks            | Shots 2-4, 16-40s                                                  | Sheets 1-2 show over-shoulder defense, low-angle kicking and side action; authored contact windows include 20.58s and 39.67s.                             |
| Hit, fall, weight change and recovery                           | Shots 5-6, 40-56s; shots 13-14, 110-126s                           | Sheets 2 and 4 show backward reaction, grounded body and return to standing, rather than resetting between shots.                                         |
| Pickup, weapon holding and weapon exchanges                     | Shots 6-10, 48-88s; shot 12, 102-110s                              | Sheets 2-4 show approach to the props, hand attachment, paired raised staffs, lateral tracking, overhead spacing and close weapon/hand framing.           |
| Normal speed, slow motion, normal speed with independent camera | Shot 11, 88-102s; source 88-96s                                    | One continuous source interval is time-remapped from 8s to 14s. Sheets 3-4 retain both actors and raised staff tips; the camera has an independent clock. |
| Tracking, detail and reaction coverage                          | Shots 4/9, 32-40s and 72-80s; shot 12, 102-110s; shot 13, 110-118s | Closer coverage and the later reaction/fall are visible; intentional close crops are recorded by the full review.                                         |

Shot 11 uses 1s at 1x, a 2s smooth ramp from 1x to 0.25x, 6s at 0.25x, a 2s ramp back to 1x, and 3s at 1x. Its camera uses source-in 88s at independent rate 1. Audio follows the configured warp. This is animation resampling, not repeated rendered frames.

`martial/numeric-review.json` sampled all 3,216 output frames at r34: no bad frames or unreachable contact frames; lowest supported body point was -0.000499994m within the declared 0.5mm floor tolerance; maximum grip offset 0.000009113m; worst full-weight contact error 0.000009625m; minimum torso-center distance 0.530420m. Both pickup attachment switches have sub-4-micrometer sampled jumps. These are solver/proxy checks and do not replace the visual review. `delivery-transfer.json` connects the numeric report's authoring ID to the official r34 project.

### Racing

The 78-object project contains three vehicles, ten cameras/shots, a continuous 112-second source performance, and a 122.5-second edit.

| Required content                                                | Final shot/time evidence              | Rendered and numeric evidence                                                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multiple moving vehicles, acceleration and wide spatial context | `race-shot-1`, 0-10s; shot 2, 10-20s  | Sheet 1 shows the starting formation and changing roadside geometry in low tracking coverage.                                                                                      |
| In-car and side pursuit cameras                                 | Shot 3, 20-30s; shot 4, 30-42s        | Sheets 1-2 show windshield/steering-wheel foreground followed by the three cars side by side.                                                                                      |
| Turns and overtakes                                             | Shot 5, 42-54s; shot 9, 92.5-106.5s   | Sheets 2 and 4 show relative lane/longitudinal changes. Source B-relative-to-A position changes sign from +15.61m at t30 to -8.14m at t42, later +20.01m at t62 and -8.30m at t96. |
| Drift and continuous normal/slow/normal action                  | Shot 6, 54-72.5s; source 54-62s       | Sheets 2-3 show angled car bodies through the bend; the authored drift reaches 24 degrees. The eight-second source interval becomes 18.5s.                                         |
| Following, vehicle posture and road progression                 | Shots 7-8, 72.5-92.5s                 | Sheet 3 shows low front tracking and repeated roadside gantries advancing through the frame.                                                                                       |
| Finish and deceleration                                         | Shot 10, 106.5-122.5s; source 96-112s | Sheet 4 follows all three cars through the finish region; the source speed profile changes through the final approach.                                                             |

Shot 6 uses 1s at 1x, a 2s ramp to 0.25x, 12s at 0.25x, a 2s ramp to 1x and 1.5s at 1x. Camera source-in is 54s with independent rate 1; audio uses the configured warp. Vehicle paths, speed curves and wheel/body state remain editable separately from the camera keys.

`racing/frame-motion-verification.json` checks all 2,940 r41 output frames: no static intervals, no conservative vehicle-dimension OBB overlaps, minimum active movement 0.221543m per output frame, and minimum vehicle-center separation 4.476324m. Every shot has at least one vehicle center visible in every sampled frame. These are scene-data checks; the full review confirms the actual car, cockpit and road images. The transfer report connects the authoring ID used by this numeric report to the official r41 project.

### Space Combat

The final 66-object r106 project contains five craft, ten cameras/shots, 17 projectile objects, two destruction sequences and eight debris objects with zero-gravity Rapier motion baked at 120Hz to editable 24fps tracks.

| Required content                             | Final shot/time evidence                                | Rendered and numeric evidence                                                                              |
| -------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Multi-craft 3D formation and pursuit         | `space-shot-1`, 0-12s; shot 2, 12-24s                   | Sheet 1 shows the full formation and then closer pursuit, with contrasting neutral craft values.           |
| Attacks, tracking and position relationships | Shot 3, 24-36s; shot 5, 48-60s                          | Sheets 1-2 show pursuers, defenders and projectile paths; a hit is placed at 58s.                          |
| Rolling evasion and changing orientation     | Shot 4, 36-48s                                          | Sheet 2 shows rolled/inverted craft orientations with asteroid and planet parallax.                        |
| Hit feedback and first destruction           | Shot 6, 60-72s; enemy destruction at 62s                | Sheets 2-3 show the expanding geometric explosion and debris replacing the destroyed craft.                |
| Three-dimensional route and continued chase  | Shots 7-8, 72-96s                                       | Sheet 3 shows the asteroid corridor and surviving pursuer with changing foreground scale and viewpoint.    |
| Second attack, destruction and resolution    | Shot 9, 96-108s, destruction at 103s; shot 10, 108-120s | Sheet 4 shows the second expanding explosion followed by the surviving formation moving toward the planet. |

`space/frame-motion-verification.json` explicitly targets the final official r106 project and all 2,880 frames. It records no static intervals or vehicle-dimension OBB overlaps, minimum active craft movement 0.394872m per output frame and minimum craft-center separation 25.925627m. No shot has a frame with every craft center outside its frustum. These checks concern craft proxies, not every projectile/debris surface.

The full review covers all 60 contact-sheet samples, eight desktop playback captures and mobile playback. R106 adjusts the earlier wide framing so evasion and impacts are more legible. Its accepted job and hash are listed above; the package also preserves the earlier r90 export as history.

### Tourism

The 227-object r72 project contains 12 cameras/shots and a connected harbor, old town, monastery and observatory landscape. Architecture uses editable geometric components, a Boolean arch passage, reusable column templates, terrain and a long curved road.

| Required content                                          | Final shot/time evidence       | Rendered evidence                                                                        |
| --------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| Terrain, multiple regions and aerial opening              | `travel-shot-1`, 0-10s         | Sheet 1 establishes harbor, town, rising terrain and inland route.                       |
| Ground push and actual architectural passage              | Shots 2-3, 10-30s              | Sheet 1 advances along the seawall, approaches the arch and passes into the colonnade.   |
| Reused assets, parallax and ground-level lateral movement | Shot 4, 30-40s                 | Sheets 1-2 show successive columns and foreground shadows moving across the view.        |
| Landmark orbit and detail changes                         | Shot 5, 40-50s; shot 6, 50-58s | Sheet 2 circles the plaza monument and moves to close geometric detail.                  |
| Long-distance smooth route and mountain architecture      | Shot 7, 58-72s; shot 8, 72-84s | Sheets 2-3 travel along the road toward the monastery, then approach its facade.         |
| Viewpoint reversal and region relationships               | Shot 9, 84-94s                 | Sheet 3 looks back toward the town/harbor with terrace railing in the foreground.        |
| Observatory approach, close orbit and closing pullback    | Shots 10-12, 94-128s           | Sheets 3-4 climb the ridge, inspect the dome, then pull back to reconnect the landscape. |

All 64 contact-sheet samples and the complete 128-second in-app playback were reviewed. There are no object-animation keys because this film's continuing motion is in its cameras; the rendered parallax and full freeze check establish moving content rather than a static-frame duration extension.

`tourism/continuity-report.json` checked 407 samples at its configured rate and records six retained findings: two colonnade beam occlusions at 20-23.33s, a departing beam at 39.958s, plaza-floor occlusion at 84-93s, dome occlusion of its base at 114-127.958s, and the monastery outside the initial closing composition at 114-114.33s. The visible arch reveal, lateral move, terrace vista and final pullback support these deliberate framings. The findings are not silently treated as zero warnings or proof of universal visibility.

## Portable Projects And Reopening

The tables in this section retain the original mixed-transport restoration evidence. All four packages subsequently passed the [candidate 09 MCP-only suite](../.data/full-delivery/final-candidate-09/mcp-package-checks-complete/suite-report.json), including the racing and space archives. It uploads 335 chunks through public MCP, verifies all 257 original ordered history snapshots and exact binary assets/videos, exercises edit/undo and four actual representative-shot exports, and repeats persistence/commit-replay checks after a real process restart. The new exports total 42 seconds/1008 frames. See [package validation](project-packages.md#validation) for the exact-baseline comparison used for two independently encoded interior shots and its preserved calibration evidence.

The actual compressed package bytes were hashed and parsed through the product's read-only `readPackageRecords` decoder. All four package project objects deeply equal their final `export-project.json`; every embedded asset and video byte hash matches its manifest. This check did not open or mutate the official SQLite store.

| Package path                 |     Bytes | History snapshots | Assets | Archived videos | SHA-256                                                            |
| ---------------------------- | --------: | ----------------: | -----: | --------------: | ------------------------------------------------------------------ |
| `martial/martial.whiteframe` |  19135744 |                35 |      3 |               1 | `6561ec7cfc129ba2ac7acf2c22f6f78c5bb605b1f18bad6900fd9c75d6b08e40` |
| `racing/racing.whiteframe`   |  50292001 |                42 |      1 |               1 | `3c73b9790f5e356adeeda399f58efecc3424d21b81a763cf7c417fb57e7ef4e4` |
| `space/space.whiteframe`     | 256528195 |               107 |      1 |               2 | `ff55e3fce597860b4a51f3a0d5a656dae8ab087e11c11e2deb89c02eb72dccdc` |
| `tourism/tourism.whiteframe` |  23209006 |                73 |      1 |               1 | `dce5231d46b3528b8bc810068ebbce711021625d9834f9808922af9fac16e150` |

Space's second archived video is the earlier r90 job `9a8cf000-e574-4c15-a3f9-90df2cd9b0ad`, SHA-256 `aaee8103a1b58cfacbf7fbc1ad7533e3ab859108c4ea4774172f9f8a7a61f8b8`. The accepted final video remains r106, job `b4cd9819-778b-475c-84cc-277fc6c6831d`.

Each restoration used isolated storage, imported required assets and videos, changed a camera through MCP, captured changed pixels, undid the edit to the exact original PNG hash, and freshly exported the first shot. The reexports are silent H.264 720p24 videos; restored original films retain their AAC tracks.

| Film         | Restored project ID                    | Import / edit / undo revision | Import transport           | First-shot reexport         | Decoded SSIM against original |
| ------------ | -------------------------------------- | ----------------------------- | -------------------------- | --------------------------- | ----------------------------: |
| Martial arts | `5c905a48-9ebd-4cd0-b9a8-138dbf922cbe` | 34 / 35 / 36                  | MCP, 25514328 base64 bytes | `martial-shot-0`, 8s / 192f |                      0.999979 |
| Racing       | `19697473-a302-47d2-92cb-8c131218303c` | 41 / 42 / 43                  | HTTP multipart             | `race-shot-1`, 10s / 240f   |                      0.999992 |
| Space combat | `7d6bf970-1ad8-4ee3-b7c8-b93380fa67ac` | 106 / 107 / 108               | HTTP multipart             | `space-shot-1`, 12s / 288f  |                      0.999999 |
| Tourism      | `4ed9c47e-0aff-4c44-8de8-6d3d1dc92cea` | 72 / 73 / 74                  | MCP, 30945344 base64 bytes | `travel-shot-1`, 10s / 240f |                      0.999997 |

The camera edits target `martial-camera-0`, `race-camera-1`, `space-camera-1` and `travel-camera-1`. Original and undone PNG hashes match exactly in each `package-restoration-report.json`; edited hashes differ. The clean Store's automatically created demo explains `projectsBefore=1`. Racing and space use HTTP multipart because their base64 packages exceed the MCP input's 32MiB bound; subsequent edits, undo, previews and rendering still use MCP.

Tourism has `portable-package.json` instead of `package-export-report.json`. It records package ID `a4091a70-016a-4eef-9be1-cd2ccc585884`, official r72, the same byte count/hash and downloadable asset. The actual package parse verifies 73 history snapshots and the final film, so the different report filename is not missing export evidence. Its restoration report omits transport, initial revision and shot ID; the journal supplies those fields as shown below.

### Restart Evidence

All four `package-restart-report.json` files now confirm a newly started service reads the restored project, with content equal to the accepted source after excluding identity/revision/timestamp, intact undo/redo, available binary assets, and matching original and reexported video hashes.

| Film         | Restart API             | Restored revision | Assets checked | Completed original/reexport videos | Result |
| ------------ | ----------------------- | ----------------: | -------------: | ---------------------------------: | ------ |
| Martial arts | `http://127.0.0.1:4225` |                36 |              3 |                                  2 | Passed |
| Racing       | `http://127.0.0.1:4223` |                43 |              1 |                                  2 | Passed |
| Space combat | `http://127.0.0.1:4223` |               108 |              1 |                                  3 | Passed |
| Tourism      | `http://127.0.0.1:4222` |                74 |              1 |                                  2 | Passed |

The martial and tourism checks started new current-API processes against the original, inactive isolated restoration directories `.data/martial-package-restoration.Ag2O8T` and `.data/tourism-package-restore`, using the frozen renderer directory. Both services were stopped after verification. No scene edit, reimport or official 4210 store access was needed. Tourism's retained failed r71 diagnostic job is historical and is not counted as a completed film. The restart verifier falls back to reading asset manifests from the actual package when the optional `package-export-report.json` is absent.

## MCP Production Trace

Each `mcp-operations.jsonl` records real calls with arguments, timestamps, error state and response hashes. Binary payloads are omitted from this document. Journals include unsuccessful early attempts and follow-up edits, so line counts are audit locators rather than a success rate or a claim that every line authored the accepted scene.

| Film         | Blank project                           | Final render            | Final package export | Clean import   | Camera edit / undo / reexport |
| ------------ | --------------------------------------- | ----------------------- | -------------------- | -------------- | ----------------------------- |
| Martial arts | line 4, `project_new`, `template=empty` | line 115, official r34  | line 118             | line 120       | lines 123 / 125 / 127         |
| Racing       | line 1, `project_new`, `template=empty` | line 78, official r41   | line 82              | line 84, HTTP  | lines 87 / 89 / 91            |
| Space combat | line 1, `project_new`, `template=empty` | line 161, official r106 | line 212             | line 214, HTTP | lines 217 / 219 / 221         |
| Tourism      | line 3, `project_new`, `template=empty` | line 140, official r72  | line 458             | line 460       | lines 463 / 465 / 467         |

Tourism line 463 explicitly edits restored r72 via `camera_update`; line 467 exports `travel-shot-1` after undo at r74. These calls connect its thinner restoration report to the actual package. The journals also retain public `edit_batch`, `preview_capture`, camera/actor/template operations and space `simulation_bake` calls used in production. Authoring scripts under `scripts/production/` generate data through these product operations; the actual films come from the product render jobs.

## Final Application Revalidation

Current runtime candidate 10 is frozen at source hash `df0bdc0861b797fb24fdd4cf2b73ffba689826c05d9297648cc7d69b728c2b90`. Candidate 08 added full Web/MCP controls, candidate 09 changed only three production verifiers, and candidate 10 fixed only the browser-test proxy for the streaming workspace connection. Application, engine, server, dependencies and all eight built distribution files are identical across 08/09/10; the [08-to-09](../.data/full-delivery/final-candidate-09/candidate-source-comparison.json) and [09-to-10](../.data/full-delivery/final-candidate-10/candidate-source-comparison.json) comparisons retain the exact file lists.

Candidate 08's [new runtime comparisons](../.data/full-delivery/final-candidate-08/runtime-verification-summary.json) pass all 144 sampled frames with minimum SSIM 0.994569, exact accepted project snapshots and matching served MP4 hashes. Candidate 09's [actual film UI report](../.data/full-delivery/final-candidate-09/film-ui-checks/film-ui-report.json) passes all eight desktop/mobile cases, four byte-identical official PNGs, eight downloaded video hashes and 24 seeks. Its [24-screenshot review](../.data/full-delivery/final-candidate-09/film-ui-checks/manual-visual-review.json) accepts the inspected layouts and actual players. Maximum seek error is 0.037371134 seconds; minimum measured ruler-label gap is 26.734 pixels. Short playback totals 23.725 seconds with five dropped display frames under concurrent load and no browser/player errors. These are sampled and short-play checks, not new full-film reviews or isolated performance measurements.

The new [four-package MCP-only recovery](../.data/full-delivery/final-candidate-09/mcp-package-checks-complete/suite-report.json) and process restart pass. Candidate 10's [bounded runtime check](../.data/full-delivery/final-candidate-10/bounded-runtime-checks/runtime-report.json) separately verifies all four exact saved projects and complete stream/download hashes, plus actual desktop/mobile MCP workspace and player controls. Its [eight-image manual review](../.data/full-delivery/final-candidate-10/bounded-runtime-checks/manual-visual-review.json) passes with nonblank rendered media and contained controls. These two short playback cases total 4.56734 seconds, with six dropped display frames under concurrent load and no browser/player errors. The following records preserve the earlier complete-film production, playback and review evidence at its original versions.

Candidate 03 (`8d0b6dd679bb8875589cec93115a3b4393eafbbef1582d87bcaf6d14a0795de3`) repeated actual preview-to-film comparisons, complete normal-speed playback and clean package recovery. Reports remain under `.data/full-delivery/final-candidate-03/productions/<theme>/{runtime-review,final-review}/`; they have not overwritten or relabeled the original production evidence above.

| Film         | Compared runtime frames | Minimum SSIM | Full playback at 1x | Browser final frame counter | Dropped display frames |
| ------------ | ----------------------: | -----------: | ------------------: | --------------------------: | ---------------------: |
| Martial arts |                      48 |     0.994659 |                134s |                        3216 |                      6 |
| Racing       |                      30 |     0.995653 |              122.5s |                        2940 |                      3 |
| Space combat |                      30 |     0.996801 |                120s |                        2883 |                      1 |
| Tourism      |                      36 |     0.994569 |                128s |                        3072 |                      7 |

All 144 comparisons pass the unchanged SSIM >0.98 gate, cover every cut boundary and shot midpoint, and confirm exact accepted project snapshots and served MP4 hashes. Full decoding of all 12,108 encoded frames reports no black spans or frozen spans longer than one second. All four complete in-app plays have no JavaScript errors. The director inspected all 17 contact sheets, desktop/mobile player captures and selected low-SSIM pairs; per-film `visualReview` records findings and limits. Sparse samples do not prove every surface contact, and display counters collected during concurrent regression activity are not an isolated performance benchmark.

The candidate 03 [package verification](../.data/full-delivery/final-candidate-03/package-checks/verification.json) passes eight checks: four clean imports followed by four checks after a real process restart. Original media hashes, project assets and undo/redo survive; actual MCP camera edits change pixels, undo restores byte-identical PNGs, and newly exported 192/240/288/240-frame shots have SSIM 0.999979/0.999992/0.999999/0.999997. Exact reports retain their restored project IDs and process identities.

Candidate 04, source hash `765b05b1b9f30815243e872d2e18119e5c944499b893e74d7688a06a05884897`, is historical. Its [source comparison](../.data/full-delivery/final-candidate-04/candidate-source-comparison.json) proves all application sources, dependency files and built assets are identical to candidate 03; only two browser test files and the production test selection changed. The separate candidate 04 [runtime entry check](../.data/full-delivery/final-candidate-04/runtime-entry-check/verification.json) opened all four projects through real MCP and verified accepted snapshots, completed job revisions and served video SHA-256 values on port 4214.

Candidate 05, source `97dc1c04618b73416aae1a79555722a016edfbda39b1781eb4f4b08fb46ca4d6`, includes the observation-navigation fix and repeats all 144 actual preview-to-film comparisons. Reports are under `.data/full-delivery/final-candidate-05/productions/<theme>/runtime-review/runtime-verification.json`. Counts and minimum SSIM remain martial 48/0.994659, racing 30/0.995653, space 30/0.996801 and tourism 36/0.994569. Every project equals the accepted snapshot and served MP4 hashes match. Its [eight-case UI check](../.data/full-delivery/final-candidate-05/ui-spot-check.json) verifies short desktop/mobile playback, navigation independence and four real desktop downloads. The [visual review](../.data/full-delivery/final-candidate-05/ui-visual-review.json) records mobile long-film timeline label overlap, so UI acceptance was false despite passing numeric checks.

Candidate 06, source `4044771455d7fe719a49bacf95e827b59f84fd6541357da35a06729c07effa63`, has a [source comparison](../.data/full-delivery/final-candidate-06/candidate-source-comparison.json) recording changes only in timeline display and its tests/configuration; engine, shared-domain, server, render entry and dependency files match candidate 05. Its [scoped verification](../.data/full-delivery/final-candidate-06/checks/verification.json) passes adaptive ruler development/production checks. Its [actual UI report](../.data/full-delivery/final-candidate-06/ui-spot-check.json) completes eight cases, 24 seeks, four real download hashes and four official frame-zero PNGs with zero differing RGBA pixels and identical bytes against candidate 05. The [visual review](../.data/full-delivery/final-candidate-06/ui-visual-review.json) accepts all four normal-duration film UIs, including the mobile fractional endpoint. An initial evidence-driver callback error is preserved separately; these eight completed cases have no application page errors.

The historical candidate 07, source `989f1c67a84c51db74e8ba0b0308f022215056c22b65c3fa2df3f9a64fb77dbe`, was served at 4217/4317. An independently reproduced legal sub-millisecond duration could hang candidate 06's tick loop; candidate 07 adds a minimum desired interval and a bounded regression. Its [source comparison](../.data/full-delivery/final-candidate-07/candidate-source-comparison.json) limits changes to the ruler helper and its mathematical test, with [20 normal states unchanged](../.data/timeline-ruler-fixed/submillisecond-regular-state-comparison.json). Its [scoped checks](../.data/full-delivery/final-candidate-07/checks/verification.json) pass 301 domain/service tests, format/type/build/structure and both development/production ruler workflows.

Candidate 07's [actual UI verification](../.data/full-delivery/final-candidate-07/ui-spot-check.json) passes eight desktop/mobile cases, 24 pointer seeks, four exact official PNG comparisons and four accepted MP4 download hashes. All eight saved project/photographed-canvas pairs are unchanged; its [20-screenshot visual review](../.data/full-delivery/final-candidate-07/ui-visual-review.json) accepts readable ruler labels/endpoints and all eight player views. Short playback totals 23.743211s and is not a new complete-film viewing or an isolated benchmark. These checks do not replace or relabel candidate 03's complete film playback/package restoration or candidate 05's 144-frame review. The [implemented-source Git receipt](../.data/full-delivery/final-candidate-07/git-implementation.json) verifies commit `67f7db80fd2cef815367af1f9bf754a29d7d51e4` against the frozen runtime's 298 files and remote master.

Accepted portable projects and MP4 copies remain under `.data/full-delivery/final-candidate-05/productions/`, with [20-file hash provenance](../.data/full-delivery/final-candidate-05/accepted-copy-provenance.json) matching candidate 03. Candidate 07 serves the copied database and media from `.data/delivery-candidate-07`; its own `productions/` directory contains new verification evidence rather than another set of package copies. Current play/download links and backup instructions are in [delivery-runtime.md](delivery-runtime.md).

### Recorded Export Timing

The [historical timing report](../.data/full-delivery/export-timing-evidence.json) reconstructs 376 original MCP status responses and matches both their SHA-256 and original serialized length. It uses the accepted job IDs and recorded call timestamps, never file modification times.

| Film         | Elapsed from job creation to completion | Precision                                                  |
| ------------ | --------------------------------------: | ---------------------------------------------------------- |
| Martial arts |                        At most 824.326s | Only a queued submission and late completed polls survived |
| Racing       |                        At most 399.008s | Only a queued submission and late completed polls survived |
| Space combat |                          94.343-96.355s | Bounded by adjacent unfinished/completed polls             |
| Tourism      |                        632.072-634.080s | Includes a separately bounded 264.948-266.954s queue wait  |

These are historical production observations under unknown concurrent load, not idle-machine throughput claims. Rendering streams frames into FFmpeg, so pure render and encode costs cannot be separated from these polls. Final application load, seek and playback measurements are a separate delivery gate.

This document accepts the identified media, scene content and portable editing evidence at their recorded versions. Overall completion still requires the applicable scope rows and delivery gates in the full acceptance matrix.
