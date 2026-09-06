# Engineering Rules

## Completion Criteria

- Deliver the Web 3D director previs editor, real MCP controls, and white-model MP4 export described in `docs/product-requirements.md`.
- The workflow ends at white-model video export. Do not integrate downstream AI video generation.
- Store business data in SQLite, including projects, history, render jobs, and asset metadata. Binary assets and videos may live on disk with database references.
- No source file may exceed 1000 lines. Run `npm run check:structure` as part of validation.
- Keep domain logic, Three.js rendering, React UI, persistence, transport, and video encoding in modules with explicit interfaces.
- UI and MCP must execute the same validated editing operations. Do not duplicate business logic in protocol handlers or UI components.
- Use TypeScript strict checking; keep imports explicit, return structured errors, and validate untrusted input at boundaries.
- Shared-state changes require meaningful domain tests. Cross-module workflows require integration checks.
- Before completion, pass structure checks, type checking, tests, production build, browser checks, and an actual MP4 export verified with ffprobe.
- Test desktop and mobile preview layouts, inspect screenshots, and verify nonblank moving 3D canvas pixels.

## Ownership

- `shared/`: project schema, timeline sampling, editing commands, demo fixture.
- `src/engine/`: Three.js objects, animation, cameras, editor controls.
- `src/components/`: reusable UI and focused workspace panels.
- `src/`: application state, editor composition, render-only entry point.
- `server/`: SQLite storage, HTTP/MCP transports, assets and export jobs.
- `tests/`: domain, persistence, protocol and browser verification.

Generated dependencies, lockfiles and build artifacts are excluded from the source-file line limit. Splitting files must follow responsibilities, not arbitrary line counts.
