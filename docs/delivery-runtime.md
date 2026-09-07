# Delivery Runtime

Recorded on 2026-09-07. Candidate 07 is the current local runtime. Its scoped verification, eight actual four-film UI groups and manual screenshot review have passed. The implemented navigation/timeline corrections are committed, pushed and verified. H07/H08 scope decisions and E08 overall acceptance remain open.

| Entry                                     | Location                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| Editor, API and owner MCP                 | [http://127.0.0.1:4217](http://127.0.0.1:4217), MCP path `/mcp`              |
| Invited team review                       | [http://127.0.0.1:4317](http://127.0.0.1:4317), requires a review invitation |
| Frozen application                        | `.data/releases/full-candidate-07`                                           |
| Active SQLite, assets and renders         | `.data/delivery-candidate-07`                                                |
| Source manifest SHA-256, not a Git commit | `989f1c67a84c51db74e8ba0b0308f022215056c22b65c3fa2df3f9a64fb77dbe`           |

Paths are relative to `/Users/yueban/code/yuebanhome/3d-max` unless absolute. The [runtime process record](../.data/full-delivery/final-candidate-07/runtime-process.json) records PID 30615 at launch and the addresses; its PID is historical after a restart.

Candidate 04, 05 and 06 listeners have been stopped. Their frozen sources, data and evidence remain preserved; ports recorded inside historical reports describe those earlier runs, not currently available services.

## Start And Restart

Requires Node.js 24+, npm, FFmpeg/ffprobe on `PATH`, and installed Playwright Chromium. The frozen application's `node_modules` links to this repository's installed dependencies. Rhubarb uses the native Apple Silicon build below; retain its adjacent `res/` directory. Local dialogue synthesis uses installed macOS Say or eSpeak NG voices. See [Rhubarb setup](rhubarb-native-build.md) for rebuilding that dependency.

Run the preserved build with its existing data directory:

```sh
cd /Users/yueban/code/yuebanhome/3d-max/.data/releases/full-candidate-07
PORT=4217 \
APP_URL=http://127.0.0.1:4217 \
WHITEFRAME_DATA_DIR=/Users/yueban/code/yuebanhome/3d-max/.data/delivery-candidate-07 \
WHITEFRAME_DIST_DIR=/Users/yueban/code/yuebanhome/3d-max/.data/releases/full-candidate-07/dist \
WHITEFRAME_REVIEW_PORT=4317 \
WHITEFRAME_REVIEW_HOST=127.0.0.1 \
WHITEFRAME_REVIEW_URL=http://127.0.0.1:4317 \
WHITEFRAME_RHUBARB_PATH=/Users/yueban/code/yuebanhome/3d-max/.data/tools/rhubarb-native/build/rhubarb/rhubarb \
npm start
```

For a foreground instance, restart with `Ctrl+C`, wait for both listeners to close, then repeat the startup block. For an existing managed instance, first identify its current listener and working directory:

```sh
WHITEFRAME_RUNTIME_PID="$(lsof -tiTCP:4217 -sTCP:LISTEN)"
ps -p "$WHITEFRAME_RUNTIME_PID" -o pid=,command=
lsof -a -p "$WHITEFRAME_RUNTIME_PID" -d cwd
```

After confirming that process belongs to this runtime, use `kill -TERM "$WHITEFRAME_RUNTIME_PID"`, wait for ports 4217 and 4317 to close, and repeat the startup block. A restart preserves saved data; unfinished exports become failed jobs that can be retried.

## MCP Connection

Open the editor's MCP dialog and copy the configuration and token from this local runtime. The HTTP form is:

```json
{
  "mcpServers": {
    "whiteframe": {
      "url": "http://127.0.0.1:4217/mcp",
      "headers": { "Authorization": "Bearer YOUR_LOCAL_TOKEN" }
    }
  }
}
```

Replace the placeholder with the token shown in the local UI; no actual token is stored in this document. The same dialog supplies the stdio bridge configuration, which requires the API to remain running. Review invitations use the separate 4317 service and their own scoped credentials. Exact editing tool names and entry points are in [acceptance-entrypoints.md](acceptance-entrypoints.md).

## Four Films

Open a film project from the editor's project menu, then play its completed export from the export records. The direct links below use the actual completed jobs in the current data directory. All four are H.264/AAC, 1280x720, 24 fps; total duration is 504.5 seconds.

| Film               | Duration | Online Playback                                                                       | Download MP4                                                                            | Local Editable Package                                                                                         |
| ------------------ | -------: | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Martial arts, r34  |     134s | [Play](http://127.0.0.1:4217/api/renders/2143a917-acc5-4fd2-8e0a-bf338d7c416d/stream) | [Download](http://127.0.0.1:4217/api/renders/2143a917-acc5-4fd2-8e0a-bf338d7c416d/file) | [martial/martial.whiteframe](../.data/full-delivery/final-candidate-05/productions/martial/martial.whiteframe) |
| Racing, r41        |   122.5s | [Play](http://127.0.0.1:4217/api/renders/01b4ea92-0b82-4d37-9c13-c839be5583fb/stream) | [Download](http://127.0.0.1:4217/api/renders/01b4ea92-0b82-4d37-9c13-c839be5583fb/file) | [racing/racing.whiteframe](../.data/full-delivery/final-candidate-05/productions/racing/racing.whiteframe)     |
| Space combat, r106 |     120s | [Play](http://127.0.0.1:4217/api/renders/b4cd9819-778b-475c-84cc-277fc6c6831d/stream) | [Download](http://127.0.0.1:4217/api/renders/b4cd9819-778b-475c-84cc-277fc6c6831d/file) | [space/space.whiteframe](../.data/full-delivery/final-candidate-05/productions/space/space.whiteframe)         |
| Tourism, r72       |     128s | [Play](http://127.0.0.1:4217/api/renders/6b3b8927-e2ac-4286-936d-8190fab5d287/stream) | [Download](http://127.0.0.1:4217/api/renders/6b3b8927-e2ac-4286-936d-8190fab5d287/file) | [tourism/tourism.whiteframe](../.data/full-delivery/final-candidate-05/productions/tourism/tourism.whiteframe) |

Package paths share the prefix `.data/full-delivery/final-candidate-05/productions/`; each directory also retains `<theme>.mp4`, `export-project.json`, `export-job.json` and `ffprobe.json`. Candidate 06/07 evidence directories contain new UI/MCP evidence, not another copy of those 20 accepted files. Current served files are `.data/delivery-candidate-07/renders/<job-id>.mp4`. Use the project window's package restore control to reopen an archive with its assets and history. The [copy provenance](../.data/full-delivery/final-candidate-05/accepted-copy-provenance.json) verifies that all 20 files match the accepted candidate 03 originals; it makes no later-candidate render or playback claim.

Candidate 07's [actual four-film UI check](../.data/full-delivery/final-candidate-07/ui-spot-check.json) is complete: all eight desktop/mobile groups and 24 actual timeline seeks pass with unchanged saved projects and photographed canvases, no browser errors and no failed groups. Four actual desktop downloads match accepted MP4 hashes, and four official time-zero previews match candidate 05's corresponding PNGs byte-for-byte with zero changed RGBA pixels. The [manual review](../.data/full-delivery/final-candidate-07/ui-visual-review.json) inspects 20 screenshots, including all eight actual players, and accepts the reviewed film workflows with no new visible defect. This is short playback evidence, not a full-film replay or isolated performance benchmark. Candidate 06's completed checks below retain their original source hash and are not relabeled as this new run.

Candidate 06's [actual four-film UI check](../.data/full-delivery/final-candidate-06/ui-spot-check.json) passes all eight desktop/mobile groups and 24 actual timeline seeks. It verifies separated labels, readable terminal labels after real horizontal scrolling, observation controls, short actual playback and unchanged saved projects/photographed canvases. All four actual desktop downloads match accepted MP4 hashes, and four official time-zero previews match candidate 05's corresponding 1280x720 PNGs byte-for-byte and with zero changed RGBA pixels. The [visual review](../.data/full-delivery/final-candidate-06/ui-visual-review.json) accepts these four normal-duration film workflows. This is not a new full-film playback review, 144-frame comparison run or isolated performance benchmark.

Candidate 05's own frame comparisons are complete: [martial](../.data/full-delivery/final-candidate-05/productions/martial/runtime-review/runtime-verification.json), [racing](../.data/full-delivery/final-candidate-05/productions/racing/runtime-review/runtime-verification.json), [space](../.data/full-delivery/final-candidate-05/productions/space/runtime-review/runtime-verification.json) and [tourism](../.data/full-delivery/final-candidate-05/productions/tourism/runtime-review/runtime-verification.json) compare 48, 30, 30 and 36 new MCP previews against decoded accepted MP4 frames. All four saved projects equal the accepted snapshots and served video bytes match. These 144 sampled comparisons are distinct from the earlier full-film playback reviews. The [candidate 05 UI spot check](../.data/full-delivery/final-candidate-05/ui-spot-check.json) passes all eight desktop/mobile cases with short actual playback, observation-view changes and unchanged saved projects/photography pixels; all four desktop downloads match the accepted MP4 hashes. The separate [visual review](../.data/full-delivery/final-candidate-05/ui-visual-review.json) records the unresolved mobile timeline-label overlap.

## Data And Evidence

**SQLite, model/audio/video assets, project packages, frozen builds and local tool binaries live under `.data` on this machine and are not in Git.** A Git clone alone does not contain these films or the running projects. For a full backup, stop the service and preserve the entire `.data/delivery-candidate-07` directory, or use the portable packages for project transfer. Keep the frozen build and required runtime dependencies with a deployment. See [project-packages.md](project-packages.md) for package limits and restoration.

Candidate 07's [scoped verification](../.data/full-delivery/final-candidate-07/checks/verification.json) is complete: format, 301 domain/service tests, strict TypeScript/build, 291 source files at no more than 1000 lines each, one development ruler browser check and one production ruler browser check passed, with no skipped or flaky browser tests. Its [06-to-07 source comparison](../.data/full-delivery/final-candidate-07/candidate-source-comparison.json) identifies exactly two changed files, `TimelineRuler.tsx` and its mathematical test. The correction supplies a finite minimum step for extremely short durations, including `Number.MIN_VALUE`; the [20-case comparison](../.data/timeline-ruler-fixed/submillisecond-regular-state-comparison.json) records identical normal-duration tick results using the same recorded/fallback measurements. Engine, shared domain, server, dependencies and render entry remain unchanged. This scoped run does not claim to repeat candidate 05's broader browser/MCP suite.

The [implementation Git receipt](../.data/full-delivery/final-candidate-07/git-implementation.json) verifies pushed commit `67f7db80fd2cef815367af1f9bf754a29d7d51e4` against remote `master` and all 298 files in candidate 07's frozen manifest. The implemented navigation and timeline corrections have completed source delivery. This receipt covers that code commit; later documentation commits and overall product acceptance are separate.

Candidate 06's [scoped verification](../.data/full-delivery/final-candidate-06/checks/verification.json) is complete: format, 300 domain/service tests, strict TypeScript/build, 291 source files at no more than 1000 lines each, three development browser checks and one production timeline-ruler check passed. The development checks cover the ruler, timeline context and motion events. The [production ruler report](../.data/full-delivery/final-candidate-06/checks/timeline-production-results/timeline-ruler-adaptive-ti-61d88-hout-changing-seek-or-clips/timeline-ruler.json) records 20 viewport/duration cases and 56 real click/drag seeks for 2s, 3.25s, 120s and 134s sequences through desktop/mobile resizing and horizontal scrolling, with no browser errors or project changes.

The [05-to-06 source comparison](../.data/full-delivery/final-candidate-06/candidate-source-comparison.json) identifies six changed files: three timeline UI/style files and three test/configuration files. All 30 server files, 57 shared-domain files, 11 engine files, dependency manifests and the render entry are unchanged. The [protected-source comparison](../.data/full-delivery/final-candidate-06/source-comparison.json) also checks actual bytes for 100 engine/shared/server/dependency files against both frozen manifests. Candidate 05's broader regression retains its original provenance; it was not rerun in full under candidate 06.

The [04-to-05 source comparison](../.data/full-delivery/final-candidate-05/candidate-source-comparison.json) identifies six changed files: three application files for observation navigation and three test/configuration files. All 30 server files, 57 shared-domain files and dependency manifests are unchanged. Candidate 03's four full playback reviews remain at `.data/full-delivery/final-candidate-03/productions/<theme>/final-review/review.json`; its [four-package restore/restart report](../.data/full-delivery/final-candidate-03/package-checks/verification.json) passes 8/8. These retain their original source hashes and are not relabeled as later-candidate test runs.

Candidate 05's [initial engineering run](../.data/full-delivery/final-candidate-05/checks/verification.json) passes format, 297 domain/service checks, strict TypeScript/build, the 288-source-file structure check and real render smoke. The browser suite ended with 75 passed and 3 failed because its launch omitted `WHITEFRAME_RHUBARB_PATH`: `face-animation.spec.ts`, `mcp-service-catalog.spec.ts` and `speech.spec.ts` require the native analyzer. The original failure report and traces are preserved. The separate [completion run](../.data/full-delivery/final-candidate-05/checks-completion/verification.json) is complete: all three corrected tests passed with the required path and unchanged source, completing coverage of 78 unique browser checks; all 14 production-build browser checks passed. The [aggregate MCP audit](../.data/full-delivery/final-candidate-05/checks-completion/mcp-coverage.json) records successful standalone calls for all 151 distinct discovered tools with none missing. This is not a claim that the initial run passed 78/78.

Candidate 05 corrects the earlier 160m-object focus defect with bounds-based perspective/top framing, independent observation controls and redraws after pan/zoom. The development [desktop](../.data/observation-focus-fixed/dev-results-03/observation-focus-desktop--13ff5-serves-photographed-cameras/observation-focus.json) and [mobile](../.data/observation-focus-fixed/dev-results-03/observation-focus-mobile-o-b4c7e-serves-photographed-cameras/observation-focus.json) reports record 62 actual UI framings and all 496 projected corners inside the view. Coverage includes pending damping, same-page project/resource changes and navigation after resize; saved photography cameras and photographed pixels remain unchanged. The frozen-build [desktop](../.data/full-delivery/final-candidate-05/checks-completion/production-tests-results/observation-focus-desktop--13ff5-serves-photographed-cameras/observation-focus.json) and [mobile](../.data/full-delivery/final-candidate-05/checks-completion/production-tests-results/observation-focus-mobile-o-b4c7e-serves-photographed-cameras/observation-focus.json) reruns also pass the UI/pixel and persistence checks; their internal projection fields are intentionally null. The 496-corner count belongs to the development reports.

For a new complete engineering run, use a new, nonexistent evidence directory and pass the native analyzer to the test runner as well as the application:

```sh
cd /Users/yueban/code/yuebanhome/3d-max/.data/releases/full-candidate-07
WHITEFRAME_RHUBARB_PATH=/Users/yueban/code/yuebanhome/3d-max/.data/tools/rhubarb-native/build/rhubarb/rhubarb \
node scripts/verify-release.mjs /Users/yueban/code/yuebanhome/3d-max/.data/full-delivery/final-candidate-07/checks-recheck
```

This command runs format, domain/service tests, strict TypeScript/build/structure, real render smoke, browser and production suites, and the successful standalone MCP-call coverage gate. It does not replace film review or overall requirement acceptance.

Candidate 04's historical [engineering regression](../.data/full-delivery/final-candidate-04/checks/verification.json) passes 291 domain/service checks, 76 browser checks, 12 production-build browser checks and its other recorded gates. Its [SDK audit](../.data/full-delivery/final-candidate-04/checks/mcp-coverage.json) records successful standalone invocations for all 151 distinct discovered tools. The historical [Git delivery report](../.data/full-delivery/final-candidate-04/git-delivery.json) verifies commit `703ce9b4663be6eb5a95ffbce19aee1ea92869aa` against the remote at that time and all 292 files in candidate 04's manifest; candidate 07's newer implementation receipt is recorded above.

The historical candidate 04 [performance report](../.data/full-delivery/final-candidate-04/performance/performance-report.json) measures the actual four projects on this Apple M4 / 24 GiB machine after the regression and full-film review browsers finished. All four have no active render jobs, browser errors or blank sampled canvases. Each uses a fresh browser context with HTTP cache disabled, 50 actual nonsequential timeline clicks and 20 seconds of 1x video playback after warmup. This benchmark has not been rerun under candidate 05 or 06.

| Film         | Cold Editor |    Seek p50 / p95 | Additional Decoded / Dropped Display Frames |
| ------------ | ----------: | ----------------: | ------------------------------------------: |
| Martial arts |      2.699s |   76.45 / 78.72ms |                                     479 / 3 |
| Racing       |      3.612s | 174.17 / 192.08ms |                                     480 / 1 |
| Space combat |      3.154s | 188.45 / 205.04ms |                                     480 / 1 |
| Tourism      |      3.127s | 123.77 / 127.81ms |                                     480 / 0 |

These are observed end-to-end times, including browser automation and UI work, with no invented performance threshold. Operating-system caches and unrelated workstation processes were not controlled. The report retains host load, JS heap and long tasks; it does not establish long-term GPU-memory stability. Historical full-film export time bounds are separately recorded in [four-films.md](four-films.md#recorded-export-timing).

Candidate 05's visual review found overlapping per-second timeline labels in the actual long films. Candidate 06's adaptive spacing and in-bounds terminal label resolve that defect in all four reviewed films. Its visual report leaves final release acceptance false because of the separately discovered `Number.MIN_VALUE` step underflow. Candidate 07 corrects that boundary and passes its scoped checks, actual four-film checks and manual screenshot review. The historical reports retain their original decisions. The earlier performance benchmark did not exercise that boundary or large-object focus and has not been rerun under candidate 07.

The implemented corrections have completed verified source delivery. H07/H08 remain unresolved in the [historical scope audit](historical-scope-audit.md), and E08 overall acceptance remains open; no exclusion or overall completion is implied by the code commit. The authoritative status remains [full-delivery-matrix.md](full-delivery-matrix.md).
