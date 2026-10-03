// Adapted from cube-computer: packages/shared/src/path-utils.ts (parseCloudPath only; CLOUD_PATH_PREFIX from packages/shared/src/types.ts)

export const CLOUD_PATH_PREFIX = "/@cloud/";

export interface ParsedCloudPath {
  repoId: string;
  rel: string;
}

/**
 * Collapses `.`/`..` segments in a virtual cloud path's relative portion,
 * without touching the filesystem or importing `node:path` (this module
 * runs in the page). Returns null if the result would climb above the repo
 * root, so a traversal attempt is refused here rather than silently normalized into
 * something that no longer means what the caller wrote.
 */
function normalizeRelPath(rel: string): string | null {
  const out: string[] = [];
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * Splits a virtual cloud path (`/@cloud/<repoId>/<rel>`) into its
 * repoId and root-relative remainder, or null if `p` isn't one. `rel`
 * is always root-relative and traversal-safe (see `normalizeRelPath`) —
 * callers join it onto the repo's real root without re-checking.
 */
export function parseCloudPath(p: string): ParsedCloudPath | null {
  if (!p.startsWith(CLOUD_PATH_PREFIX)) return null;
  const rest = p.slice(CLOUD_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  const repoId = slash === -1 ? rest : rest.slice(0, slash);
  if (!repoId) return null;
  const rel = normalizeRelPath(slash === -1 ? "" : rest.slice(slash + 1));
  return rel === null ? null : { repoId, rel };
}
