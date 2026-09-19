# Contributing to terum-memory

Thanks for your interest. This document covers the development setup, what a
good pull request looks like, and the sign-off we require.

## Development setup

Node 20 or newer.

```sh
npm ci
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest run
npm run build       # emits dist/
```

CI runs typecheck, tests, and build on Node 20 and 22 with **zero secrets
configured**. Tests must never need a network connection, an API key, or a real
model download. Anything that talks to an embedder or a chat backend is mocked
or skipped in tests; nothing in CI recomputes embeddings or contacts a backend.
If your change needs a real model or a live backend to verify, exercise it
locally and describe what you did in the PR.

## Pull requests

- Keep PRs small and focused. One behavior change per PR is ideal; refactors
  travel separately from behavior changes.
- Tests are colocated under `src/**/__tests__/*.test.ts`, next to the code
  they cover.
- Anything shaped like `(input) => decision` (parsers, predicates,
  deduplication, claim extraction, conflict detection) needs adversarial
  inputs the implementation never saw, not just the happy path. Malformed
  transcripts, near-duplicates, contradictory statements, empty and oversized
  inputs, and unexpected encodings are all fair game.
- Every write path is a transaction, and progress markers persist only after
  the work they mark has succeeded. If your change touches persistence, say
  in the PR how it behaves when the process dies halfway through.
- Errors are never swallowed. A skipped item is counted and surfaced, not
  silently dropped.
- All file and directory creation under `~/.terum` goes through the
  permission helpers in `src/db/permissions.ts`.
- Do not add dependencies that require Node newer than 20.
- This repository is public. Do not include private URLs, internal document
  paths, or personal names in code, comments, or docs.

Run `npm run typecheck`, `npm test`, and `npm run build` before opening the PR,
and report the real results.

## Measured constants

Two files deliberately throw at runtime when they meet an unmeasured value:

- `src/engine/thresholds.ts` throws on unmeasured constants.
- `src/engine/models.ts` throws on unpinned or unmeasured model artifacts.

This is intentional. Never "fix" one of these by inventing a number. Constants
are produced by the calibration script, or they do not exist.

In particular, **adding a supported embedder requires its measured constants
in the same PR**: the model entry and the thresholds calibrated for it land
together, or the PR is not complete.

## Developer Certificate of Origin

Contributions to this project are accepted under the
[Developer Certificate of Origin](https://developercertificate.org) (DCO).
There is **no CLA**. By signing off on a commit you certify that you wrote the
change or otherwise have the right to submit it under the project's MIT
license.

Sign off every commit with the `-s` flag:

```sh
git commit -s -m "Describe the change"
```

This appends a `Signed-off-by: Your Name <your@email>` line to the commit
message. Commits without a sign-off cannot be merged. If you forget, amend the
commit (`git commit --amend -s`) or, for a series, `git rebase --signoff`.

## Reporting bugs and proposing features

Use the issue forms in this repository. For anything security-sensitive, do
not open a public issue; follow [SECURITY.md](SECURITY.md) instead.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
