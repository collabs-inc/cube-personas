// Adapted from cube-computer: src/windows/app/src/items/agent/TurnView.tsx
import { memo, useId, useState, type ReactNode } from "react";
import { CaretDown, CaretRight, Check, Circle, Copy, Robot, SpinnerGap, Warning } from "@phosphor-icons/react";
import type { ContentBlock, PlanEntry } from "@agentclientprotocol/sdk";
import { AgentContent, type AgentContentProps } from "./AgentContent";
import { searchableToolText } from "./conversation-logic";
import { foldRuns, type Segment } from "./agent-item-logic";
import { ToolCallView, type ToolCallViewProps } from "./ToolCallView";
import type { Block, Turn } from "./transcript";
import { toolPresentationStatus, type TurnActivity } from "./activity-state";
import "./AgentTranscript.css";
import { PersonaTyping } from "./PersonaTyping";
import { shownUserBlocks } from "./persona-blocks";
import { PersonaReportLines } from "./PersonaReportLines";

export interface TurnViewProps {
  quietActivity?: boolean;
  turn: Turn;
  /** Only the current observed prompt of a connected adapter is live. */
  activity: TurnActivity;
  onOpenPath?: ToolCallViewProps["onOpenPath"] | undefined;
  formatPath?: ToolCallViewProps["formatPath"] | undefined;
  resolveScreenshot?: ToolCallViewProps["resolveScreenshot"] | undefined;
  loadScreenshot?: ToolCallViewProps["loadScreenshot"] | undefined;
  onOpenExternal?: AgentContentProps["onOpenExternal"] | undefined;
  onCopy?: AgentContentProps["onCopy"] | undefined;
  /** Matching folded work opens so transcript search never points at hidden text. */
  searchQuery?: string | undefined;
  name?: string | undefined;
  harness?: string | undefined;
  approvals?: ReactNode;
}

function TurnViewImpl(props: TurnViewProps) {
  const { turn } = props;
  const user = shownUserBlocks(turn.user);
  // Keep collecting ACP chunks in the transcript, but deliver a persona's
  // reply atomically when the turn finishes. Interrupted replies remain readable.
  const pendingReply = props.quietActivity && turn.end === null && props.activity !== "interrupted";
  const visibleBlocks = pendingReply ? [] : turn.blocks;
  if (props.quietActivity) return <PersonaTurn {...props} blocks={visibleBlocks} />;
  const segments = foldRuns(visibleBlocks);
  const assistantCopy = visibleBlocks.map(blockCopyText).filter(Boolean).join("\n\n");
  return (
    <article className="agent-turn" data-origin={turn.origin} data-turn-id={turn.id} data-ended={turn.end ?? "running"}>
      {user.length > 0 && <Message blocks={user} {...props} />}
      {(segments.length > 0 || turn.end !== "end_turn" || props.approvals) && (
        <section className="agent-assistant" aria-label="Assistant message">
          <div className="agent-message-author-row">
            <span className={`agent-harness-icon${props.harness ? ` agent-${props.harness}` : ""}`}
              role="img" aria-label={props.name ?? "Assistant"} title={props.name ?? "Assistant"}>
              <Robot size={14} aria-hidden="true" />
            </span>
            {assistantCopy !== "" && <MessageCopy role="assistant" text={assistantCopy} onCopy={props.onCopy} />}
          </div>
          <div className="agent-assistant-body">
            {segments.map((segment, index) => (
              <SegmentView key={index} segment={segment} {...props} />
            ))}
            {props.approvals}
            {props.activity === "live" && turn.end === null && (
              props.quietActivity && !props.approvals ? <PersonaTyping /> :
              <div className="agent-turn-streaming" role="status">
                {!props.approvals && <SpinnerGap className="agent-turn-spinner" size={13} aria-hidden="true" />}
                <span>{props.approvals ? "Waiting for you" : "Working…"}</span>
              </div>
            )}
            <TurnState turn={turn} />
          </div>
        </section>
      )}
    </article>
  );
}

export const TurnView = memo(TurnViewImpl);

/**
 * A persona turn's segments. While its reply is pending only its activity
 * (thoughts and tool calls) shows; the reply itself arrives whole.
 */
function personaSegments(turn: Turn, pending: boolean): Segment[] {
  return foldRuns(turn.blocks.filter((block) => !pending || block.kind === "thought" || block.kind === "tool"));
}

function PersonaTurn(props: TurnViewProps & { blocks: Block[] }) {
  const { turn } = props;
  const pending = turn.end === null && props.activity !== "interrupted";
  const segments = personaSegments(turn, pending);
  const user = shownUserBlocks(turn.user);
  const typing = props.activity === "live" && turn.end === null && !props.approvals;
  return <article className="agent-turn" data-origin={turn.origin} data-turn-id={turn.id}
    data-ended={turn.end ?? "running"}>
    {user.length > 0 && <Message {...props} blocks={user} />}
    {segments.map((segment, index) => {
      if (segment.kind === "activity") return <ul className="persona-events" key={index}>
        {segment.blocks.map((block, blockIndex) => block.kind === "thought" || block.kind === "tool"
          ? <ActionEventItem key={block.kind === "tool" ? block.call.toolCallId : blockIndex} block={block}
            pending={pending} activity={props.activity} />
          : null)}
      </ul>;
      const copy = segment.kind === "text" ? segment.text : "";
      return <section className="agent-assistant" aria-label="Assistant message" key={index}>
        <div className="agent-assistant-body"><SegmentView {...props} segment={segment} /></div>
        {copy && <div className="persona-message-actions">
          <MessageCopy role="assistant" text={copy} onCopy={props.onCopy} />
        </div>}
      </section>;
    })}
    {props.approvals}
    {typing && <section className="agent-assistant" aria-label="Assistant typing">
      <PersonaTyping />
    </section>}
    <TurnState turn={turn} />
  </article>;
}

/** A thought or tool block: a status icon and the tool's name. */
function ActionEventItem({ block, pending, activity }: {
  block: Extract<Block, { kind: "thought" | "tool" }>; pending: boolean; activity: TurnActivity;
}) {
  const status = block.kind === "tool" ? toolPresentationStatus(block.call.status, activity)
    : pending && activity === "live" ? "in_progress" : "completed";
  const running = status === "in_progress" || status === "pending";
  const thought = running ? "Thinking…" : "Thought through the next steps";
  const label = block.kind === "thought" ? thought
    : block.call.title.replace(/^mcp__personas__/, "").replace(/_/g, " ");
  return <li className="persona-event persona-action-event" data-status={status}>
    <span className="persona-event-icon" role="img" aria-label={status} title={status}>
      {status === "failed" ? <Warning size={12} aria-hidden="true" />
        : status === "completed" ? <Check size={12} aria-hidden="true" />
          : <Circle size={12} aria-hidden="true" />}
    </span>
    <span className="persona-event-label" title={label}>{label}</span>
  </li>;
}

function Message(props: TurnViewProps & { blocks: ContentBlock[] }) {
  if (props.turn.origin === "report") return <PersonaReportLines blocks={props.blocks} />;
  return (
    <section className="agent-user" aria-label="User message">
      <div className="agent-user-body">
        {props.blocks.map((content, index) => (
          <AgentContent
            key={index}
            content={content}
            onOpenExternal={props.onOpenExternal}
            onOpenPath={props.onOpenPath ? (path) => props.onOpenPath?.(path) : undefined}
            onCopy={props.onCopy}
          />
        ))}
      </div>
    </section>
  );
}

function contentCopyText(content: ContentBlock): string {
  const record = typeof content === "object" && content !== null
    ? content as unknown as Record<string, unknown>
    : null;
  if (record?.type === "text" && typeof record.text === "string") return record.text;
  if (record?.type === "resource_link" && typeof record.uri === "string") {
    const label = typeof record.title === "string"
      ? record.title
      : typeof record.name === "string" ? record.name : record.uri;
    return `[${label}](${record.uri})`;
  }
  if (record?.type === "resource" && typeof record.resource === "object" && record.resource !== null) {
    const resource = record.resource as Record<string, unknown>;
    if (typeof resource.text === "string") return resource.text;
    if (typeof resource.uri === "string") return `[Resource: ${resource.uri}]`;
  }
  if (record?.type === "image") return "[Image]";
  if (record?.type === "audio") return "[Audio]";
  return `[Unsupported content${typeof record?.type === "string" ? `: ${record.type}` : ""}]`;
}

function blockCopyText(block: Block): string {
  if (block.kind === "text" || block.kind === "thought") return block.text;
  if (block.kind === "content") return contentCopyText(block.content);
  if (block.kind === "plan") return block.entries.map((entry) => `- [${entry.status === "completed" ? "x" : " "}] ${entry.content}`).join("\n");
  return "";
}

function MessageCopy(props: { role: "user" | "assistant"; text: string; onCopy?: AgentContentProps["onCopy"] }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      if (props.onCopy) await props.onCopy(props.text);
      else await navigator.clipboard.writeText(props.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      className={`agent-message-copy agent-message-copy-${props.role}`}
      aria-label={`Copy ${props.role} message`}
      title={copied ? "Copied" : "Copy message"}
      onClick={() => void copy()}
    >
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
  );
}

function SegmentView(props: TurnViewProps & { segment: Segment }) {
  const { segment } = props;
  if (segment.kind === "text") {
    return (
      <AgentContent
        content={{ type: "text", text: segment.text }}
        onOpenExternal={props.onOpenExternal}
        onOpenPath={props.onOpenPath ? (path) => props.onOpenPath?.(path) : undefined}
        onCopy={props.onCopy}
      />
    );
  }
  if (segment.kind === "content") {
    return (
      <AgentContent
        content={segment.content}
        onOpenExternal={props.onOpenExternal}
        onOpenPath={props.onOpenPath ? (path) => props.onOpenPath?.(path) : undefined}
        onCopy={props.onCopy}
      />
    );
  }
  if (segment.kind === "plan") return <PlanView entries={segment.entries} live={props.activity === "live"} />;
  const { segment: _segment, ...turnProps } = props;
  return <ActivityView {...turnProps} segment={segment} />;
}

function blockText(block: Block): string {
  if (block.kind === "thought" || block.kind === "text") return block.text;
  if (block.kind === "content") return block.content.type === "text" ? block.content.text : "";
  if (block.kind === "plan") return block.entries.map((entry) => entry.content).join("\n");
  return searchableToolText(block.call);
}

function ActivityView(props: TurnViewProps & { segment: Extract<Segment, { kind: "activity" }> }) {
  const [opened, setOpened] = useState(false);
  const detailId = useId();
  const query = props.searchQuery?.trim().toLocaleLowerCase() ?? "";
  const searchMatch = query !== "" && props.segment.blocks.some((block) => blockText(block).toLocaleLowerCase().includes(query));
  const open = opened || searchMatch;
  const active = props.activity === "live" ? props.segment.running : 0;
  const unfinished = props.activity === "live" ? 0 : props.segment.running;
  const state = props.segment.failed > 0 ? "failed" : active > 0 ? "running" : unfinished > 0 ? props.activity : "complete";
  const runningTool = [...props.segment.blocks].reverse().find(block => block.kind === "tool" && (block.call.status === "in_progress" || block.call.status === "pending"));
  const label = props.quietActivity && props.activity === "live" && props.turn.end === null
    ? runningTool?.kind === "tool" ? runningTool.call.title : "Thinking…"
    : props.segment.summary;
  return (
    <div className="agent-activity" data-status={state}>
      <button
        type="button"
        className="agent-activity-summary"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpened((current) => !current)}
      >
        {open ? <CaretDown size={12} aria-hidden="true" /> : <CaretRight size={12} aria-hidden="true" />}
        {state === "running" && !props.quietActivity && <SpinnerGap className="agent-activity-spinner" size={13} aria-hidden="true" />}
        {state === "failed" && <Warning size={13} aria-hidden="true" />}
        <span className="agent-activity-label">{label}</span>
        {active > 0 && <span className="agent-activity-count">{active} active</span>}
        {unfinished > 0 && <span className="agent-activity-count">{unfinished} {props.activity}</span>}
        {props.segment.failed > 0 && <span className="agent-activity-count agent-activity-failed">{props.segment.failed} failed</span>}
      </button>
      {open && (
        <div id={detailId} className="agent-activity-detail">
          {props.segment.blocks.map((block, index) => {
            if (block.kind === "thought") {
              return (
                <details key={index} className="agent-thought" open={searchMatch || undefined}>
                  <summary className="agent-thought-summary">Reasoning</summary>
                  <AgentContent
                    className="agent-thought-content"
                    content={{ type: "text", text: block.text }}
                    onOpenExternal={props.onOpenExternal}
                    onCopy={props.onCopy}
                  />
                </details>
              );
            }
            if (block.kind === "tool") {
              return (
                <ToolCallView
                  key={index}
                  call={block.call}
                  status={toolPresentationStatus(block.call.status, props.activity)}
                  onOpenPath={props.onOpenPath}
                  formatPath={props.formatPath}
                  onOpenExternal={props.onOpenExternal}
                  onCopy={props.onCopy}
                  searchQuery={props.searchQuery}
                  resolveScreenshot={props.resolveScreenshot}
                  loadScreenshot={props.loadScreenshot}
                />
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

function PlanView({ entries, live }: { entries: PlanEntry[]; live: boolean }) {
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const progress = entries.length === 0 ? 0 : Math.round((completed / entries.length) * 100);
  return (
    <section className="agent-plan" aria-label={`Plan: ${completed} of ${entries.length} complete`}>
      <div className="agent-plan-head">
        <span className="agent-plan-title">Plan</span>
        <span className="agent-plan-progress-label">{completed}/{entries.length}</span>
      </div>
      <div className="agent-plan-progress" role="progressbar" aria-label="Plan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span className="agent-plan-progress-value" style={{ width: `${progress}%` }} />
      </div>
      <ul className="agent-plan-list">
        {entries.map((entry, index) => (
          <li key={index} className="agent-plan-entry" data-status={entry.status}>
            <span
              className={`agent-plan-mark agent-plan-mark-${entry.status.replace("in_progress", "running")}`}
              aria-hidden="true"
            >
              {entry.status === "completed"
                ? <Check size={13} weight="bold" />
                : entry.status === "in_progress" && live
                  ? <SpinnerGap className="agent-plan-spinner" size={13} />
                  : <Circle size={11} />}
            </span>
            <span className="agent-plan-text">{entry.content}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TurnState({ turn }: { turn: Turn }) {
  let message: string | null = null;
  let state = turn.end ?? "running";
  if (turn.end === "error") message = turn.error ?? "The agent stopped with an error.";
  else if (turn.end === "cancelled") message = turn.interrupted ? "Interrupted: Personas stopped during this turn." : "Stopped by user.";
  else if (turn.end === "refusal") message = "The agent declined this request.";
  else if (turn.end === "max_tokens") message = "Stopped after reaching the token limit.";
  else if (turn.end === "max_turn_requests") message = "Stopped after reaching the request limit.";
  if (message === null) return null;
  return (
    <div className="agent-turn-state" data-state={state} role={turn.end === "error" ? "alert" : "status"}>
      <Warning size={14} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

export default TurnView;
