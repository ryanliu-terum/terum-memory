import { getMeta, type Db } from "../db/open.js";
import { completeJob, failJob, type JobClaim } from "../jobs/queue.js";
import type { ChatBackend } from "../llm/backend.js";
import { clusterConversations } from "./clustering.js";
import { computeLinkEdges, linkEdgeKey, repoBackboneEdges } from "./linker.js";
import {
  applyProjectPlan, nameNewProjects, reconcileProjects,
  type ExistingProject, type NamingResult, type ProjectNote,
} from "./projects.js";
import { thresholdsFor } from "./thresholds.js";

export interface LinkClusterResult {
  status: "done" | "stale" | "requeued" | "dead-letter";
  naming: NamingResult;
}

export async function runLinkClusterJob(
  db: Db, claim: JobClaim, deps: { backend: ChatBackend; now?: () => Date },
): Promise<LinkClusterResult> {
  let naming: NamingResult = { names: [], fallbackCount: 0, warnings: [] };
  try {
    if (claim.kind !== "link-cluster") throw new Error("Expected a link-cluster claim");
    const snapshot = db.transaction(() => {
      const embedderId = getMeta(db, "embedder_id");
      if (!embedderId) throw new Error("Missing meta.embedder_id");
      const threshold = thresholdsFor(embedderId).link;
      const notes = db.prepare(`SELECT id, repo_name, topic, conversation_title, project_id
        FROM notes ORDER BY id`).all() as ProjectNote[];
      const vectors = db.prepare("SELECT note_id, embedding FROM note_vec").all() as
        Array<{ note_id: string; embedding: Buffer }>;
      const embeddings = new Map(vectors.map(row => {
        if (row.embedding.byteLength === 0 || row.embedding.byteLength % 4 !== 0) {
          throw new Error(`Invalid embedding for note ${row.note_id}`);
        }
        // Decode explicitly: SQLite buffers need not be aligned to Float32 boundaries.
        const embedding = Float32Array.from({ length: row.embedding.byteLength / 4 },
          (_, index) => row.embedding.readFloatLE(index * 4));
        if (!embedding.every(Number.isFinite)) throw new Error(`Non-finite embedding for note ${row.note_id}`);
        return [row.note_id, embedding] as const;
      }));
      const rows = notes.map(note => {
        const embedding = embeddings.get(note.id);
        if (!embedding) throw new Error(`Missing embedding for note ${note.id}`);
        return { ...note, embedding };
      });
      const projects = db.prepare("SELECT id, name FROM projects ORDER BY id").all() as
        Array<{ id: string; name: string }>;
      const existing: ExistingProject[] = projects.map(project => ({
        ...project, members: notes.filter(note => note.project_id === project.id).map(note => note.id),
      }));
      return { threshold, rows, existing };
    })();
    const { rows, threshold, existing } = snapshot;
    const edges = new Map(computeLinkEdges(rows, threshold).map(edge => [linkEdgeKey(edge.a, edge.b), edge]));
    for (const edge of repoBackboneEdges(rows)) {
      const key = linkEdgeKey(edge.a, edge.b);
      if (!edges.has(key)) edges.set(key, edge);
    }
    const ids = rows.map(row => row.id);
    const clusters = clusterConversations(ids, [...edges.values()], new Map(rows.map(row => [row.id, row.repo_name])));
    const plan = reconcileProjects(clusters.components, existing);
    naming = await nameNewProjects(plan, rows, deps.backend);
    const computedAt = (deps.now ?? (() => new Date()))().toISOString();
    const completed = completeJob(db, claim, tx => {
      tx.prepare("DELETE FROM links").run();
      const insert = tx.prepare("INSERT INTO links (a, b, similarity, computed_at) VALUES (?, ?, ?, ?)");
      for (const edge of edges.values()) insert.run(edge.a, edge.b, edge.similarity, computedAt);
      applyProjectPlan(tx, plan, ids, naming.names, computedAt);
    }, deps);
    return { status: completed ? "done" : "stale", naming };
  } catch (error) {
    return { status: failJob(db, claim, error, deps), naming };
  }
}
