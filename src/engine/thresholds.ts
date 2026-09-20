/**
 * Similarity thresholds are per-embedder measured constants, never assumptions.
 *
 * The reference space is `text-embedding-3-small`, where the anchors were
 * benchmarked: 0.70 link/merge, [0.60, 0.70) judge band, 0.55 candidate floor.
 * Local embedders get their own constants by percentile-matching the reference
 * corpus's edge density (scripts/calibrate-thresholds.ts); reference-space
 * values are never applied verbatim in another embedder's space.
 *
 * Placeholders THROW: an embedder without measured constants cannot silently
 * ship. Adding a supported embedder requires its measured constants (and the
 * calibration results file backing them) in the same PR.
 */

export interface DecisionRailConstants {
  /** cosine at/above which the dedup ladder merges outright */
  merge: number;
  /** low edge of the judge band [judgeLow, merge) — LLM adjudicates */
  judgeLow: number;
  /** candidate similarity floor for check_decision retrieval */
  floor: number;
}

export interface EmbedderThresholds {
  /** conversation-link edge threshold (reference-space anchor: 0.70) */
  link: number;
  rail: DecisionRailConstants;
  /** ISO date of the calibration run, or "benchmarked-reference" */
  measuredAt: string;
  /** sha256 of the calibration corpus manifest; null for the reference space */
  corpusSha256: string | null;
}

export const REFERENCE_EMBEDDER = "text-embedding-3-small";

const MEASURED: Record<string, EmbedderThresholds | null> = {
  [REFERENCE_EMBEDDER]: {
    link: 0.7,
    rail: { merge: 0.7, judgeLow: 0.6, floor: 0.55 },
    measuredAt: "benchmarked-reference",
    corpusSha256: null,
  },
  // Measured 2026-09-19 by scripts/calibrate-thresholds.ts against the checked-in
  // synthetic corpus (fixtures/calibration-results.json holds the full run; the
  // drift test enforces that these values, the corpus, and the artifact pins agree).
  // Reconciliation against a private real corpus (offset > 0.02 resolves in favor
  // of the real reading) is a pre-tag gate; rerun `reconcile --apply` and update here.
  "nomic-embed-text-v1": {
    link: 0.8183,
    rail: { merge: 0.8183, judgeLow: 0.7728, floor: 0.7491 },
    measuredAt: "2026-09-19T04:39:54.402Z",
    corpusSha256: "43a491d0cd97b18272dad17d9df6407eb502f7e12ad671ee8af12081745efe79",
  },
  "all-MiniLM-L6-v2": {
    link: 0.7176,
    rail: { merge: 0.7176, judgeLow: 0.6127, floor: 0.546 },
    measuredAt: "2026-09-19T04:39:54.402Z",
    corpusSha256: "43a491d0cd97b18272dad17d9df6407eb502f7e12ad671ee8af12081745efe79",
  },
};

export function thresholdsFor(embedderId: string): EmbedderThresholds {
  const thresholds = MEASURED[embedderId];
  if (thresholds === undefined) {
    throw new Error(`unknown embedder "${embedderId}"`);
  }
  if (thresholds === null) {
    throw new Error(
      `no measured thresholds for embedder "${embedderId}" — constants are TBD-by-script ` +
        `(scripts/calibrate-thresholds.ts) and must be measured before use; ` +
        `refusing to run with a placeholder`,
    );
  }
  return thresholds;
}
