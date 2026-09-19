# Security Policy

terum-memory reads Claude Code session transcripts on your machine, stores the
distilled result in a local SQLite database, edits your Claude Code settings to
install a hook and an MCP server, and downloads embedding models. A
vulnerability here can expose conversation content or compromise the integrity
of code that runs after every Claude Code turn. We take reports seriously.

## Supported versions

Only the latest 0.x release is supported. Fixes ship as new releases rather
than backports. Please reproduce against the latest release before reporting.

## Reporting a vulnerability

Please report vulnerabilities privately. Do **not** open a public issue.

Use GitHub private vulnerability reporting for this repository:
<https://github.com/ryanliu-terum/terum-memory/security/advisories/new>

If you cannot use GitHub, contact `[security contact]`.

Include what you can:

- affected version (`terum-memory --version`), OS, and Node version
- which embedder and chat backend are configured
- reproduction steps or a proof of concept
- impact as you understand it

Please redact anything private from transcripts, database contents, or
`terum-memory status` output before sending it.

## Scope

In scope:

- the data files under `~/.terum/` (the SQLite database and its WAL/SHM
  sidecars, downloaded models, the settings file), including their
  permissions and anything that would let another local user or process read
  or tamper with them
- the edits `connect claude-code` and `uninstall` make to Claude Code
  settings and MCP configuration, including the Stop hook registration
- verification of downloaded embedding models (integrity, pinning, and what
  happens when a download is tampered with or substituted)
- the MCP server (`terum-memory mcp`): input handling, what it exposes to a
  connected agent, and whether `ratify_decision` can record anything without
  explicit human confirmation
- any path by which raw prompts, responses, or distilled content could leave
  the machine other than the chat backend the user configured

Out of scope:

- vulnerabilities in the chat backend or embedding service you configured
  (report those to that provider)
- issues that require an attacker to already have the user's OS account
  privileges in a way that is not specific to this tool
- vulnerabilities in third-party dependencies with no demonstrated impact on
  this tool (still welcome as a regular issue or PR)

## What to expect

- Acknowledgment within a few days of your report.
- A triage decision and, if confirmed, an estimated fix timeline.
- Updates as we work on the fix, and coordination on disclosure timing before
  anything is published. We ask for a reasonable window to ship a fix before
  public disclosure.
- Credit in the release notes if you would like it.
