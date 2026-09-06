# Project Goal and Delivery Plan

Build a usable, modular Web 3D white-model director previs application with a shared UI/MCP editing model and deterministic MP4 export. The product stops at video export.

User-added completion requirements: SQLite persistence, standardized TypeScript code, clear module boundaries, and a maximum of 1000 lines per source file. These requirements are part of the active project goal.

## Delivery Status

- [x] Product requirements and director workflow reviewed.
- [x] Project boundaries and engineering rules recorded.
- [x] Shared model, validated commands, animation sampling and demo scene.
- [x] Three.js editor and reusable deterministic renderer.
- [x] Modular director workspace, timeline, scene and camera editing.
- [x] SQLite persistence, undo/redo, uploads and real MCP transports.
- [x] Render jobs, MP4 encoding, audio timing and download.
- [x] Automated checks and end-to-end director workflow verification.
- [x] Production build, local server and usage documentation.

## Technical Decisions

React and TypeScript provide the editor. Three.js supplies the scene, rigs, model loading and camera controls. A single renderer is used for interactive preview and fixed-time export. The Node server stores business records in SQLite and exposes validated editing commands through HTTP and MCP. Playwright runs the render-only page; FFmpeg encodes frames and optional temporary dialogue to MP4.

No cloud deployment or external AI video service is required for the local product.

## Verification Evidence

- 32 domain and server checks passed, including SQLite restart, atomic rollback, MCP HTTP/stdio, audio timing, camera motion and development render configuration.
- 17 browser end-to-end tests passed, including asynchronous project switching, queued edits, imports, undo, director notes, persistence and independent camera versions.
- Strict TypeScript, Prettier and production build passed. All 57 source files satisfy the 1000-line maximum.
- Production desktop 1440x1000 and 1280x800 plus mobile 390x844: nonblank moving 3D pixels, no text or page overflow, no browser errors.
- 24-shot thumbnail check: two WebGL contexts, no context loss.
- Isolated 10-second 720x1280 H.264 export: 24 fps, 240 frames, full-length AAC audio; immutable snapshots, cancellation and downloads verified.
- Full MCP director workflow passed: start from an empty project, construct the scene and performance, inspect actual PNG frames, revise cameras through both UI and MCP, and export a 10-second video.
- Production server started at `http://127.0.0.1:4173`; API health reports SQLite. The saved demo remains at revision 0.
- Production demo video downloaded and checked with ffprobe: H.264, 720x1280, 24 fps, 240 frames, exactly 10 seconds, no audio or editor overlays. Job: `121700d0-cb7b-417f-a03a-0a57eb661cce`.

## First-Version Boundaries

Each project contains one scene and one shared performance. Sequence copies isolate cameras and edits; separate performances can be saved in separate projects. Dialogue markers and action keyframes are adjusted independently. Safety guides are fixed and aspect ratio is project-wide. Advanced mesh editing, independent optical focus, depth of field, complex IK and facial animation remain future work, as recorded in the product requirements and README.
