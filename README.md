# terum-memory

Local-first memory and a decision record for individual developers who work
with coding agents. It captures your Claude Code sessions automatically,
distills them into searchable notes and first-class decisions, and lets your
agent check a proposed action against what you have already decided before it
acts. Everything lives in one SQLite file on your machine: no server, no
accounts, no data leaving the box.

It is built for one developer and their agents. If you keep re-explaining the
same choices to every fresh session, or an agent quietly reverses something you
settled last month, this is the tool. Capture in v0.1 is Claude Code only;
other sources are on the roadmap.

**Status:** pre-release until the v0.1 tag. Built by [Terum](https://terum.ai).
MIT licensed.

## Quick start

Requires Node 20 or newer. No Docker, no server, no account.

```sh
npm install -g terum-memory
terum-memory init
terum-memory connect claude-code
```

`init` creates the database at `~/.terum/terum.db`, locks it to an embedding
model, downloads that model (about 130 MB by default; see `--low-resource`
below), and probes for a chat backend to use for distillation.

`connect claude-code` installs a Claude Code Stop hook and registers a stdio MCP
server, then offers to backfill your existing `~/.claude/projects` transcripts.
Accept it: the backfill runs in the background and gives you a populated
decision record from the sessions you have already had, within minutes.

From then on, every time a Claude Code session ends, the hook captures it and a
detached worker distills it. `terum-memory status` shows what has been captured
and what is still queued; `terum-memory decisions` lists what has been recorded.

## What you get

**A decision record.** Decisions are distilled out of your sessions and stored
as first-class records with their reasoning, alongside ones you record by hand:

```sh
terum-memory decisions [--topic T]       # list standing decisions
terum-memory show <id>                   # one decision, with its reasoning and source
terum-memory decide "<text>" [--reason R --topic T]
terum-memory check "<statement>"         # does this contradict a standing decision?
terum-memory search "<query>"            # search notes and decisions
```

**`check_decision` receipts.** Before your agent acts, it can ask whether the
action it is about to take contradicts a standing decision. If it does, the
agent gets the prior decision back as a receipt: what was decided, why, and
when. The agent can then follow the decision, or surface the conflict to you
instead of silently overriding it. The same check is available to you from the
shell as `terum-memory check`.

Other commands: `backfill [--limit N | --all | --slow]`, `sync
[--retry-failed]`, `reembed --model <id>`, `status`, `uninstall`,
`uninstall --purge`. `mcp` and `hook stop` are the entrypoints that
`connect claude-code` wires up; you do not normally run them yourself.

## How it works

- The capture hook is fast and LLM-free. It records the session and exits, so
  it does not slow Claude Code down.
- A detached worker does the slow work later: it distills sessions into notes
  and decisions, embeds them, links related items, and clusters them.
- All state is one SQLite database, `~/.terum/terum.db`, in WAL mode.
- Embeddings are computed locally, in-process, with ONNX. The default model is
  `nomic-embed-text-v1` (about 130 MB download, 768 dimensions).
  `all-MiniLM-L6-v2` is the `--low-resource` option (about 25 MB, 384
  dimensions). An OpenAI-compatible API embedder is the opt-in quality ceiling.
  A database is locked to one embedding model at `init`; `reembed --model <id>`
  is the only way to switch.
- Distillation needs a chat model. `init` probes, in this order: an
  OpenAI-compatible endpoint via API key or base URL (this covers Ollama and
  other local servers), then installed agent CLIs (`claude`, `codex`,
  `gemini`), which ride your existing subscription. With no backend, capture
  still works and distillation queues until you configure one (capture-only
  mode).
- Backfill on a subscription-backed agent CLI is capped at the newest 50
  sessions by default and always reports what it left undistilled.
  `backfill --all` (API key or Ollama) and `backfill --slow` (an opt-in
  trickle) are the escape hatches.

## Using it from your agent

`connect claude-code` registers `terum-memory mcp` as a stdio MCP server. It
exposes four tools:

- `check_decision`: given a plain-language statement of what the agent is about
  to do, returns any standing decision it would contradict, as a receipt.
- `search_knowledge`: semantic search over distilled notes and decisions.
- `get_standing_decisions`: the current set of standing decisions, optionally
  by topic, for catching up at the start of a session.
- `ratify_decision`: records a new decision. This is human-gated: the tool
  records a decision only with your explicit in-session confirmation, never on
  the agent's own initiative.

## Privacy and data

Raw prompts and responses never leave the machine, and nothing phones home.
The only network calls are the embedding model download from Hugging Face at
`init` and whatever chat backend you configured yourself.

All data lives under `~/.terum/`:

- `terum.db`, plus its `terum.db-wal` and `terum.db-shm` sidecars (WAL mode)
- `models/`, the downloaded embedding models
- a small settings file

On POSIX the directory is created `0700` and the files `0600`.

`terum-memory uninstall` removes the Claude Code hook and the MCP registration
and keeps your data. `terum-memory uninstall --purge` also deletes the data
files it owns; it refuses to run while a background worker still holds a live
job, so nothing is deleted mid-write.

## Retrieval quality

On LongMemEval-S (all 500 questions, our own run) the retrieval pipeline reached 78% answer accuracy with 97.7% recall@10; methodology and per-lane numbers are available on request.

## Roadmap

- **v0.1**: Claude Code capture, local decision record, the four MCP tools.
- **v0.2**: a team tier that shares only explicitly published decisions,
  through a plain markdown ledger in a git repo the team already uses. No
  server, no accounts.
- **v0.3**: Gmail and Slack connectors.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are accepted under the
Developer Certificate of Origin (`git commit -s`); there is no CLA.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability privately.

## License

[MIT](LICENSE).
