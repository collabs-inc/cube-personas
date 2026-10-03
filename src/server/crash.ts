// What the server does when something throws that nothing caught. Children
// lead their own process groups, so nothing ends them for us: each tracked
// group is sent SIGTERM synchronously (the process cannot await anything
// any more), then the server exits 1.
import type { ProcessManager } from "./processes";

export function crashHandler(
  processes: ProcessManager,
  log: (line: string) => void = (line) => console.error(line),
  exit: (code: number) => void = (code) => process.exit(code),
): (err: unknown) => void {
  let crashed = false;
  return (err: unknown) => {
    if (crashed) return;
    crashed = true;
    try {
      log(`Personas crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    } catch {}
    try {
      processes.terminateAllSync();
    } catch {}
    exit(1);
  };
}
