# terum-memory — agent loader

Local-first memory + decision record for individual developers. TypeScript ESM
(NodeNext), Node 20 floor, one SQLite file (better-sqlite3 + sqlite-vec). Read
this file before your first edit; it is the contract for every coding agent.

## Gates (run these, report REAL counts)

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest run
```

CI (`.github/workflows/ci.yml`) runs both on Node 20 and 22 with ZERO secrets —
tests must never require a network, an API key, or a real model download.

## Invariants

1. **Crash-window rule.** Every write path is a transaction; progress markers
   (offsets, `distilled_at`, job status) persist only AFTER the work they mark
   succeeds. Every point a process can die must leave the db recoverable —
   re-drive-able, never half-done.
2. **Fenced queue writes.** Every worker-owned `jobs` update — retry/requeue,
   lease renewal, terminal moves — carries
   `WHERE id = ? AND attempts = <token> AND status = 'running'`. Zero rows
   affected means the lease was reclaimed: the stale worker rolls back and
   abandons the job, writing nothing.
3. **Throw-on-placeholder.** `src/engine/thresholds.ts` and
   `src/engine/models.ts` deliberately throw on unmeasured constants and
   unpinned artifacts. Never "fix" one by inventing a number; constants are
   measured by the calibration script, or they do not exist.
4. **Permission contract.** All file/dir creation under `~/.terum` goes through
   `src/db/permissions.ts` (0700 dir / 0600 files, repair-and-warn). Never
   create files there with default modes.
5. **Errors are never swallowed.** No `.catch(() => {})`; a skipped item is
   counted and surfaced, never silently dropped. Partial work reports partial.
6. **Node 20 floor.** `better-sqlite3` is pinned `^12` because v13 requires
   Node ≥22. Do not bump it, and do not add dependencies that require Node >20.
7. **Tests colocate** at `src/**/__tests__/*.test.ts`. Anything shaped like
   `(input) => decision` (parsers, predicates, dedup, claims) needs adversarial
   inputs the implementation never saw, not just the happy path.
8. **Keep the tree clean of internal references.** This repo flips public: no
   private URLs, no internal doc paths, no teammate names in code, comments,
   or docs.

## Ground rules for delegated runs

- Do not run git. Do not commit, push, stage, or tag. Leave changes in the
  working tree; the orchestrator reviews the raw diff.
- Do not edit `BUILD-STATUS.md`, `package.json` versions, or CI config unless
  the task says to.
- If the task is ambiguous, implement the most conservative reading and record
  the question — never resolve a design fork on your own.
