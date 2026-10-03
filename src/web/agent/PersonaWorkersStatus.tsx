// Adapted from cube-computer: src/windows/app/src/persona/PersonaWorkersStatus.tsx (with runningText from persona-workers.ts)
import type { Worker } from "../../shared/types";
import { useWorkers } from "../stores/workers";
import "./PersonaWorkersStatus.css";

/**
 * A quiet line under the last turn, for the state the typing indicator used
 * to be misread as. It is not a turn, not an event and not a transcript
 * block: it is the current truth about other sessions, so it appears and
 * disappears with them and is never persisted anywhere.
 *
 * Cube's "waiting on you" count is gone: workers here run with permissions
 * bypassed, so none is ever blocked on a decision.
 */
export function PersonaWorkersStatus({ workers }: { workers: readonly Worker[] }) {
  const running = runningText(workers.filter((worker) => worker.state === "running").length);
  if (running === null) return null;
  return <div className="persona-workers-status" role="status">
    <span className="persona-workers-running">{running}</span>
  </div>;
}

export function runningText(running: number): string | null {
  if (running === 0) return null;
  return `${running} ${running === 1 ? "worker" : "workers"} running`;
}

/**
 * The line wired to the workers store. It subscribes on its own so a worker
 * change re-renders this line, not the whole conversation it sits in.
 */
export function LivePersonaWorkersStatus({ personaId }: { personaId: string }) {
  return <PersonaWorkersStatus workers={useWorkers(personaId)} />;
}
