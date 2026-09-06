export const DISTILL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    topic: { type: "string", description: "Short noun phrase, 2-5 words, naming the conversation." },
    summary: { type: "string", description: "One sentence, third person past tense, lowercase leading verb, describing what got done." },
    context: { type: "string", description: "Why this conversation happened. Empty string if unclear." },
    key_details: { type: "array", items: { type: "string" }, description: "Specific technical details with concrete names. Empty array if none." },
    decisions: { type: "array", items: { type: "string" }, description: "What the person COMMITTED to (chose/approved/acted on) and WHY, including rejected alternatives. Unratified conclusions go in derived_conclusions, not here. Empty array if none." },
    derived_conclusions: { type: "array", items: { type: "string" }, description: "Conclusions, recommendations, findings, or answers produced in the conversation that the person did NOT commit to (unratified suggestions, analyses, answers to questions). Real content, distinct from committed decisions. Empty array if none." },
    code_implementation: { type: "array", items: { type: "string" }, description: "Code patterns, commands, configs, file paths, function names, architecture decisions. Empty array if not applicable." },
    preferences_corrections: { type: "array", items: { type: "string" }, description: "Standing preferences, course-corrections made, style preferences, constraints. Empty array if none." },
    open_threads: { type: "array", items: { type: "string" }, description: "Unresolved questions and deferred next steps. Empty array if none." },
    tags: { type: "array", items: { type: "string" }, description: "Specific named entities only. Empty array if none." },
  },
  required: [
    "topic", "summary", "context", "key_details", "decisions", "derived_conclusions",
    "code_implementation", "preferences_corrections", "open_threads", "tags",
  ],
};

export interface DistilledNote {
  topic: string;
  summary: string;
  context: string;
  key_details: string[];
  decisions: string[];
  derived_conclusions: string[];
  code_implementation: string[];
  preferences_corrections: string[];
  open_threads: string[];
  tags: string[];
}

export const SUMMARY_STATE_GUARDRAIL = " Describe the state as of the final turn — if the work was still in progress or unresolved, say so; never imply it was finished, merged, or that no questions remain unless the conversation shows it. Do not state dates the conversation does not contain.";

export const SALIENCE_GUIDANCE = `
Record only what stays useful LATER. The test for every detail: would a future session or teammate
need it to understand the work, reuse it, or avoid redoing it? Be exhaustive about what passes that
test; leave out what doesn't. In particular, DROP pure session mechanics that carry no lasting
knowledge:
- branch/worktree/git hygiene — which branch was cut from what, squash-merge-strand avoidance,
  staging only intended files, clean/unpushed state, throwaway local commit hashes
- session bookkeeping — "read the handoff first", the working tree matching a snapshot, resume markers
- gate/test pass-fail counts and "typecheck/lint/build passed" status — that verifies THIS session, it
  is not durable knowledge (that a behavior is now covered by a test can stay; the raw counts cannot)
- one-off environment or tooling hiccups already resolved in-session — a build that failed then passed
  after a reinstall, a node_modules-junction quirk, a screenshot/theme-flip artifact, a local heap flag
Still KEEP the durable substance in full: root causes and how a bug was diagnosed; decisions and
trade-offs that constrain future work; reusable facts (schemas, thresholds, config values, file/
function/API names); recurring traps that will bite again; and real unfinished work.
`;

export const COVERAGE_GUIDANCE = `
COVERAGE REQUIREMENT — distill the WHOLE conversation, not just the end of it.
This transcript may be long and may move through several unrelated stretches of work. A note that
only reflects the final stretch is a failure however well written, because the reader who comes back
to this needs the parts they have already forgotten most.
- Before writing anything, work from the FIRST exchange to the last and identify every distinct
  phase the conversation contains. A phase ends when the task, the problem, or the subject changes.
  Long sessions routinely hold four to eight of them.
- The opening exchanges carry the task and the problem that motivated everything after it; the
  middle carries what was investigated, what went wrong, and what got reversed. These are exactly as
  durable as the ending. Recency is not importance, and the last thing discussed is not the most
  important thing that happened.
- Every phase you identified must leave a trace somewhere in the finished note. Check the note
  against your list of phases before returning it — a phase with no trace is a phase you dropped.
- Do not spend the whole note on the final phase because it is the freshest in view.
`;

export const NOTE_VOICE = `
Write every field as terse, casual notes in the person's own voice — plain language,
like quick notes jotted right after the work. Rules:
- Lead with a concrete action or decision verb that says what actually happened —
  "decided", "built", "created", "fixed", "diagnosed", "ruled out", "shipped", "landed",
  "found". NEVER open a field with weak framing that carries no information: not "needed
  to", "needed a", "wanted to", "wanted a", "had to", "was trying to", "set out to", or
  "the task was to". Match the verb to reality — if something was only decided or
  attempted, say "decided to X" / "attempted X", never imply it was finished when it wasn't.
- Preserve direction and final state exactly. A statement of preference keeps its
  orientation — "wants to branch out beyond X" is not "likes X"; "moving away from Y"
  is not "uses Y". When a value, choice, or fact was updated or corrected along the way,
  the note carries the FINAL state (and may say what it replaced) — never the superseded
  value as if it still held.
- NO subject and NO role label: never write "the user", "the assistant", "the AI",
  "Claude", "the developer", "I", "we", or a person's name — and not the adjectival forms
  either ("user-approved", "user-requested", "developer-driven"). When the reason was
  someone's request, state the driving fact subjectlessly ("the logo had to come from the
  website repo"), not "because the user asked". Examples: "decided there were too many
  bullets", "tuned how the briefing reads".
- Any work done with an AI's help is just the work — never mention an assistant or that
  an AI was involved.
- Each line stands on its own and reads in plain words — a teammate with no memory of the
  session should understand it cold. Spell the reasoning out in ordinary language; no
  compressed "X → Y" fragments and no coined shorthand that assumes you were there.
- Casual does NOT mean vague. Keep every specific: names, numbers, versions, error
  messages, file/function names, and the reasoning (why X over Y, what failed and why).
  Drop jargon ONLY where a plain word means exactly the same thing — never swap a precise
  term for a fuzzy one. Plain reasoning does NOT mean dropping the technical nouns — these
  notes are a retrieval substrate, so the specific names/identifiers must survive.
- Past tense, faithful to the final state (do not imply more completion than happened).
`;

export const DISTILL_PROMPT = `You are distilling a coding session into structured notes for future retrieval.
This is a conversation between a developer and an AI coding assistant.
The developer gives short instructions; the assistant explains its reasoning,
describes what it changed, and summarizes decisions. Tool usage (file reads, edits,
commands) is mostly not shown — only the text exchanged between developer and assistant,
plus possibly bracketed "[Session activity digest]" blocks: mechanical, auto-captured
records of files edited and commands that failed. Treat digest contents as ground truth
for WHICH files were touched and WHAT failed (they are not the developer's words); fold
their specifics into key_details/code_implementation where they matter.
Distill this into the person's OWN notes about what they did — never mention the
assistant, or that an AI was involved; that work is simply their own work.

Your output is returned as JSON matching a fixed schema, then embedded for semantic
search — so populate every field with specific technical details and terminology,
not vague summaries.

Be exhaustive about the durable substance, concise about the rest — completeness of what
MATTERS later, not a log of everything that happened (see the salience filter below). Preserve in full:
- The problem or task that motivated the session
- What was investigated and what was found (bug root causes, error messages, configs)
- What approach was chosen and what alternatives were rejected, with reasoning
- Specific files, functions, patterns, and architecture decisions
- Failed approaches and why they were abandoned
${SALIENCE_GUIDANCE}
${COVERAGE_GUIDANCE}
Field guidance:
- topic: a short noun phrase (2-5 words) naming the session. Example: "JWT TTL fix in auth middleware".
- summary: one sentence, third person past tense, starting with a lowercase verb, describing what got done. Example: "fixed JWT expiration by increasing TTL from 300s to 3600s in the auth middleware".${SUMMARY_STATE_GUARDRAIL}
- context: the MOTIVATING problem or goal that set off the session — WHY it happened, what made the work worth doing — NOT a recap of what got done (the summary and key_details already carry the what). State it as the problem or situation ITSELF, as a plain declarative fact ("auth tokens expired after 5 minutes"), NEVER as a need ("needed to fix auth") — that wrapper hides the actual problem instead of naming it. State the driving fact subjectlessly.
- key_details: the specific facts a future reader needs to resume this work — root causes and how they were diagnosed, error messages, values/thresholds/configs changed, libraries/APIs/services/tools involved, file paths and function names touched. Write each as one self-contained plain sentence, understandable on its own; do NOT compress into cryptic fragments or pack several facts into one line. Spend the words needed to be clear, then stop. Include a detail only if it carries forward; skip trivia and anything already in summary/context. No fixed count — as many as matter, as few as possible. Order most-important-first — put the fact a future reader most needs at the top, trailing to the minor ones.
- decisions: the approach the DEVELOPER committed to — chose, approved, or shipped/merged/applied — and WHY, including rejected alternatives and accepted tradeoffs. ONLY genuine commitments belong here; put the assistant's unratified conclusions/recommendations in derived_conclusions instead. KEEP-BIASED toward decisions: when it is unclear whether the developer committed, treat it as a decision and keep it here. Write each like a sharp session recap's "decisions made": ONE plain-English decision plus its one-line reason, self-contained (a reader with no memory of the session gets it), no shorthand — but keep the concrete specifics (file/function names, values, identifiers), since these notes are a retrieval substrate. List the most consequential decisions first.
- derived_conclusions: the assistant's conclusions, recommendations, diagnoses, or findings that the developer did NOT ratify — a recommended approach they never approved, a code-reading conclusion or root-cause finding they did not verify or act on. Capture each faithfully ("investigated…", "recommended…", "found that…") — real content, but NOT decisions. Empty array if none.
- code_implementation: files modified/created/deleted, patterns used or established, architecture choices (data flow, service boundaries, API design), commands run and their outcomes. Empty array if not applicable.
- preferences_corrections: course-corrections made along the way, standing technical preferences ("always use X pattern", "never import from Y"), and constraints mentioned. Empty array if none notable.
- open_threads: TODOs mentioned but not implemented, known issues deferred, follow-up work identified. Empty array if none.
- tags: specific named entities mentioned (files, components, libraries, frameworks, services, APIs, error types, architectural concepts). Specific names only — e.g. "auth.ts", "JWT", "Supabase", "pgvector" — not "authentication", "database", "security". Empty array if none.
${NOTE_VOICE}
`;
