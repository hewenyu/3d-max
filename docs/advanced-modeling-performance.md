# Advanced Modeling Performance

Status: all three standard grades completed on 2026-09-08. An additional 90,000-vertex case completed measurement with an explicit Worker memory failure during geometry editing; its remaining browser, cancellation, save and PNG paths passed. Four real production work journals are also summarized below. Geometry installation still has measurable long tasks.

`scripts/modeling-assets/benchmark.ts` builds three meshes through public MCP commands: a 512-vertex, a 10,000-vertex and a 40,000-vertex revolved surface. Each source is baked through `mesh.convert`, inspected through a real worker and edited through `modeling_job_start`. The script checks exact undo and cancellation without partial publication, saves a portable project package and retains the editable project and MCP operation journal.

```sh
npx tsx scripts/modeling-assets/benchmark.ts --api http://127.0.0.1:4221
npx tsx scripts/modeling-assets/benchmark.ts --self-host --port 4225 --node-only
npx tsx scripts/modeling-assets/benchmark.ts --self-host --port 4225 --dist .data/advanced-modeling/performance-dist
npx tsx scripts/modeling-assets/benchmark.ts --self-host --port 4226 --dist .data/advanced-modeling/output-runtime-02/dist --grades near-limit --expect-edit-error MODELING_WORKER_FAILED --output .data/advanced-modeling/performance-near-limit
```

Use `--output`, `--grades small,medium,large,near-limit`, `--conditions`, `--web` or `--data` to record an explicit run. The default remains the three standard grades. `--edit-vertices` records an explicitly limited selection; omitted means every vertex. `--expect-edit-error` requires the supplied error code, verifies unchanged source/revision and continues the remaining measurements under `completed-with-limit`; it does not count the rejected edit or a nonexistent undo as successful. Each execution writes into a unique directory. A self-host run uses a private temporary SQLite directory unless `--data` is supplied; it closes the server and removes only its temporary directory afterward. `--port` defaults to 4225 and must be available; it is fixed before constructing the server's origin policy. The public MCP client controls every modeling and persistence operation in both modes.

## Measurements

| Measurement                    | Actual operation and scope                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mesh construction              | Public worker batch: object creation, parametric revolution and mesh conversion                                                                     |
| Source inspection              | Cancellable worker, source vertex count and stable namespace                                                                                        |
| Component selection            | Public stable-ID inversion over every source vertex                                                                                                 |
| Geometry edit                  | Actual vertex translation in a CPU worker, including final project validation and SQLite commit                                                     |
| Worker timing                  | Request acceptance, terminal result, status-request distribution and first observed progress phase; polled phases are not exact CPU stage durations |
| Queue and cancellation         | Real active and queued jobs, cancellation acknowledgement, concurrent project read and exact unchanged project                                      |
| Undo                           | Public history restore and exact geometry comparison                                                                                                |
| Save                           | Portable project package creation plus retained downloadable artifact                                                                               |
| Browser load                   | Real Chromium editor and matching registered workspace revision                                                                                     |
| Component source installation  | First object selection through acknowledged component mode, including observation setup, real source Worker loading/termination, rAF and long tasks |
| Browser selection              | Physical face click and public connected selection on the actual 3D canvas                                                                          |
| Browser responsiveness         | Actual requestAnimationFrame intervals and long tasks during worker editing, including incoming result publication                                  |
| Browser memory                 | Chromium Performance metrics, explicitly labelled JavaScript heap                                                                                   |
| Viewport output                | Desktop and mobile screenshots with pixel checks and mobile overflow assertion                                                                      |
| Headless output                | Public scene_view_capture, PNG decoding and nonblank pixel check                                                                                    |
| Node memory and responsiveness | Process heap/RSS samples and monitorEventLoopDelay, with measurement process identified                                                             |

## Interpretation

Remote mode measures the MCP runner's Node heap and event loop, not the remote server's internals. Self-host mode places the MCP client and server main thread in one Node process; that process's heap and event-loop measurements include both, and RSS includes worker threads. Worker-specific heap usage is not exposed and is not inferred from process RSS. The current worker heap and timeout limits are recorded separately.

Browser click latency includes state acknowledgement through the public workspace service. Job completion latency includes result transfer and JSON processing. Package creation includes history serialization, so retained history and mesh size affect it. First-use worker loading, browser initialization and headless renderer startup are included and identified by the reported operations.

The script records Node/V8 version, OS, CPU model, logical cores, total/free RAM, load average and external workload conditions. A single run is an observed result on that machine, not a universal latency guarantee. `--node-only` explicitly skips the browser and headless image paths; it does not count as full visual performance acceptance.

## Results

The completed production run is [2026-09-08T06-07-11-195Z-219e707f/report.json](../.data/advanced-modeling/performance/node-server/2026-09-08T06-07-11-195Z-219e707f/report.json). Its directory retains all three editable projects, portable packages, desktop/mobile/headless PNGs, job results and the full public MCP journal. The temporary benchmark server has been closed; the packages remain independently restorable. The subsequent failure-cache retry fix does not change the successful preparation path measured here; its focused tests and production browser verification are recorded below.

Conditions: Apple M4, 10 logical CPUs, 24 GiB RAM, macOS Darwin 25.3.0 arm64, Node 24.13.0 / V8 13.6.233.17, Chromium 153.0.8010.12. Starting load average was 2.96 / 3.59 / 3.98. Other project tests and asset rendering were paused for this run; external OS/browser workloads were not controlled. Worker heap remained bounded at 512 MiB. Timings below are milliseconds, rounded from the retained JSON.

| Vertices | Construct/bake | Worker edit | Undo | Save package | Face click acknowledgement | Connected selection | Computing cancel | Headless PNG |
| -------: | -------------: | ----------: | ---: | -----------: | -------------------------: | ------------------: | ---------------: | -----------: |
|      512 |            293 |         256 |    9 |            7 |                        162 |                 146 |                6 |          897 |
|   10,000 |          1,163 |       1,026 |   32 |           70 |                        181 |                 192 |               15 |          986 |
|   40,000 |          3,972 |       4,131 |  129 |          323 |                        241 |                 302 |               29 |        2,203 |

Every physical face click returned an actual stable face ID. Connected selection resolved 1,024 / 20,000 / 80,000 baked triangle faces. Pixel checks confirmed both single-face and connected-selection feedback, nonblank 1440x1000 desktop and 390x844 mobile screenshots, no mobile overflow, no uncaught browser errors, and decoded 960x640 headless images. Queued and computing cancellation preserved the exact project, and undo restored exact source geometry and identity metadata.

| Vertices | Browser frame p95 / max | Browser long-task max | Publication-to-ready | Node event-loop p95 / max |
| -------: | ----------------------: | --------------------: | -------------------: | ------------------------: |
|      512 |            16.8 / 299.9 |                   302 |                  411 |                7.0 / 14.3 |
|   10,000 |            16.8 / 366.7 |                   341 |                  621 |               8.3 / 207.6 |
|   40,000 |            16.7 / 683.4 |                   512 |                  645 |              10.4 / 962.6 |

Frame sampling continues until the browser acknowledges the edited revision and ready viewport. Computing cancellation waits for the actual worker computing stage; it does not substitute cancellation during module loading.

First component installation now uses the actual production `ComponentSourceWorker` for adjacency, stable-ID maps, picking tessellation and static wire/boundary/normal buffers. Each grade observed exactly one source worker during first installation, and that worker was terminated before the reported ready state. The controller and inspector share the current source cache; component commands await installation before MCP success.

| Vertices | First component installation | Source interval frame p95 / max | Source interval long-task max |
| -------: | ---------------------------: | ------------------------------: | ----------------------------: |
|      512 |                          530 |                    83.3 / 116.8 |                           121 |
|   10,000 |                          707 |                   133.3 / 133.4 |                           145 |
|   40,000 |                        1,027 |                   216.6 / 216.6 |                           231 |

This first-install interval starts before selecting the object and includes inspector layout, observation setup and MCP acknowledgement. It is not an isolated worker CPU duration. The 40,000-vertex run observed a periodically sampled Node heap peak of 847 MiB, final heap of 849 MiB and 2.00 GiB peak process RSS including worker threads. Chromium reported 323 MiB used JavaScript heap after its final selection and mobile viewport checks; this is a point-in-time measurement, not a worker heap value or a post-GC retained-memory claim. Structured cloning, result installation and large JSON/history processing can still produce long main-thread tasks. These maximum values are part of the result; the 16.7 ms edit-interval frame p95 does not imply uninterrupted 60 fps.

## Near-Limit Measurement

The [90,000-vertex report](../.data/advanced-modeling/performance-near-limit/node-server/2026-09-08T06-29-15-245Z-98cd6f09/report.json) measures a connected open cylinder with 45,000 genuine quadrilateral faces and 90,000 rendered triangles. Every vertex belongs to a face; no loose vertices are added to inflate the count. This intentionally uses narrow quads to reach 90% of the 100,000-vertex schema limit while remaining below the 150,000-triangle limit. It is a capacity workload, not a substitute for the four production shapes.

The browser used frozen `output-runtime-02/dist`. Hardware, Node and Chromium versions match the standard run. Starting load was 7.03 / 6.48 / 5.68 while final project exports/validation were active; this was not an isolated-load run. One complete boundary observation is reported, with earlier failed attempts retained separately.

| Operation                           | Observed Result                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Source construction / inspection    | 1,276 / 1,327 ms, successful                                                                                           |
| All-vertex selection query          | 284 ms, 90,000 stable IDs                                                                                              |
| First component installation        | 5,913 ms; real source Worker terminated before acknowledgement                                                         |
| Physical face / connected selection | 1,434 / 1,258 ms; connected set contained 45,000 source polygons                                                       |
| Whole-source geometry transform     | Failed after 2,996 ms with `MODELING_WORKER_FAILED`: unchanged 512 MiB Worker heap limit reached                       |
| Atomicity / undo                    | Source objects and revision remained exactly unchanged; undo is `null` because no geometry history entry was committed |
| Queued / computing cancellation     | 32 / 38 ms; exact project preserved                                                                                    |
| Portable package / headless PNG     | 346 / 12,987 ms; package retained and 960x640 PNG decoded                                                              |
| First-install frame p95 / maximum   | 1,933.2 / 2,716.5 ms; maximum long task 2,730 ms                                                                       |
| Node event-loop p95 / maximum       | 8.8 / 754.5 ms                                                                                                         |

This run is `completed-with-limit`, explicitly not a successful 90,000-vertex editing claim. A prior full-source attempt and a 16-vertex local-edit attempt on the same 90,000-vertex source also reached the fixed heap limit. The final attempt verifies the reported resource failure and checks that reading, selecting, cancellation, package creation and headless rendering continue afterward. The failed-edit interval showed no browser long tasks, but first source installation still stalled; those are distinct measured phases.

Peak combined Node main-thread heap was 540 MiB and process RSS including workers was 1.31 GiB. Chromium's final point-in-time JS heap was 126 MiB. The sampler now includes its final reading when computing the reported peak. Desktop/mobile screenshots were manually viewed; both canvases rendered the actual cylinder, selection feedback changed the canvas checksum, mobile width remained 390 pixels and no uncaught browser error occurred. Previous failures remain under `.data/advanced-modeling/performance-near-limit/node-server/`, including [the original whole-source rejection](../.data/advanced-modeling/performance-near-limit/node-server/2026-09-08T06-23-24-279Z-3a9556ad/report.json).

## Production Workloads

[works-performance.json](../.data/advanced-modeling/performance/works-performance.json) is a read-only extraction from the four final work journals, completed GLB/render metadata and source projects. The extraction script [summarize-performance.ts](../scripts/modeling-assets/summarize-performance.ts) records every input path and SHA-256. These are real source polygons, Boolean dependencies, modifiers and parameter surfaces, rather than only the capacity cylinder. All four final export journals contain zero failed MCP calls.

| Work         | Objects | Exported Triangles | Preview p50 / max (ms), 4 Calls | GLB (ms), 1 Call | Package (ms), 1 Call | Video Observed Completion (s), 1 Export |
| ------------ | ------: | -----------------: | ------------------------------: | ---------------: | -------------------: | --------------------------------------: |
| Vehicle      |      69 |             14,384 |                   3,297 / 3,579 |            1,662 |                  331 |                                    70.9 |
| Mechanical   |      27 |             12,020 |                   2,094 / 2,123 |              718 |                  179 |                                    73.9 |
| Architecture |      38 |              6,142 |                   1,584 / 1,586 |              445 |                  168 |                                    43.7 |
| Curved Prop  |      12 |             12,784 |                   2,002 / 2,014 |              854 |                  122 |                                    73.8 |

Each movie contains 576 frames at 24 fps and 720p. Video timing runs from the actual `render_start` request through the last successful `render_status` acknowledgement, including 1.5-second polling and overlapping machine work; it is not isolated rendering CPU time. Preview captures include renderer startup. GLB and package values are command response times, with artifact downloading outside those intervals. No missing inspection group is filled with inferred data: the vehicle has five recorded inspection calls (350-505 ms), architecture has six (194-336 ms), and the final mechanical/prop export journals have none.

The source inventory retains six live Boolean modifiers, welded mirror and Catmull-Clark in the vehicle; Boolean, solidify, twist, curve-array and loft/revolution in the mechanical work; Boolean openings, straight/curve arrays, sweep and loft in architecture; and all three surface operations plus an editable Boolean opening in the curved prop. Exact counts and original journals are linked in the JSON. These observations document the actual delivered workloads, without replacing their separate geometric, visual, history or restoration acceptance.

## Fixes And Regression

An earlier 40,000-vertex transform exhausted the unchanged 512 MiB worker heap. `meshEditResult` built two full adjacency graphs to read only ordered component IDs. It now obtains the same validated change maps from mesh identity and a linear edge-ID set. The actual 40,000-vertex bounded-worker test in [topology-memory.test.ts](../tests/topology-memory.test.ts) preserves every component ID, verifies every edited coordinate and restores exact undo/redo state. The 56 topology and command regressions passed after that change.

Component selection previously rebuilt source clones, multiple adjacency graphs and the complete picking tessellation on each selection. The controller now caches source topology, picking reuses that topology, and overlay highlights reuse the source triangle ranges and position buffer. Static wireframe geometry survives selection changes. A prior complete remote-server run observed 766 ms face acknowledgement and 833 ms connected selection at 40,000 vertices; the final run above observed 241 ms and 302 ms. The runs have different server-process placement and machine load, so these are recorded observations rather than a controlled speedup ratio.

[component-overlay.test.ts](../tests/component-overlay.test.ts) verifies geometry reuse, original triangle indices, cached selection semantics, real rays and visibility restoration. [component-source.test.ts](../tests/component-source.test.ts) checks transferred geometry/maps, current-version-only caching, worker termination, same-source retry after failure and stale failures not clearing a newer request. The production [component-workspace.spec.ts](../tests/component-workspace.spec.ts) passed both tests in 28.7 seconds against frozen output 02 with actual source/preview Workers, physical picks, Shift additive and Control subtractive selection with exact vertex IDs, box/lasso/xray, MCP selection, drag commit and undo, and cancellation by Escape, pointercancel and actual pointer-capture release. It switches physical object selection during cold source preparation and verifies that MCP reports failure, no worker remains active and no project revision changes. A deliberately failed real module download is then recovered using the inspector retry control, followed by a successful MCP component-mode acknowledgement. The 10-test [topology command suite](../tests/topology-commands.test.ts) also checks exact translation/rotation/scale snapping endpoints and unchanged unselected vertices. Run the browser suite with `WHITEFRAME_COMPONENT_DIST=.data/advanced-modeling/output-runtime-02/dist npx playwright test --config playwright.component-production.config.ts`.

[modeling-services.test.ts](../tests/modeling-services.test.ts) passed all four integration tests using the actual MCP SDK and HTTP server. The shared service fixture exercises all 11 modeling services, including worker-backed static conversion/export and HTTP 422 preservation for empty exports. Unexpected failed benchmark attempts retain `status: failed` and their own journals. The standard success tables use their completed run; the separate near-limit table explicitly retains its rejected edit under `completed-with-limit`.
