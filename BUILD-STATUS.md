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
| M6 | Link + cluster | cosine top-K linker + repo-backbone edges, deterministic seeded Louvain, project naming + 0.5-overlap reconcile, fenced link-cluster job | **done** |
| M7 | Decision rail | dedup ladder (exact/cosine/judge, fail=no-merge), human-gated ratify (scrub, provenance upgrade, unique-hash race), check_decision + get_standing engines over decision_vec | **done** |
| M8 | Search engine | note+decision cosine anchors (fixed 0.40 recall floor), capped one-hop note link walk, deterministic rank/dedup, fail-closed | **done** |
| M9 | MCP server | stdio server (SDK 1.30.0 registerTool), 4 tools (check/search/standing/ratify), single-user trigger-phrase instructions, stdout-transport discipline | **done** |
| M10 | Capture | byte-offset transcript parser (complete-records-only, bad-line-count, interleaved sessions), crash-safe capture insert (sidecar after commit), ownership-exact config editor | **done** — worker spawn + hook CLI land in M12 |
| M11 | Backfill | newest-first scan+snapshot, parse-only import, import-before-distill barrier (rescheduleJob poll), caps + honesty guard | **done** — worker loop + CLI wiring in M12 |
| M12 | CLI surface | full command set (init/connect/backfill/sync/decisions/show/check/search/decide/status/uninstall/mcp/hook), worker loop + dispatch, detached spawn (pid+token lock), runtime-unavailable degradation | **done** (reembed → M12b) |
| M12b | reembed | resumable shadow-table build + fenced atomic swap (vectors+meta together), kill-point oracle, CLI + worker/dispatch wiring | **done** |
| M13 | Calibration | synthetic corpus fixture, `scripts/calibrate-thresholds.ts` (measure + reconcile), pinned artifacts, measured constants, secretless drift gate | **measured** (synthetic) — private real-corpus reconciliation is the remaining pre-tag gate |

`src/engine/thresholds.ts` and `src/engine/models.ts` still THROW on any unmeasured
placeholder; adding a supported embedder means measuring it in the same PR
(`node scripts/calibrate-thresholds.ts measure` after `npm run build`, with the reference
API key). Before the v0.1 tag, run `reconcile --corpus <private real corpus> --apply`
and copy any adopted readings into `thresholds.ts`; the drift test keeps the three in step.

Launch gates (beyond M13): real-corpus reconciliation, secret-scan pass, npm trusted
publisher + protected `npm` environment (one-time), v0.1 tag → publish, repo flip.
