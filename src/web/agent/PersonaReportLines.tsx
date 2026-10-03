// Adapted from cube-computer: src/windows/app/src/persona/PersonaReportLines.tsx
import { Check, Info, Warning } from "@phosphor-icons/react";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import "./PersonaEventLines.css";

interface ReportLine { label: string; status: "completed" | "interrupted" | "unconfirmed" }

const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Read the existing wake-prompt envelope without altering the agent's transcript. */
function reportLines(blocks: readonly ContentBlock[]): ReportLine[] {
  const lines: ReportLine[] = [];
  for (const block of blocks) {
    if (block.type !== "text") continue;
    // The JSON follows the wake-up's summary lines; a title may hold a brace.
    const line = block.text.indexOf("\n{");
    const start = line >= 0 ? line + 1 : block.text.indexOf("{");
    if (start < 0) continue;
    try {
      const envelope: unknown = JSON.parse(block.text.slice(start));
      if (!envelope || typeof envelope !== "object" || !("reports" in envelope) || !Array.isArray(envelope.reports)) continue;
      for (const report of envelope.reports) {
        if (!report || typeof report !== "object" || typeof report.kind !== "string" || typeof report.text !== "string") continue;
        const name = typeof report.title === "string" && report.title !== report.agentId
          ? singleLine(report.title) || "Worker" : "Worker";
        const action = report.kind === "blocked" ? "needs attention"
          : report.kind === "interrupted" ? "interrupted"
          : report.kind === "exited" ? "exited" : "reported";
        // A turn ending is a report, not proof that the worker's task is complete.
        const status = report.kind === "blocked" || report.kind === "interrupted" ? "interrupted"
          : report.kind === "ended" ? "completed" : "unconfirmed";
        const summary = singleLine(report.text);
        lines.push({ label: `${name} ${action}${summary ? ` — ${summary}` : ""}`, status });
      }
    } catch {
      // Older or partial report envelopes still get a compact event below.
    }
  }
  return lines.length ? lines : [{ label: "Worker report received", status: "unconfirmed" }];
}

/** A turn the server began with worker reports, labelled as such — never shown as the user's message. */
export function PersonaReportLines({ blocks }: { blocks: readonly ContentBlock[] }) {
  return <section className="persona-report" aria-label="Cube report">
    <div className="persona-report-label">Cube report</div>
    <ul className="persona-events" aria-label="Worker reports">
    {reportLines(blocks).map(({ label, status }, index) => <li
      className="persona-event persona-action-event persona-report-event" data-status={status} key={index}>
      <span className="persona-event-icon" aria-hidden="true">
        {status === "completed" ? <Check size={12} /> : status === "interrupted" ? <Warning size={12} /> : <Info size={12} />}
      </span>
      <span className="persona-event-label" title={label}>{label}</span>
    </li>)}
    </ul>
  </section>;
}
