# Portable Project Packages

The `.whiteframe` download contains the editable project, its undo/redo history, referenced local assets (including references from older history and render snapshots), and saved render jobs. Export options independently control history and completed MP4 inclusion. Export and import are available through the Web interface, HTTP routes, and MCP tools.

## Format and Consistency

New exports use gzip-compressed version 2 records. The decompressed stream begins with `WHITEFRAME/2\n`, followed by one JSON record per line: header, history snapshot, asset, render job, and a final record containing expected counts. Each binary retains its SHA-256 checksum. Import also accepts the original version 1 gzip JSON document.

The exporter opens an independent read-only SQLite transaction and iterates history and job snapshots individually. Edits on the live connection can continue under WAL while the package reads the original consistent snapshot. It never serializes the whole history as a single JavaScript string.

The importer validates records individually and stages project snapshots in a temporary SQLite database. After checking framing, checksums, media, asset references, identities, history positions, and cursor, it installs the project, assets, jobs, and active-project selection in one transaction. A failed stream or validation removes staged files and does not leave a partial project. Restored project and job IDs are new; local asset IDs are retained and existing matching assets are reused.

The final write transaction rechecks each existing asset's SHA-256 and MIME type after asynchronous staging. Concurrent copies of the same package share the first committed asset and remove their duplicate staged files. A concurrent import containing different bytes or MIME under the same ID fails with `ASSET_CONFLICT`; its project, history, jobs, new assets and active-project selection all roll back. File cleanup is restricted to paths created by that import.

## Limits

- Compressed package: 512 MiB, including multipart uploads.
- Expanded version 2 stream: 8 GiB.
- Individual version 2 JSON record: 256 MiB, including Base64 expansion and snapshot metadata.
- Records of each history, asset, or job type: at most 10,000.
- Legacy version 1 document: 512 MiB expanded, subject to the JavaScript string limit.
- The single-request `project_package_import` has a 32 MiB encoded JSON input limit. The public MCP `transfer_begin/chunk/status/commit/cancel` tools support the full 512 MiB compressed limit with resumable uploads, SHA-256 validation and atomic import receipts. Web multipart `/api/packages/import` remains available. See [transfer protocol](web-mcp-parity.md#chunked-transfers).

These limits are validated explicitly. A package exceeding a limit fails with a structured error instead of silently dropping history or video.

## Validation

`tests/package-codec.test.ts` round-trips more than 520 MiB of history and checks incomplete records, count mismatches, trailing records, and truncated gzip data. `tests/project-packages.test.ts` covers export while concurrent editing changes the source, restored redo history, independent takes, assets, actual MP4 bytes, restart persistence, legacy imports, and rollback after writing a staged asset.

`tests/package-concurrency.test.ts` uses two independent SQLite connections and concurrent imports to verify matching-asset reuse, same-ID/different-content rejection, exclusive-asset rollback, and absence of orphan files.

Production evidence lives in `.data/full-delivery/productions/<theme>/package-{export,restoration,restart}-report.json`. The final racing and space packages were restored into separate clean databases, edited through MCP, undone back to exact PNG hashes, and re-exported as single shots for comparison with the accepted film intervals. Space revision 106 includes all 107 history snapshots and both original videos.

Those historical large-package uploads used HTTP multipart. The new [candidate 09 MCP-only suite](../.data/full-delivery/final-candidate-09/mcp-package-checks-complete/suite-report.json) passes with all four actual packages, including the 256,528,195-byte space package. `scripts/production/verify-mcp-package-suite.ts` records 335 chunks and 492 public tool calls with zero errors, verifies all 257 original ordered history snapshots and referenced assets/videos, edits and undoes through MCP, and re-exports four representative shots totaling 42 seconds/1008 frames. An actual process restart preserves projects, history, assets, video hashes and idempotent import receipts.

Two interior-shot re-exports differ from the original full-film encoding by more than the verifier's initial 0.001 SSIM allowance. Independently rendered, source-verified candidate 07 baselines produce byte-identical videos and identical decoded frames for those shots. The verifier retains the original SSIM gate and accepts this separately verified exact-baseline case with a 0.98 full-film similarity floor. Both initial failures and the positive/negative calibration results remain preserved. This verifies restored shot rendering; it does not claim four new full-film exports. Candidate 10 has identical application and verification-script bytes to 09, as recorded in the [source comparison](../.data/full-delivery/final-candidate-10/candidate-source-comparison.json).
