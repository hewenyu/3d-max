# Delivery Runtime

Recorded on 2026-09-07. Candidate 04 is the current local runtime; full product acceptance remains open.

| Entry                                     | Location                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| Editor, API and owner MCP                 | [http://127.0.0.1:4214](http://127.0.0.1:4214), MCP path `/mcp`              |
| Invited team review                       | [http://127.0.0.1:4314](http://127.0.0.1:4314), requires a review invitation |
| Frozen application                        | `.data/releases/full-candidate-04`                                           |
| Active SQLite, assets and renders         | `.data/delivery-candidate-04`                                                |
| Source manifest SHA-256, not a Git commit | `765b05b1b9f30815243e872d2e18119e5c944499b893e74d7688a06a05884897`           |

Paths are relative to `/Users/yueban/code/yuebanhome/3d-max` unless absolute. The [runtime process record](../.data/full-delivery/final-candidate-04/runtime-process.json) records the launch and addresses; its PID is historical after a restart.

## Start And Restart

Requires Node.js 24+, npm, FFmpeg/ffprobe on `PATH`, and installed Playwright Chromium. The frozen application's `node_modules` links to this repository's installed dependencies. Rhubarb uses the native Apple Silicon build below; retain its adjacent `res/` directory. Local dialogue synthesis uses installed macOS Say or eSpeak NG voices. See [Rhubarb setup](rhubarb-native-build.md) for rebuilding that dependency.

Run the preserved build with its existing data directory:

```sh
cd /Users/yueban/code/yuebanhome/3d-max/.data/releases/full-candidate-04
PORT=4214 \
APP_URL=http://127.0.0.1:4214 \
WHITEFRAME_DATA_DIR=/Users/yueban/code/yuebanhome/3d-max/.data/delivery-candidate-04 \
WHITEFRAME_DIST_DIR=/Users/yueban/code/yuebanhome/3d-max/.data/releases/full-candidate-04/dist \
WHITEFRAME_REVIEW_PORT=4314 \
WHITEFRAME_REVIEW_HOST=127.0.0.1 \
WHITEFRAME_REVIEW_URL=http://127.0.0.1:4314 \
WHITEFRAME_RHUBARB_PATH=/Users/yueban/code/yuebanhome/3d-max/.data/tools/rhubarb-native/build/rhubarb/rhubarb \
npm start
```

For a foreground instance, restart with `Ctrl+C`, wait for both listeners to close, then repeat the startup block. For an existing managed instance, first identify its current listener and working directory:

```sh
WHITEFRAME_RUNTIME_PID="$(lsof -tiTCP:4214 -sTCP:LISTEN)"
ps -p "$WHITEFRAME_RUNTIME_PID" -o pid=,command=
lsof -a -p "$WHITEFRAME_RUNTIME_PID" -d cwd
```

After confirming that process belongs to this runtime, use `kill -TERM "$WHITEFRAME_RUNTIME_PID"`, wait for ports 4214 and 4314 to close, and repeat the startup block. A restart preserves saved data; unfinished exports become failed jobs that can be retried.

## MCP Connection

Open the editor's MCP dialog and copy the configuration and token from this local runtime. The HTTP form is:

```json
{
  "mcpServers": {
    "whiteframe": {
      "url": "http://127.0.0.1:4214/mcp",
      "headers": { "Authorization": "Bearer YOUR_LOCAL_TOKEN" }
    }
  }
}
```

Replace the placeholder with the token shown in the local UI; no actual token is stored in this document. The same dialog supplies the stdio bridge configuration, which requires the API to remain running. Review invitations use the separate 4314 service and their own scoped credentials. Exact editing tool names and entry points are in [acceptance-entrypoints.md](acceptance-entrypoints.md).

## Four Films

Open a film project from the editor's project menu, then play its completed export from the export records. The direct links below use the actual completed jobs in the current data directory. All four are H.264/AAC, 1280x720, 24 fps; total duration is 504.5 seconds.

| Film               | Duration | Online Playback                                                                       | Download MP4                                                                            | Local Editable Package                                                                                         |
| ------------------ | -------: | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Martial arts, r34  |     134s | [Play](http://127.0.0.1:4214/api/renders/2143a917-acc5-4fd2-8e0a-bf338d7c416d/stream) | [Download](http://127.0.0.1:4214/api/renders/2143a917-acc5-4fd2-8e0a-bf338d7c416d/file) | [martial/martial.whiteframe](../.data/full-delivery/final-candidate-03/productions/martial/martial.whiteframe) |
| Racing, r41        |   122.5s | [Play](http://127.0.0.1:4214/api/renders/01b4ea92-0b82-4d37-9c13-c839be5583fb/stream) | [Download](http://127.0.0.1:4214/api/renders/01b4ea92-0b82-4d37-9c13-c839be5583fb/file) | [racing/racing.whiteframe](../.data/full-delivery/final-candidate-03/productions/racing/racing.whiteframe)     |
| Space combat, r106 |     120s | [Play](http://127.0.0.1:4214/api/renders/b4cd9819-778b-475c-84cc-277fc6c6831d/stream) | [Download](http://127.0.0.1:4214/api/renders/b4cd9819-778b-475c-84cc-277fc6c6831d/file) | [space/space.whiteframe](../.data/full-delivery/final-candidate-03/productions/space/space.whiteframe)         |
| Tourism, r72       |     128s | [Play](http://127.0.0.1:4214/api/renders/6b3b8927-e2ac-4286-936d-8190fab5d287/stream) | [Download](http://127.0.0.1:4214/api/renders/6b3b8927-e2ac-4286-936d-8190fab5d287/file) | [tourism/tourism.whiteframe](../.data/full-delivery/final-candidate-03/productions/tourism/tourism.whiteframe) |

Package paths share the prefix `.data/full-delivery/final-candidate-03/productions/`; each directory also retains `<theme>.mp4`, `export-project.json` and `ffprobe.json`. Current served files are `.data/delivery-candidate-04/renders/<job-id>.mp4`. Use the project window's package restore control to reopen an archive with its assets and history. The [runtime entry check](../.data/full-delivery/final-candidate-04/runtime-entry-check/verification.json) confirms HTTP health, all four project snapshots, job IDs and served video hashes.

## Data And Evidence

**SQLite, model/audio/video assets, project packages, frozen builds and local tool binaries live under `.data` on this machine and are not in Git.** A Git clone alone does not contain these films or the running projects. For a full backup, stop the service and preserve the entire `.data/delivery-candidate-04` directory, or use the portable packages for project transfer. Keep the frozen build and required runtime dependencies with a deployment. See [project-packages.md](project-packages.md) for package limits and restoration.

The [03-to-04 source comparison](../.data/full-delivery/final-candidate-04/candidate-source-comparison.json) identifies changes only in `tests/motion.spec.ts`, `tests/camera-view.spec.ts` and `playwright.production.config.ts`. Application sources, dependencies and built assets are identical. Candidate 03's four full playback reviews and 144 rendered frame comparisons remain at `.data/full-delivery/final-candidate-03/productions/<theme>/final-review/review.json` and `runtime-review/runtime-verification.json`; its [four-package restore/restart report](../.data/full-delivery/final-candidate-03/package-checks/verification.json) passes 8/8. These retain their original source hashes and are not relabeled as candidate 04 test runs.

Candidate 04's own [engineering regression](../.data/full-delivery/final-candidate-04/checks/verification.json) passes format, 291 domain/service checks, strict TypeScript/build, 285-source-file structure checks, real render smoke, 76 browser checks, 12 production-build browser checks and the MCP coverage gate. The [SDK audit](../.data/full-delivery/final-candidate-04/checks/mcp-coverage.json) records successful standalone invocations for all 151 distinct discovered tools. The working tree and frozen directory both match all 292 files in the source manifest.

The [performance report](../.data/full-delivery/final-candidate-04/performance/performance-report.json) measures the actual four projects on this Apple M4 / 24 GiB machine after the regression and full-film review browsers finished. All four have no active render jobs, browser errors or blank sampled canvases. Each uses a fresh browser context with HTTP cache disabled, 50 actual nonsequential timeline clicks and 20 seconds of 1x video playback after warmup.

| Film         | Cold Editor |    Seek p50 / p95 | Additional Decoded / Dropped Display Frames |
| ------------ | ----------: | ----------------: | ------------------------------------------: |
| Martial arts |      2.699s |   76.45 / 78.72ms |                                     479 / 3 |
| Racing       |      3.612s | 174.17 / 192.08ms |                                     480 / 1 |
| Space combat |      3.154s | 188.45 / 205.04ms |                                     480 / 1 |
| Tourism      |      3.127s | 123.77 / 127.81ms |                                     480 / 0 |

These are observed end-to-end times, including browser automation and UI work, with no invented performance threshold. Operating-system caches and unrelated workstation processes were not controlled. The report retains host load, JS heap and long tasks; it does not establish long-term GPU-memory stability. Historical full-film export time bounds are separately recorded in [four-films.md](four-films.md#recorded-export-timing).

Candidate 04 has a confirmed observation-navigation defect when focusing 160m objects: a fixed perspective distance limit and top-view zoom/height prevent the whole subject from fitting. This is tracked under H06 in the matrix; saved photography cameras and accepted film bytes remain unchanged. The existing benchmark did not exercise large-object focus.

Commit/push verification and overall acceptance are separate gates. H07/H08 remain unresolved in the [historical scope audit](historical-scope-audit.md); no exclusion or overall completion is implied. The authoritative status remains [full-delivery-matrix.md](full-delivery-matrix.md).
