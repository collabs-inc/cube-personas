// Adapted from cube-computer: src/main/cubed/personas/wake-ups.ts
//
// Why a persona was woken, in a few words, decided in one place.
//
// The persona does not poll, so every return to it is a wake-up the server
// chose to send, and a wake-up that does not say why costs the persona a
// turn to find out. `Delivery` sends these, both as a wake of their own and
// appended to a user's prompt, so the persona reads one vocabulary however a
// report reaches it.
//
// Cube's `blocked` reason is gone: workers here run with permissions
// bypassed, so no report is about a permission decision.
import type { AgentReport } from "../../shared/types";

export const WAKE_UP_PREFIX = "Worker reports.";

export type WakeUpReason = "ended" | "exited" | "interrupted" | "question";

/**
 * A request for help, recognized from the report's CLOSING words.
 *
 * A worker that asks a question mid-report and then answers it is not
 * waiting; a worker whose last line is a question is waiting for the persona.
 * The last line must END with the mark — "Which branch? (main or fix)" is a
 * worker narrating, not asking — and a bare "?" is noise, not a question.
 */
export function isQuestion(text: string): boolean {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  // Markdown emphasis, code and quotation marks around the question are not its end.
  const last = (lines.at(-1) ?? "").replace(/^[*_`"'“”‘’]+|[*_`"'“”‘’]+$/gu, "");
  return last.length > 1 && last.endsWith("?");
}

export function wakeUpReasonOf(report: AgentReport): WakeUpReason {
  if (report.kind === "exited") return "exited";
  // A turn the server's stop cut off is not a finished one: the persona must
  // be able to tell the two apart, and no closing words exist to judge.
  if (report.kind === "interrupted") return "interrupted";
  return isQuestion(report.text) ? "question" : "ended";
}

const PHRASE: Record<WakeUpReason, string> = {
  ended: "finished",
  exited: "stopped",
  interrupted: "was cut off by a restart; its last message is unavailable",
  question: "is asking you something",
};

const nameOf = (report: AgentReport): string => report.title || report.agentId;

/**
 * One wake-up, one prompt: why it is awake, one line per report, then the
 * reports themselves as JSON (whose `messageUnavailable` tells the persona
 * when a worker's message could not be read).
 */
export function wakeUpPrompt(reports: readonly AgentReport[]): string {
  if (reports.length === 0) throw new Error("a wake-up needs at least one report");
  const lines = reports.map(report => `- ${nameOf(report)} ${PHRASE[wakeUpReasonOf(report)]}`);
  return `${WAKE_UP_PREFIX} Acknowledge received reportId values with ack on your next tool call.\n`
    + `${lines.join("\n")}\n${JSON.stringify({ reports })}`;
}
