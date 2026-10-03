// Adapted from cube-computer: src/windows/app/src/items/agent/activity-state.ts
import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import type { Turn } from "./transcript";

/** Presentation of unfinished work, independent of the last ACP status.
 * A missing result is not success; a disconnected adapter may still run. */
export type TurnActivity = "live" | "interrupted" | "unconfirmed";
export type ToolPresentationStatus = ToolCallStatus | Exclude<TurnActivity, "live">;

export function turnActivity(
  turn: Turn,
  session: { current: boolean; connected: boolean; stopped: boolean },
): TurnActivity {
  if (turn.end === "cancelled" || turn.end === "error") return "interrupted";
  if (turn.end !== null) return "unconfirmed";
  if (!session.current) return "unconfirmed";
  if (session.stopped) return "interrupted";
  return session.connected ? "live" : "unconfirmed";
}

export function toolPresentationStatus(status: ToolCallStatus, activity: TurnActivity): ToolPresentationStatus {
  if (status !== "pending" && status !== "in_progress") return status;
  return activity === "live" ? status : activity;
}
