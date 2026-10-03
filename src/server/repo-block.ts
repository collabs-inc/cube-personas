// Adapted from cube-computer: src/main/cubed/personas/repo-block.ts
/** The persona context folder's `## Repositories` block: the persona's known set. */
export const REPO_BLOCK_MARKER =
  "<!-- cube:repos — Cube and the persona menu both edit this list. "
  + "One absolute path per line. -->";
const MARKER_PREFIX = "<!-- cube:repos";
const ENTRY = /^- (\/\S.*?)\s*$/;

interface BlockSpan { lines: string[]; eol: string; start: number; end: number }

function span(text: string): BlockSpan | null {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const marker = lines.findIndex(line => line.startsWith(MARKER_PREFIX));
  if (marker < 0) return null;
  let end = marker + 1;
  while (end < lines.length && !lines[end]!.startsWith("#")) end++;
  return { lines, eol, start: marker + 1, end };
}

export function parseRepoBlock(text: string): string[] {
  const block = span(text);
  if (!block) return [];
  const seen = new Set<string>();
  for (const line of block.lines.slice(block.start, block.end)) {
    const match = ENTRY.exec(line);
    if (match) seen.add(match[1]!);
  }
  return [...seen];
}

export function writeRepoBlock(text: string, paths: readonly string[]): string {
  const entries = [...new Set(paths)].map(path => `- ${path}`);
  const block = span(text);
  if (!block) {
    const base = text.endsWith("\n") ? text : `${text}\n`;
    return `${base}\n## Repositories\n${REPO_BLOCK_MARKER}\n`
      + entries.map(e => `${e}\n`).join("");
  }
  const inside = block.lines.slice(block.start, block.end);
  const firstEntry = inside.findIndex(line => ENTRY.test(line));
  const kept = inside.filter(line => !ENTRY.test(line));
  const at = firstEntry < 0 ? 0 : firstEntry;
  kept.splice(at, 0, ...entries);
  const lines = [...block.lines.slice(0, block.start), ...kept, ...block.lines.slice(block.end)];
  return lines.join(block.eol);
}

export function assertAbsolutePaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (/[\r\n]/.test(path)) throw new Error(`${JSON.stringify(path)} contains a line break`);
    if (!path.startsWith("/")) throw new Error(`"${path}" is not an absolute path`);
  }
}
