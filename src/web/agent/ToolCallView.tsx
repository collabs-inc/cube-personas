// Adapted from cube-computer: src/windows/app/src/items/agent/ToolCallView.tsx
import { useMemo } from "react";
import {
  ArrowsLeftRight,
  Brain,
  Code,
  DownloadSimple,
  Eye,
  MagnifyingGlass,
  MapPin,
  PencilSimple,
  Terminal as TerminalIcon,
  Trash,
  Wrench,
  type Icon,
} from "@phosphor-icons/react";
import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import { AgentContent, type AgentContentProps } from "./AgentContent";
import { unifiedLines, type DiffLine } from "./agent-item-logic";
import type { ToolCallState } from "./transcript";
import { ToolScreenshot } from "./ToolScreenshot";
import { screenshotReferences, type LoadScreenshot, type ResolveScreenshot } from "./tool-screenshots";
import type { ToolPresentationStatus } from "./activity-state";
import "./AgentTranscript.css";

const MAX_RAW_CHARACTERS = 24_000;

const KIND_ICONS: Record<ToolKind, Icon> = {
  read: Eye,
  edit: PencilSimple,
  delete: Trash,
  move: ArrowsLeftRight,
  search: MagnifyingGlass,
  execute: TerminalIcon,
  think: Brain,
  fetch: DownloadSimple,
  switch_mode: Code,
  other: Wrench,
};

const STATUS_LABELS: Record<ToolPresentationStatus, string> = {
  pending: "Waiting",
  in_progress: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  unconfirmed: "Unconfirmed",
};

export interface ToolCallViewProps {
  call: ToolCallState;
  status?: ToolPresentationStatus | undefined;
  /** Machine-native ACP paths are passed through unchanged. */
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
  formatPath?: ((path: string) => string) | undefined;
  onOpenExternal?: AgentContentProps["onOpenExternal"] | undefined;
  onCopy?: AgentContentProps["onCopy"] | undefined;
  searchQuery?: string | undefined;
  resolveScreenshot?: ResolveScreenshot | undefined;
  loadScreenshot?: LoadScreenshot | undefined;
}

export function ToolCallView(props: ToolCallViewProps) {
  const { call } = props;
  const screenshots = useMemo(() => props.resolveScreenshot ? screenshotReferences(call, props.resolveScreenshot) : [], [call, props.resolveScreenshot]);
  const KindIcon = KIND_ICONS[call.kind] ?? Wrench;
  const presentation = props.status ?? call.status;
  const status = STATUS_LABELS[presentation] ?? presentation;
  return (
    <article className="agent-tool" data-status={presentation} aria-label={`${call.title || call.kind}: ${status}`}>
      <div className="agent-tool-head">
        <span className="agent-tool-icon"><KindIcon size={14} aria-hidden="true" /></span>
        <span className="agent-tool-title">{call.title !== "" ? call.title : call.kind}</span>
        <span className="agent-tool-status" data-status={presentation}>{status}</span>
      </div>
      {call.locations.length > 0 && (
        <div className="agent-tool-locations" aria-label="Affected locations">
          {call.locations.map((location, index) => {
            const label = props.formatPath?.(location.path) ?? location.path;
            const content = <><MapPin size={12} aria-hidden="true" /><span>{label}{location.line ? `:${location.line}` : ""}</span></>;
            return props.onOpenPath ? (
              <button
                key={`${location.path}:${location.line ?? ""}:${index}`}
                type="button"
                className="agent-tool-location"
                onClick={() => props.onOpenPath?.(location.path, location.line ?? undefined)}
              >
                {content}
              </button>
            ) : <span key={`${location.path}:${location.line ?? ""}:${index}`} className="agent-tool-location agent-tool-location-static">{content}</span>;
          })}
        </div>
      )}
      {call.rawInput !== undefined && <RawValue label="Input" value={call.rawInput} searchQuery={props.searchQuery} />}
      {call.content.map((content, index) => (
        <ToolCallContentView
          key={index}
          content={content}
          onOpenPath={props.onOpenPath}
          formatPath={props.formatPath}
          onOpenExternal={props.onOpenExternal}
          onCopy={props.onCopy}
        />
      ))}
      {screenshots.length > 0 && props.loadScreenshot && props.onOpenPath && <div className="agent-tool-screenshots">
        {screenshots.map(reference => <ToolScreenshot key={reference.nativePath} reference={reference} load={props.loadScreenshot!} onOpenPath={props.onOpenPath!} />)}
      </div>}
      {call.rawOutput !== undefined && <RawValue label="Output" value={call.rawOutput} searchQuery={props.searchQuery}
        open={call.content.some(isTerminalContent)} />}
    </article>
  );
}

/**
 * This app advertises `terminal: false`, so an adapter reports a command's
 * output as text in `rawOutput` rather than as a live terminal. A terminal
 * reference that arrives anyway has nothing to attach to; the command's
 * Output opens instead, so its text is what the reader sees.
 */
function isTerminalContent(content: ToolCallContent): boolean {
  return (content as { type?: unknown }).type === "terminal";
}

function RawValue({ label, value, searchQuery, open = false }: {
  label: string; value: unknown; searchQuery?: string | undefined; open?: boolean;
}) {
  const whole = stringifyRaw(value);
  const query = searchQuery?.trim() ?? "";
  const matched = query !== "" && whole.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  return (
    <details className="agent-tool-raw" open={matched || open || undefined}>
      <summary className="agent-tool-raw-summary">{label}</summary>
      <pre className="agent-tool-raw-value">{rawExcerpt(whole, matched ? query : "")}</pre>
    </details>
  );
}

function stringifyRaw(value: unknown): string {
  let result: string;
  try {
    result = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    result = String(value);
  }
  return result;
}

function rawExcerpt(result: string, query: string): string {
  if (result.length <= MAX_RAW_CHARACTERS) return result;
  const match = query === "" ? -1 : result.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = match < 0 ? 0 : Math.max(0, match - Math.floor(MAX_RAW_CHARACTERS / 2));
  const end = Math.min(result.length, start + MAX_RAW_CHARACTERS);
  return `${start > 0 ? "… earlier output omitted\n" : ""}${result.slice(start, end)}${end < result.length ? "\n… later output omitted" : ""}`;
}

export interface ToolCallContentViewProps {
  content: ToolCallContent;
  onOpenPath?: ToolCallViewProps["onOpenPath"] | undefined;
  formatPath?: ToolCallViewProps["formatPath"] | undefined;
  onOpenExternal?: ToolCallViewProps["onOpenExternal"] | undefined;
  onCopy?: ToolCallViewProps["onCopy"] | undefined;
}

export function ToolCallContentView(props: ToolCallContentViewProps) {
  const { content } = props;
  const record = typeof content === "object" && content !== null ? content as unknown as Record<string, unknown> : null;
  if (
    record?.type === "diff"
    && typeof record.path === "string"
    && typeof record.newText === "string"
    && (record.oldText === undefined || record.oldText === null || typeof record.oldText === "string")
  ) {
    return (
      <DiffView
        path={record.path}
        oldText={record.oldText}
        newText={record.newText}
        onOpenPath={props.onOpenPath}
        formatPath={props.formatPath}
      />
    );
  }
  // No live terminal here: the call's Output carries the command's text.
  if (record?.type === "terminal" && typeof record.terminalId === "string") return null;
  if (
    record?.type === "content"
    && typeof record.content === "object"
    && record.content !== null
    && typeof (record.content as Record<string, unknown>).type === "string"
  ) return (
    <div className="agent-tool-content">
      <AgentContent
        content={record.content as AgentContentProps["content"]}
        compact
        onOpenExternal={props.onOpenExternal}
        onOpenPath={props.onOpenPath ? (path) => props.onOpenPath?.(path) : undefined}
        onCopy={props.onCopy}
      />
    </div>
  );
  return (
    <div className="agent-content agent-content-unsupported">
      Unsupported tool content{typeof record?.type === "string" ? ` (${record.type})` : ""}
    </div>
  );
}

interface NumberedDiffLine extends DiffLine {
  oldLine: number | null;
  newLine: number | null;
}

function numberDiffLines(lines: DiffLine[]): NumberedDiffLine[] {
  let oldLine = 1;
  let newLine = 1;
  return lines.map((line) => {
    if (line.kind === "truncated") return { ...line, oldLine: null, newLine: null };
    const numbered = {
      ...line,
      oldLine: line.kind === "add" ? null : oldLine,
      newLine: line.kind === "remove" ? null : newLine,
    };
    if (line.kind !== "add") oldLine += 1;
    if (line.kind !== "remove") newLine += 1;
    return numbered;
  });
}

function DiffView(props: {
  path: string;
  oldText: string | null | undefined;
  newText: string;
  onOpenPath?: ToolCallViewProps["onOpenPath"];
  formatPath?: ToolCallViewProps["formatPath"];
}) {
  const lines = numberDiffLines(unifiedLines(props.oldText, props.newText));
  const additions = lines.filter((line) => line.kind === "add").length;
  const removals = lines.filter((line) => line.kind === "remove").length;
  const label = props.formatPath?.(props.path) ?? props.path;
  const path = props.onOpenPath ? (
    <button type="button" className="agent-diff-path agent-diff-path-button" onClick={() => props.onOpenPath?.(props.path)}>{label}</button>
  ) : <span className="agent-diff-path">{label}</span>;
  return (
    <section className="agent-diff" aria-label={`Changes to ${label}`}>
      <div className="agent-diff-head">
        {path}
        <span className="agent-diff-counts" aria-label={`${additions} additions and ${removals} removals`}>
          <span className="agent-diff-additions">+{additions}</span>
          <span className="agent-diff-removals">−{removals}</span>
        </span>
      </div>
      <div className="agent-diff-body" role="table" aria-label="File diff">
        {lines.map((line, index) => (
          <div key={index} className="agent-diff-line" data-diff={line.kind} role="row">
            <span className="agent-diff-line-number" aria-hidden="true">{line.oldLine ?? ""}</span>
            <span className="agent-diff-line-number" aria-hidden="true">{line.newLine ?? ""}</span>
            <span className="agent-diff-prefix" aria-hidden="true">{prefixFor(line.kind)}</span>
            <code className="agent-diff-code">{line.text}</code>
          </div>
        ))}
      </div>
    </section>
  );
}

function prefixFor(kind: DiffLine["kind"]): string {
  if (kind === "add") return "+";
  if (kind === "remove") return "−";
  return " ";
}

export default ToolCallView;
