/** Normalize a repo identity for both backbone edges and clustering affinity. */
export function normalizeRepo(repo: string | null | undefined): string | null {
  if (!repo) return null;
  const t = repo.trim().toLowerCase();
  return t.length > 0 ? t : null;
}
