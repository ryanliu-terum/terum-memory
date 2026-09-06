-- 001_init.sql (squashed; the only migration at v0.1)
-- One database = one embedding model, locked at `init`. Vector dimension is fixed at init
-- time from the locked embedder, so the vec virtual tables (note_vec, decision_vec) are
-- created by `init` — see createVecTables() — not by this file.
-- All ids are UUIDv4 TEXT; all timestamps ISO-8601 UTC TEXT.

CREATE TABLE meta (            -- db-level facts; one row per key
  key   TEXT PRIMARY KEY,      -- schema_version · embedder_id · embedder_dim ·
  value TEXT NOT NULL          -- embedder_locked_at · created_at · chat_backend
);

CREATE TABLE captures (        -- raw turns
  id                 TEXT PRIMARY KEY,
  site               TEXT NOT NULL DEFAULT 'claude-code',
  conversation_id    TEXT NOT NULL,
  conversation_title TEXT,
  prompt             TEXT NOT NULL,
  response           TEXT NOT NULL,
  model              TEXT,
  metadata           TEXT NOT NULL DEFAULT '{}',   -- JSON; carries repo_name (normalized git-root
                                                   -- basename from the session cwd) for the
                                                   -- same-repo clustering boost
  source_key         TEXT NOT NULL,          -- stable per-record identity: the transcript record's
                                             -- own uuid; fallback = record start byte offset.
                                             -- Timestamps are data, never identity.
  captured_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  distilled_at       TEXT,                   -- NULL = pending
  UNIQUE (site, conversation_id, source_key)
);
CREATE INDEX idx_captures_pending ON captures(site, conversation_id) WHERE distilled_at IS NULL;

CREATE TABLE projects (        -- Louvain clusters, LLM-named
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE notes (           -- distilled conversations
  id                 TEXT PRIMARY KEY,
  site               TEXT NOT NULL,
  conversation_id    TEXT NOT NULL,
  conversation_title TEXT,
  turn_count         INTEGER NOT NULL,
  topic              TEXT,
  summary            TEXT,
  compacted_text     TEXT NOT NULL,
  entity_tags        TEXT NOT NULL DEFAULT '[]',   -- JSON array
  repo_name          TEXT,          -- majority repo_name of the source captures (normalized
                                    -- git-root basename, lowercase); keys the same-repo boost
  project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
  model_used         TEXT NOT NULL,
  first_captured_at  TEXT NOT NULL,
  last_captured_at   TEXT NOT NULL,
  distilled_at       TEXT NOT NULL,
  UNIQUE (site, conversation_id)             -- re-distill = upsert, stable id (MERGE)
);

CREATE TABLE links (           -- similarity edges
  a           TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  b           TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  similarity  REAL NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);

CREATE TABLE decisions (       -- single-user decision record
  id             TEXT PRIMARY KEY,   -- for ledger-imported rows: the ledger file's own uuid
  note_id        TEXT REFERENCES notes(id) ON DELETE CASCADE,  -- NULL: ratified or ledger rows
  decision_text  TEXT NOT NULL,
  reason         TEXT,
  topic          TEXT,
  content_hash   TEXT NOT NULL,      -- sha256(normalized text); stable across re-distill
  source_summary TEXT,               -- parent note summary, denormalized for check_decision
  provenance     TEXT NOT NULL CHECK (provenance IN ('distilled','ratified')),
  human_quote    TEXT,               -- REQUIRED (enforced in code) when provenance='ratified'
  author         TEXT,               -- NULL = self; ledger imports: frontmatter author
  origin         TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local','ledger')),
  ledger_path    TEXT,               -- set on published (local) and imported (ledger) rows
  published_at   TEXT,               -- NULL = unpublished; drives `decisions --unpublished`
  decided_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (note_id, content_hash)
);
-- SQLite treats NULLs as distinct in UNIQUE, so ratified rows (note_id NULL) escape the
-- constraint above; this backs the dedup ladder for local ratifications:
CREATE UNIQUE INDEX idx_decisions_ratified_hash
  ON decisions(content_hash) WHERE note_id IS NULL AND origin = 'local';

CREATE TABLE decision_edges (  -- FORWARD-LOOKING at v0.1: no producer writes this table yet
  id          TEXT PRIMARY KEY,
  decision_a  TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  decision_b  TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  edge_type   TEXT NOT NULL CHECK (edge_type IN ('contradicts','supersedes','compatible')),
  confidence  REAL,
  rationale   TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','resolved')),
  created_at  TEXT NOT NULL,
  UNIQUE (decision_a, decision_b),
  CHECK (decision_a < decision_b)
);

CREATE TABLE receipts (        -- check_decision surfacings
  id           TEXT PRIMARY KEY,
  statement    TEXT NOT NULL,
  surfaced_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of decision ids returned
  edge_id      TEXT REFERENCES decision_edges(id) ON DELETE SET NULL,
  surfaced_at  TEXT NOT NULL,
  expires_at   TEXT,
  confirmed_at TEXT,
  human_confirmation_quote TEXT
);

CREATE TABLE jobs (            -- in-process queue + crash recovery
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,    -- distill · link-cluster · backfill (run) · backfill-page · reembed
  payload    TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','running','done','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  run_after  TEXT,
  lease_until TEXT,            -- claimed-by-worker lease; expired lease = reclaimable
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_runnable ON jobs(status, run_after);
