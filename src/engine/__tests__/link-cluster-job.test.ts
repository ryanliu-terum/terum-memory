import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createVecTables, openDb, setMeta, type Db } from "../../db/open.js";
import { claimNext, enqueueCoalesced, failJob, retryFailed } from "../../jobs/queue.js";
import type { ChatBackend } from "../../llm/backend.js";
import { runLinkClusterJob } from "../link-cluster-job.js";
import { applyProjectPlan, reconcileProjects } from "../projects.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "terum-link-cluster-"));
  const connections: Db[] = [];
  const connect = () => {
    const db = openDb({ dbPath: path.join(dir, "terum.db") });
    connections.push(db);
    return db;
  };
  cleanup.push(() => {
    for (const db of connections) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const db = connect();
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = { now: () => new Date(time) };
  db.transaction(() => {
    createVecTables(db, 3);
    setMeta(db, "embedder_id", "text-embedding-3-small");
  })();
  const completeJSON = vi.fn<ChatBackend["completeJSON"]>(async () => {
    expect(db.inTransaction).toBe(false);
    return '{"names":["Auth Flows","Storage Work"]}';
  });
  const deps = { ...clock, backend: { modelId: "fake", completeJSON } };
  const note = (id: string, vector: number[] | null, repo: string | null, target = db) => {
    target.transaction(() => {
      target.prepare(`INSERT INTO notes (id, site, conversation_id, conversation_title, turn_count,
        topic, compacted_text, repo_name, model_used, first_captured_at, last_captured_at, distilled_at)
        VALUES (?, 'test', ?, ?, 1, ?, 'text', ?, 'fake', ?, ?, ?)`)
        .run(id, id, `Title ${id}`, `Topic ${id}`, repo, clock.now().toISOString(), clock.now().toISOString(), clock.now().toISOString());
      if (vector !== null) target.prepare("INSERT INTO note_vec (note_id, embedding) VALUES (?, ?)").run(id, new Float32Array(vector));
    })();
  };
  const seed = () => {
    note("a", [1, 0, 0], " Org/App "); note("b", [1, 0, 0], "org/app");
    note("c", [0, 1, 0], "storage"); note("d", [0, 1, 0], "STORAGE");
    note("e", [0, 0, 1], null);
  };
  const claim = () => {
    enqueueCoalesced(db, "link-cluster", {}, clock);
    const result = claimNext(db, clock);
    if (!result) throw new Error("Expected job claim");
    return result;
  };
  return { db, connect, clock, advance: (ms: number) => { time += ms; }, completeJSON, deps, note, seed, claim };
}

function businessState(db: Db) {
  return {
    links: db.prepare("SELECT * FROM links ORDER BY a, b").all(),
    projects: db.prepare("SELECT * FROM projects ORDER BY id").all(),
    notes: db.prepare("SELECT id, project_id FROM notes ORDER BY id").all(),
  };
}
function status(db: Db, id: string) {
  return db.prepare("SELECT status, last_error, attempts, epoch FROM jobs WHERE id = ?").get(id);
}
function addProject(db: Db, id: string, name: string, members: string[]) {
  db.transaction(() => {
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, 'original')").run(id, name);
    for (const member of members) db.prepare("UPDATE notes SET project_id = ? WHERE id = ?").run(id, member);
  })();
}

it("recomputes links and projects end-to-end, then skips all project writes for an unchanged partition", async () => {
  const f = fixture(); f.seed();
  const claim = f.claim();
  expect(await runLinkClusterJob(f.db, claim, f.deps)).toMatchObject({ status: "done", naming: { fallbackCount: 0 } });
  expect(status(f.db, claim.id)).toMatchObject({ status: "done" });
  const before = businessState(f.db);
  expect(before.links).toEqual([
    { a: "a", b: "b", similarity: 1, computed_at: f.clock.now().toISOString() },
    { a: "c", b: "d", similarity: 1, computed_at: f.clock.now().toISOString() },
  ]);
  const projects = f.db.prepare("SELECT id, name FROM projects ORDER BY name").all() as Array<{ id: string; name: string }>;
  expect(projects.map(p => p.name)).toEqual(["app: Auth Flows", "storage: Storage Work"]);
  expect(before.notes).toEqual([
    { id: "a", project_id: projects[0]!.id }, { id: "b", project_id: projects[0]!.id },
    { id: "c", project_id: projects[1]!.id }, { id: "d", project_id: projects[1]!.id },
    { id: "e", project_id: null },
  ]);
  // Any project or membership write on the fast path would abort the transaction.
  f.db.exec(`CREATE TRIGGER no_project_insert BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'project insert'); END;
    CREATE TRIGGER no_project_update BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'project update'); END;
    CREATE TRIGGER no_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'project delete'); END;
    CREATE TRIGGER no_assignment BEFORE UPDATE OF project_id ON notes BEGIN SELECT RAISE(ABORT, 'assignment'); END;`);
  f.advance(1_000);
  // Full recompute must delete this obsolete edge even on the unchanged-project fast path.
  f.db.transaction(() => f.db.prepare("INSERT INTO links VALUES ('a', 'e', 0.9, 'obsolete')").run())();
  const rerun = f.claim();
  expect((await runLinkClusterJob(f.db, rerun, f.deps)).status).toBe("done");
  expect(status(f.db, rerun.id)).toMatchObject({ status: "done" });
  const after = businessState(f.db);
  expect(after.projects).toEqual(before.projects);
  expect(after.notes).toEqual(before.notes);
  expect(after.links).toEqual((before.links as Array<Record<string, unknown>>).map(link => ({ ...link, computed_at: f.clock.now().toISOString() })));
  expect(f.completeJSON).toHaveBeenCalledTimes(1);
});

it("persists sub-threshold backbone edges while real similarity wins for shared pairs", async () => {
  const f = fixture(); f.seed();
  f.db.transaction(() => f.db.prepare("UPDATE note_vec SET embedding = ? WHERE note_id = 'b'").run(new Float32Array([-1, 0, 0])))();
  expect((await runLinkClusterJob(f.db, f.claim(), f.deps)).status).toBe("done");
  expect(f.db.prepare("SELECT a, b, similarity FROM links ORDER BY a").all()).toEqual([
    { a: "a", b: "b", similarity: 0.5 }, { a: "c", b: "d", similarity: 1 },
  ]);
  expect(businessState(f.db).projects).toHaveLength(2);
});

it.each(["missing", "nomic-embed-text-v1", "unknown"])("requeues invalid embedder configuration %s without business writes", async embedder => {
  const f = fixture(); f.seed();
  addProject(f.db, "existing", "Preserve", ["a", "b"]);
  f.db.transaction(() => {
    if (embedder === "missing") f.db.prepare("DELETE FROM meta WHERE key = 'embedder_id'").run();
    else setMeta(f.db, "embedder_id", embedder);
  })();
  const before = businessState(f.db);
  const claim = f.claim();
  expect((await runLinkClusterJob(f.db, claim, f.deps)).status).toBe("requeued");
  expect(businessState(f.db)).toEqual(before);
  expect(status(f.db, claim.id)).toMatchObject({ status: "queued", attempts: 1, last_error: expect.any(String) });
  expect(f.completeJSON).not.toHaveBeenCalled();
});

it("requeues a missing vector without dropping its note silently", async () => {
  const f = fixture(); f.note("missing-vector", null, null);
  const claim = f.claim();
  const before = businessState(f.db);
  expect((await runLinkClusterJob(f.db, claim, f.deps)).status).toBe("requeued");
  expect(status(f.db, claim.id)).toMatchObject({ last_error: "Missing embedding for note missing-vector" });
  expect(businessState(f.db)).toEqual(before);
});

it("naming failures remain decoration: completes with fallback names and counted warnings", async () => {
  const f = fixture(); f.seed();
  f.completeJSON.mockRejectedValueOnce(new Error("backend offline"));
  const result = await runLinkClusterJob(f.db, f.claim(), f.deps);
  expect(result).toMatchObject({ status: "done", naming: { fallbackCount: 2, warnings: ["Cluster naming failed: backend offline"] } });
  expect(f.db.prepare("SELECT name FROM projects ORDER BY name").all()).toEqual([{ name: "app: Sessions" }, { name: "storage: Sessions" }]);
});

it("persists reconciliation atomically: preserves name/id, deletes vanished project, inserts new, clears singleton", () => {
  const f = fixture(); f.seed();
  f.note("f", [0, 0, -1], null);
  addProject(f.db, "keep", "Original Name", ["a", "b", "e"]);
  addProject(f.db, "gone", "Vanished", ["c", "d"]);
  const plan = reconcileProjects([["a", "b", "f"], ["c", "e"], ["d"]], [
    { id: "keep", name: "Original Name", members: ["a", "b", "e"] },
    { id: "gone", name: "Vanished", members: ["c", "d"] },
  ]);
  f.db.transaction(() => applyProjectPlan(f.db, plan, [..."abcdef"], ["New Theme"], "now"))();
  expect(f.db.prepare("SELECT * FROM projects WHERE id = 'keep'").get()).toEqual({ id: "keep", name: "Original Name", created_at: "original" });
  expect(f.db.prepare("SELECT * FROM projects WHERE id = 'gone'").get()).toBeUndefined();
  const inserted = f.db.prepare("SELECT id FROM projects WHERE name = 'New Theme'").get() as { id: string };
  expect(businessState(f.db).notes).toEqual([
    { id: "a", project_id: "keep" }, { id: "b", project_id: "keep" }, { id: "c", project_id: inserted.id },
    { id: "d", project_id: null }, { id: "e", project_id: inserted.id }, { id: "f", project_id: "keep" },
  ]);
  expect(() => applyProjectPlan(f.db, plan, [], [], "now")).toThrow("transaction");
});

it("suffixes case-insensitive name collisions against retained and newly inserted projects", () => {
  const f = fixture(); f.seed(); f.note("f", [0, 0, -1], null);
  addProject(f.db, "keep", "Theme", ["a", "b"]);
  const plan = reconcileProjects([["a", "b"], ["c", "d"], ["e", "f"]], [{ id: "keep", name: "Theme", members: ["a", "b"] }]);
  f.db.transaction(() => applyProjectPlan(f.db, plan, [..."abcdef"], ["theme", "THEME"], "now"))();
  expect(f.db.prepare("SELECT name FROM projects ORDER BY name").all()).toEqual([
    { name: "Theme" }, { name: "theme (2)" }, { name: "THEME (3)" },
  ]);
});

it.each(["assignment", "completion"])("rolls back link replacement and all project writes on %s failure", async failure => {
  const f = fixture(); f.seed();
  addProject(f.db, "gone", "Old", ["a", "e"]);
  f.db.transaction(() => f.db.prepare("INSERT INTO links VALUES ('a', 'e', 0.9, 'old')").run())();
  const claim = f.claim();
  if (failure === "assignment") f.db.exec("CREATE TRIGGER reject_assignment BEFORE UPDATE OF project_id ON notes BEGIN SELECT RAISE(ABORT, 'assignment failed'); END");
  else f.db.exec("CREATE TRIGGER reject_completion BEFORE UPDATE OF status ON jobs WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'completion failed'); END");
  const before = businessState(f.db);
  expect((await runLinkClusterJob(f.db, claim, f.deps)).status).toBe("requeued");
  expect(businessState(f.db)).toEqual(before);
  expect(status(f.db, claim.id)).toMatchObject({ status: "queued", last_error: `${failure} failed` });
});

it.each([false, true])("a reclaimed claim commits no business writes (fresh worker completed=%s)", async completed => {
  const f = fixture(); f.seed();
  const other = f.connect();
  const stale = f.claim();
  let expected = businessState(f.db);
  let expectedJob: unknown;
  f.completeJSON.mockImplementationOnce(async () => {
    expect(f.db.inTransaction).toBe(false);
    f.advance(300_001);
    const fresh = claimNext(other, f.clock)!;
    expect(fresh).toMatchObject({ id: stale.id, attempts: 2 });
    if (completed) await runLinkClusterJob(other, fresh, {
      ...f.clock, backend: { modelId: "fresh", completeJSON: async () => '{"names":["Fresh Auth","Fresh Storage"]}' },
    });
    expected = businessState(other);
    expectedJob = status(other, stale.id);
    return '{"names":["Stale Auth","Stale Storage"]}';
  });
  expect((await runLinkClusterJob(f.db, stale, f.deps)).status).toBe("stale");
  expect(businessState(f.db)).toEqual(expected);
  expect(status(f.db, stale.id)).toEqual(expectedJob);
});

it("fences the epoch as well as attempts after retryFailed resets the counter", async () => {
  const f = fixture(); f.seed();
  const stale = f.claim();
  failJob(f.db, stale, "old attempt", { ...f.clock, fatal: true });
  retryFailed(f.db, f.clock);
  const fresh = claimNext(f.db, f.clock)!;
  expect(fresh).toMatchObject({ attempts: stale.attempts, epoch: stale.epoch + 1 });
  const before = businessState(f.db);
  const jobBefore = status(f.db, fresh.id);
  expect((await runLinkClusterJob(f.db, stale, f.deps)).status).toBe("stale");
  expect(businessState(f.db)).toEqual(before);
  expect(status(f.db, fresh.id)).toEqual(jobBefore);
});

it("allows a note to arrive during naming and includes it on the next coalesced recompute", async () => {
  const f = fixture(); f.seed();
  const other = f.connect();
  f.completeJSON.mockImplementationOnce(async () => {
    expect(f.db.inTransaction).toBe(false);
    f.note("late", [0, 0, 1], null, other);
    enqueueCoalesced(other, "link-cluster", {}, f.clock);
    return '{"names":["Auth Flows","Storage Work"]}';
  });
  expect((await runLinkClusterJob(f.db, f.claim(), f.deps)).status).toBe("done");
  expect(f.db.prepare("SELECT project_id FROM notes WHERE id = 'late'").get()).toEqual({ project_id: null });
  f.completeJSON.mockResolvedValueOnce('{"names":["Late Sessions"]}');
  const next = claimNext(f.db, f.clock)!;
  expect((await runLinkClusterJob(f.db, next, f.deps)).status).toBe("done");
  const projects = f.db.prepare("SELECT id, project_id FROM notes WHERE id IN ('e', 'late') ORDER BY id").all() as Array<{ project_id: string }>;
  expect(projects[0]!.project_id).not.toBeNull();
  expect(projects[1]!.project_id).toBe(projects[0]!.project_id);
  expect(f.completeJSON).toHaveBeenCalledTimes(2);
});

it("an empty recompute deletes obsolete empty projects and completes without naming", async () => {
  const f = fixture();
  addProject(f.db, "orphan", "Old", []);
  expect((await runLinkClusterJob(f.db, f.claim(), f.deps)).status).toBe("done");
  expect(businessState(f.db)).toEqual({ notes: [], projects: [], links: [] });
  expect(f.completeJSON).not.toHaveBeenCalled();
});
