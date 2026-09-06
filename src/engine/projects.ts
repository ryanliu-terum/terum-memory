import { randomUUID } from "node:crypto";
import type { Db } from "../db/open.js";
import type { ChatBackend } from "../llm/backend.js";
import { normalizeRepo } from "./normalize-repo.js";

export const OVERLAP_THRESHOLD = 0.5;
const MAX_NAME_CANDIDATES = 1_000;

export interface ProjectNote {
  id: string;
  repo_name: string | null;
  topic: string | null;
  conversation_title: string | null;
  project_id: string | null;
}
export interface ExistingProject { id: string; name: string; members: string[] }
export interface PlannedProject { members: string[]; existing: ExistingProject | null }
export interface ProjectPlan {
  unchanged: boolean;
  projects: PlannedProject[];
  deleteProjectIds: string[];
}

/** Pure reconciliation, in canonical component order; equality is not enough to match. */
export function reconcileProjects(components: string[][], existing: ExistingProject[]): ProjectPlan {
  const multi = components.filter(c => c.length >= 2).map(c => [...c].sort())
    .sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
  const partition = (sets: string[][]) => sets.map(s => JSON.stringify([...s].sort())).sort();
  const unchanged = JSON.stringify(partition(multi)) === JSON.stringify(partition(existing.map(p => p.members)));
  const unmatched = new Map([...existing].sort((a, b) => a.id.localeCompare(b.id)).map(p => [p.id, p]));
  const projects = multi.map(members => {
    const memberSet = new Set(members);
    let best: ExistingProject | null = null;
    let bestRatio = OVERLAP_THRESHOLD;
    for (const project of unmatched.values()) {
      const intersection = project.members.filter(id => memberSet.has(id)).length;
      const ratio = intersection / Math.max(members.length, project.members.length);
      if (ratio > bestRatio) { best = project; bestRatio = ratio; }
    }
    if (best) unmatched.delete(best.id);
    return { members, existing: best };
  });
  return { unchanged, projects, deleteProjectIds: [...unmatched.keys()] };
}

export function repoDisplayName(repo: string): string {
  return repo.split("/").filter(segment => segment.length > 0).at(-1) ?? "";
}

/** Normalized identity is retained, including its path; ties use lexical order. */
export function dominantRepo(repoNames: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const name of repoNames) {
    const repo = normalizeRepo(name);
    if (repo !== null) counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

export function enforceRepoPrefix(names: string[], clusterRepos: Array<string | null>): string[] {
  return names.map((name, i) => {
    const repo = normalizeRepo(clusterRepos[i]);
    if (repo === null) return name;
    const display = repoDisplayName(repo);
    let tail = name.trim();
    // A leading colon-separated label is the model's repository prefix.
    const colon = tail.indexOf(":");
    if (colon >= 0) tail = tail.slice(colon + 1).trim();
    if (normalizeRepo(tail) === repo || normalizeRepo(tail) === display) tail = "";
    return tail ? `${display}: ${tail}` : display;
  });
}

export interface NamingResult {
  names: string[];
  fallbackCount: number;
  warnings: string[];
}

export async function nameNewProjects(
  plan: ProjectPlan,
  notes: ProjectNote[],
  backend: ChatBackend,
): Promise<NamingResult> {
  const fresh = plan.projects.filter(p => p.existing === null);
  if (fresh.length === 0) return { names: [], fallbackCount: 0, warnings: [] };
  const noteMap = new Map(notes.map(note => [note.id, note]));
  const repos = plan.projects.map(p => dominantRepo(p.members.map(id => noteMap.get(id)?.repo_name)));
  const clusterRepos = fresh.map(p => repos[plan.projects.indexOf(p)]!);
  const descriptions = fresh.map((project, i) => {
    const repo = clusterRepos[i];
    const count = repos.filter(r => r === repo).length;
    const hint = repo === null ? "" : count === 1
      ? `, sole cluster for repository "${repo}"`
      : `, repository "${repo}" (${count} clusters share this repo)`;
    const topics = project.members.map(id => {
      const note = noteMap.get(id);
      return `- ${note?.topic || note?.conversation_title || "Untitled conversation"}`;
    }).join("\n");
    return `Cluster ${i} (${project.members.length} conversations)${hint}:\n${topics}`;
  });
  const prompt = [
    "Name each conversation cluster with a short descriptive label (2-5 words).",
    "The name should capture the common theme across the conversations in that cluster.",
    'If all conversations in a cluster share the same repository, prefix the name with the repository name and a colon, then a short descriptive theme (e.g., "my-app: Auth Flows"). Always include the descriptive theme — never the repository name alone.',
    "", descriptions.join("\n\n"), "",
    `Respond with exactly ${fresh.length} names, one per line, in cluster order.`,
  ].join("\n");
  const schema = {
    type: "object", properties: { names: { type: "array", items: { type: "string" } } },
    required: ["names"], additionalProperties: false,
  };
  const warnings: string[] = [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response: unknown = JSON.parse(await backend.completeJSON({ prompt, schema, timeoutMs: 60_000 }));
      if (typeof response !== "object" || response === null || !("names" in response)
        || !Array.isArray(response.names) || !response.names.every((name): name is string => typeof name === "string")) {
        throw new Error("Invalid cluster naming response: expected { names: string[] }");
      }
      if (response.names.length === fresh.length) {
        return { names: enforceRepoPrefix(response.names, clusterRepos), fallbackCount: 0, warnings };
      }
      warnings.push(`Cluster naming attempt ${attempt + 1}: expected ${fresh.length} names, received ${response.names.length}`);
    }
  } catch (error) {
    warnings.push(`Cluster naming failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const names = fresh.map((project, i) => {
    const repo = clusterRepos[i];
    return repo != null ? `${repoDisplayName(repo)}: Sessions`
      : noteMap.get(project.members[0]!)?.topic || `Project ${i + 1}`;
  });
  return { names, fallbackCount: fresh.length, warnings };
}

/** Must run inside completeJob so both business writes and the completion are fenced. */
export function applyProjectPlan(
  db: Db, plan: ProjectPlan, noteIds: string[], newNames: string[], computedAt: string,
): void {
  if (!db.inTransaction) throw new Error("Project persistence requires a transaction");
  if (plan.unchanged) return;
  if (newNames.length !== plan.projects.filter(p => p.existing === null).length) {
    throw new Error("Project name count does not match reconciliation plan");
  }
  const clear = db.prepare("UPDATE notes SET project_id = NULL WHERE project_id = ?");
  const remove = db.prepare("DELETE FROM projects WHERE id = ?");
  for (const id of plan.deleteProjectIds) { clear.run(id); remove.run(id); }
  const occupied = db.prepare("SELECT id FROM projects WHERE name = ? COLLATE NOCASE");
  const insert = db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)");
  const assignments = new Map<string, string>();
  let newIndex = 0;
  for (const project of plan.projects) {
    let id = project.existing?.id;
    if (id === undefined) {
      const base = newNames[newIndex++]!;
      let name: string | undefined;
      for (let candidate = 1; candidate <= MAX_NAME_CANDIDATES; candidate++) {
        const value = candidate === 1 ? base : `${base} (${candidate})`;
        if (!occupied.get(value)) { name = value; break; }
      }
      if (name === undefined) throw new Error(`Exhausted ${MAX_NAME_CANDIDATES} project name candidates`);
      id = randomUUID();
      insert.run(id, name, computedAt);
    }
    for (const member of project.members) assignments.set(member, id);
  }
  const assign = db.prepare("UPDATE notes SET project_id = ? WHERE id = ?");
  for (const id of noteIds) assign.run(assignments.get(id) ?? null, id);
}
