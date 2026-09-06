import { expect, it, vi } from "vitest";
import type { ChatBackend } from "../../llm/backend.js";
import {
  dominantRepo, enforceRepoPrefix, nameNewProjects, OVERLAP_THRESHOLD,
  reconcileProjects, repoDisplayName, type ProjectNote,
} from "../projects.js";

it("skips a completely unchanged membership partition regardless of ordering", () => {
  const existing = [{ id: "p1", name: "Keep", members: ["b", "a"] }, { id: "p2", name: "Also keep", members: ["d", "c"] }];
  const plan = reconcileProjects([["d", "c"], ["singleton"], ["a", "b"]], existing.reverse());
  expect(plan.unchanged).toBe(true);
  expect(plan.deleteProjectIds).toEqual([]);
  expect(plan.projects.map(p => p.existing?.name)).toEqual(["Keep", "Also keep"]);
  expect(reconcileProjects([["one"]], []).unchanged).toBe(true);
});

it("keeps IDs and names above half overlap, deletes vanished projects, and inserts new components", () => {
  const kept = { id: "keep", name: "Stable name", members: ["a", "b", "old"] };
  const plan = reconcileProjects([["a", "b", "new"], ["c", "d"], ["old"]], [
    kept, { id: "gone", name: "Vanished", members: ["gone-a", "gone-b"] },
  ]);
  expect(OVERLAP_THRESHOLD).toBe(0.5);
  expect(plan.unchanged).toBe(false);
  expect(plan.projects).toEqual([
    { members: ["a", "b", "new"], existing: kept }, { members: ["c", "d"], existing: null },
  ]);
  expect(plan.deleteProjectIds).toEqual(["gone"]);
});

it("does not match equality at 0.5, nor reuse an old project across split components", () => {
  const old = { id: "old", name: "Original", members: ["a", "b", "c", "d", "e"] };
  const split = reconcileProjects([["a", "b", "c"], ["d", "e"]], [old]);
  expect(split.projects.map(p => p.existing?.id ?? null)).toEqual(["old", null]);
  const boundary = reconcileProjects([["a", "b"], ["c", "d"]], [{ ...old, members: ["a", "b", "c", "d"] }]);
  expect(boundary.projects.every(p => p.existing === null)).toBe(true);
  expect(boundary.deleteProjectIds).toEqual(["old"]);
  expect(reconcileProjects([], [{ ...old, members: [] }])).toMatchObject({ unchanged: false, deleteProjectIds: ["old"] });
});

it.each([
  ["Auth Flows", "org/my-app", "my-app: Auth Flows"],
  ["my-app", "org/my-app", "my-app"],
  ["ORG/MY-APP", "org/my-app", "my-app"],
  ["my-app: Auth Flows", "org/my-app", "my-app: Auth Flows"],
  ["wrong-repo: Auth Flows", "org/my-app", "my-app: Auth Flows"],
  ["repo: ", "org/my-app", "my-app"],
  ["   ", "org/my-app", "my-app"],
  ["Build: Debugging", null, "Build: Debugging"],
  ["  Untouched  ", " \t", "  Untouched  "],
  ["C++ Auth", " /Org/C++/ ", "c++: C++ Auth"],
])("enforces repository prefix for %j and %j", (name, repo, expected) => {
  expect(enforceRepoPrefix([name], [repo])).toEqual([expected]);
});

it("uses the last nonempty path segment and dominant normalized repo, with stable ties", () => {
  expect(repoDisplayName("/org/my-app///")).toBe("my-app");
  expect(dominantRepo([null, " ", undefined])).toBeNull();
  expect(dominantRepo([" B ", "b", "a", null])).toBe("b");
  expect(dominantRepo(["b", "A"])).toBe("a");
  expect(dominantRepo(["A", "b"])).toBe("a");
});

const notes: ProjectNote[] = [
  { id: "a", topic: "Auth", conversation_title: null, repo_name: "org/app", project_id: null },
  { id: "b", topic: null, conversation_title: "Login title", repo_name: "ORG/APP", project_id: null },
  { id: "c", topic: "Storage", conversation_title: null, repo_name: null, project_id: null },
  { id: "d", topic: null, conversation_title: "Disk", repo_name: null, project_id: null },
  { id: "e", topic: null, conversation_title: "No topic", repo_name: null, project_id: null },
  { id: "f", topic: null, conversation_title: null, repo_name: null, project_id: null },
];
const plan = reconcileProjects([["a", "b"], ["c", "d"], ["e", "f"]], []);

it("retries a count mismatch exactly once then falls back for all new components, surfacing both mismatches", async () => {
  const completeJSON = vi.fn<ChatBackend["completeJSON"]>().mockResolvedValue('{"names":["Dropped two"]}');
  const result = await nameNewProjects(plan, notes, { modelId: "fake", completeJSON });
  expect(completeJSON).toHaveBeenCalledTimes(2);
  expect(result.names).toEqual(["app: Sessions", "Storage", "Project 3"]);
  expect(result.fallbackCount).toBe(3);
  expect(result.warnings).toHaveLength(2);
  expect(result.warnings[0]).toContain("expected 3 names, received 1");
});

it("accepts a repaired response on the one retry without positionally mixing names", async () => {
  const completeJSON = vi.fn<ChatBackend["completeJSON"]>()
    .mockResolvedValueOnce('{"names":[]}')
    .mockResolvedValueOnce('{"names":["Auth Flows","Storage Work","Untitled Work"]}');
  expect(await nameNewProjects(plan, notes, { modelId: "fake", completeJSON })).toMatchObject({
    names: ["app: Auth Flows", "Storage Work", "Untitled Work"], fallbackCount: 0,
  });
  expect(completeJSON).toHaveBeenCalledTimes(2);
});

it.each(["throws", "invalid JSON", "wrong schema", "non-string name"])("falls back with a surfaced warning for %s", async failure => {
  const completeJSON = vi.fn<ChatBackend["completeJSON"]>(async () => {
    if (failure === "throws") throw new Error("offline backend");
    if (failure === "invalid JSON") return "not JSON";
    if (failure === "wrong schema") return "null";
    return '{"names":[1,2,3]}';
  });
  const result = await nameNewProjects(plan, notes, { modelId: "fake", completeJSON });
  expect(result.names).toEqual(["app: Sessions", "Storage", "Project 3"]);
  expect(result.fallbackCount).toBe(3);
  expect(result.warnings).toHaveLength(1);
  expect(completeJSON).toHaveBeenCalledTimes(1);
});

it("names new clusters only and counts retained clusters in repository hints", async () => {
  const sameRepo = notes.map(note => ({ ...note, repo_name: "org/app" }));
  const reconciled = reconcileProjects([["a", "b"], ["c", "d"]], [{ id: "old", name: "Keep me", members: ["a", "b"] }]);
  const completeJSON = vi.fn<ChatBackend["completeJSON"]>().mockResolvedValue('{"names":["Storage Work"]}');
  const result = await nameNewProjects(reconciled, sameRepo, { modelId: "fake", completeJSON });
  expect(result.names).toEqual(["app: Storage Work"]);
  const request = completeJSON.mock.calls[0]![0];
  expect(request.prompt).toContain('Cluster 0 (2 conversations), repository "org/app" (2 clusters share this repo):');
  expect(request.prompt).toContain("- Storage\n- Disk");
  expect(request.prompt).not.toContain("- Auth");
  expect(request.prompt).toContain("Respond with exactly 1 names");
  expect(request.schema).toMatchObject({ required: ["names"] });
  const sole = reconcileProjects([["a", "b"]], []);
  await nameNewProjects(sole, notes, { modelId: "fake", completeJSON });
  expect(completeJSON.mock.calls[1]![0].prompt).toContain('sole cluster for repository "org/app"');
  expect(completeJSON.mock.calls[1]![0].prompt).toContain("- Auth\n- Login title");
  completeJSON.mockClear();
  await nameNewProjects(reconcileProjects([["a", "b"]], [{ id: "p", name: "Keep", members: ["b", "a"] }]), notes,
    { modelId: "fake", completeJSON });
  expect(completeJSON).not.toHaveBeenCalled();
});
