# Build status — v0.1 port

Port started 2026-09-06. Implementation follows the v0.1 build spec (internal);
modules land in dependency order. This file tracks what is real vs pending —
update it in the same PR as the module it describes.

| # | Module | Covers | Status |
|---|--------|--------|--------|
| M1 | Data layer | schema (9 tables), open/migrate, meta, vec tables, fs-permission contract | **scaffolded** — this commit |
| M2 | Job queue | lease/fencing claim, retry ladder, dead-letter, crash-window rules | pending |
| M3 | Distill engine | secret scrub, distill schema + prompt, parse, note render | pending |
| M4 | Chat backends | OpenAI-compatible + Ollama probe, agent-CLI spawn adapters, subprocess bounds | pending |
| M5 | Embedder engine | ONNX runtime, model download + checksum, prefix-protocol choke point | pending |
| M6 | Link + cluster | cosine linker, Louvain clustering, same-repo boost | pending |
| M7 | Decision rail | persist, dedup ladder, ratify gate, check engine | pending |
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
