# Build status — v0.1 port

Port started 2026-09-06. Implementation follows the v0.1 build spec (internal);
modules land in dependency order. This file tracks what is real vs pending —
update it in the same PR as the module it describes.

| # | Module | Covers | Status |
|---|--------|--------|--------|
| M1 | Data layer | schema (9 tables), open/migrate, meta, vec tables, fs-permission contract | **scaffolded** — this commit |
| M2 | Job queue | lease/fencing claim (epoch+attempts token), retry ladder, dead-letter, reembed exclusivity, distill single-flight | **done** |
| M3 | Distill engine | secret scrub, distill schema + prompt (pinned texts), parse/render, chunk-and-union, distill job handler + fenced persistence (note upsert, decision reconciliation, capture stamping) | **done** |
| M4 | Chat backends | OpenAI-compatible + Ollama adapter (schema-format fallback, fail-closed keys), agent-CLI spawn adapters (argv/stdin, caps, SIGTERM→SIGKILL), probe ladder + 0600 config | **done** |
| M5 | Embedder engine | sha256-verified atomic model install (marker-last), prefix-protocol choke point (import-boundary-tested), masked mean pooling + L2, batching | **done** — real-model execution verified at M13 pinning |
| M6 | Link + cluster | cosine linker, Louvain clustering, same-repo boost | pending |
| M7 | Decision rail | dedup ladder, ratify gate, check engine (distilled-decision persistence landed in M3) | pending |
| M8 | Search engine | anchors + one-hop link walk | pending |
| M9 | MCP server | stdio server, 4 tools, instructions | pending |
| M10 | Capture | Stop-hook fast half, sidecar offsets, connect/uninstall config edits | pending |
| M11 | Backfill | scan/import/distill jobs, caps, honesty guard | pending |
| M12 | CLI surface | full command set incl. reembed protocol, status, uninstall | pending |
| M13 | Calibration | corpus fixtures, calibrate-thresholds script, measured constants + drift gate | pending (blocks the v0.1 tag) |

Deliberate placeholders that THROW until measured (do not "fix"): the local-embedder
thresholds in `src/engine/thresholds.ts` and the artifact pins (revision/sha256) in
`src/engine/models.ts` — both are filled by the M13 calibration run before the v0.1 tag.

Launch gates (beyond M13): README benchmark table, secret-scan pass, npm publish, repo flip.
