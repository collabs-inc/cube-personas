import { startApp } from "./app";
import { crashHandler } from "./crash";
import { ProcessManager } from "./processes";

const processes = new ProcessManager();
const crash = crashHandler(processes);
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

const starting = startApp({ processes });
let stopping = false;

// Children lead their own process groups, so nothing ends them for us: end
// them before exiting — including a signal that arrives mid-start, which
// waits for the start to finish so that what it spawned is ended too.
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    const app = await starting;
    await app.close();
  } catch (err) {
    console.warn(`shutdown: ${(err as Error).message}`);
  }
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => void shutdown());

starting.then(
  (app) => console.log(`Personas listening on http://127.0.0.1:${app.port}`),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
