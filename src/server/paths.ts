import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the app keeps its state: never inside the app's own folder. */
export function stateDir(): string {
  const explicit = process.env.PERSONAS_STATE_DIR;
  if (explicit) return explicit;
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return join(xdg, "cube-personas");
  return join(homedir(), ".local", "state", "cube-personas");
}

/** A persona's context folder, `~/.cube/personas/<id>`. */
export function contextFolderOf(personaId: string): string {
  return join(homedir(), ".cube", "personas", personaId);
}

/** The folder holding the app's `package.json` (works from source and from dist/server.js). */
export function appRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("package.json not found above the server");
    dir = parent;
  }
}
