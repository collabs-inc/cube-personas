// Adapted from cube-computer: src/windows/app/src/items/agent/PermissionCard.tsx
import { ShieldCheck, Warning } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { PermissionOption, PermissionOptionKind } from "@agentclientprotocol/sdk";
import type { PendingPermission } from "./transcript";
import { ToolCallContentView } from "./ToolCallView";
import "./AgentTranscript.css";

export interface PermissionCardProps {
  pending: PendingPermission;
  /** `null` dismisses; an id selects that option. */
  onChoose: (optionId: string | null) => void | Promise<void>;
  disabled?: boolean | undefined;
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
  formatPath?: ((path: string) => string) | undefined;
}

function isPrimary(option: PermissionOption): boolean {
  return option.kind === "allow_once" || option.kind === "allow_always";
}

function titleOf(pending: PendingPermission): string {
  const title = pending.toolCall.title;
  return typeof title === "string" && title !== "" ? title : "Permission needed";
}

const KIND_SCOPE: Record<PermissionOptionKind, string> = {
  allow_once: "once",
  allow_always: "always",
  reject_once: "this time",
  reject_always: "always",
};

function optionLabel(option: PermissionOption): string {
  const scope = KIND_SCOPE[option.kind];
  return option.name.toLowerCase().includes(scope) ? option.name : `${option.name} ${scope}`;
}

function scopeExplanation(options: PermissionOption[]): string {
  const kinds = new Set(options.map((option) => option.kind));
  const parts: string[] = [];
  if (kinds.has("allow_once")) parts.push("Allow once applies only to this request.");
  if (kinds.has("allow_always")) parts.push("Allow always also approves future matching requests.");
  if (kinds.has("reject_once")) parts.push("Deny once blocks only this request.");
  if (kinds.has("reject_always")) parts.push("Deny always also blocks future matching requests.");
  return parts.join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The response could not be sent. Try again.";
}

function rawInputOf(pending: PendingPermission): string | null {
  if (pending.toolCall.rawInput === undefined) return null;
  try {
    const text = typeof pending.toolCall.rawInput === "string"
      ? pending.toolCall.rawInput
      : JSON.stringify(pending.toolCall.rawInput, null, 2);
    if (!text) return null;
    return text.length > 4_000 ? `${text.slice(0, 4_000)}\n… truncated` : text;
  } catch {
    return String(pending.toolCall.rawInput);
  }
}

export function PermissionCard(props: PermissionCardProps) {
  const { pending, onChoose, disabled = false } = props;
  const [answeredId, setAnsweredId] = useState<PendingPermission["requestId"] | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const answered = answeredId === pending.requestId;
  const locked = disabled || answered;
  const rawInput = rawInputOf(pending);

  useEffect(() => {
    setSendError(null);
  }, [pending.requestId]);

  const choose = (optionId: string | null): void => {
    if (locked) return;
    setAnsweredId(pending.requestId);
    setSendError(null);
    let response: void | Promise<void>;
    try {
      response = onChoose(optionId);
    } catch (error) {
      setAnsweredId(null);
      setSendError(errorMessage(error));
      return;
    }
    if (response && typeof response.then === "function") {
      void response.catch((error: unknown) => {
        setAnsweredId((current) => current === pending.requestId ? null : current);
        setSendError(errorMessage(error));
      });
    }
  };

  return (
    <section className="agent-permission" role="group" aria-label="Permission request">
      <div className="agent-permission-heading">
        <span className="agent-permission-icon"><ShieldCheck size={17} aria-hidden="true" /></span>
        <div className="agent-permission-heading-copy">
          <div className="agent-permission-eyebrow">Approval needed</div>
          <div className="agent-permission-title">{titleOf(pending)}</div>
        </div>
      </div>
      {pending.toolCall.locations && pending.toolCall.locations.length > 0 && (
        <div className="agent-permission-locations">
          {pending.toolCall.locations.map((location, index) => {
            const label = `${props.formatPath?.(location.path) ?? location.path}${location.line ? `:${location.line}` : ""}`;
            return props.onOpenPath ? (
              <button
                key={`${location.path}:${location.line ?? ""}:${index}`}
                type="button"
                className="agent-permission-location"
                onClick={() => props.onOpenPath?.(location.path, location.line ?? undefined)}
              >
                {label}
              </button>
            ) : <code key={`${location.path}:${location.line ?? ""}:${index}`} className="agent-permission-location-static">{label}</code>;
          })}
        </div>
      )}
      {rawInput && (
        <details className="agent-permission-details">
          <summary className="agent-permission-details-summary">Review request details</summary>
          <pre className="agent-permission-details-value">{rawInput}</pre>
        </details>
      )}
      {pending.toolCall.content && pending.toolCall.content.length > 0 && (
        <div className="agent-permission-content" aria-label="Request context">
          {pending.toolCall.content.map((content, index) => (
            <ToolCallContentView
              key={index}
              content={content}
              onOpenPath={props.onOpenPath}
              formatPath={props.formatPath}
            />
          ))}
        </div>
      )}
      <p className="agent-permission-scope">{scopeExplanation(pending.options)}</p>
      <div className="agent-permission-options">
        {pending.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={isPrimary(option) ? "agent-permission-allow" : "agent-permission-reject"}
            data-kind={option.kind}
            aria-label={optionLabel(option)}
            disabled={locked}
            onClick={() => choose(option.optionId)}
          >
            {option.name}
          </button>
        ))}
        <button
          type="button"
          className="agent-permission-cancel"
          disabled={locked}
          onClick={() => choose(null)}
        >
          Cancel
        </button>
      </div>
      {answered && <div className="agent-permission-sent" role="status">Sent — waiting for the agent…</div>}
      {sendError && (
        <div className="agent-permission-error" role="alert">
          <Warning size={14} aria-hidden="true" />
          <span>{sendError}</span>
        </div>
      )}
    </section>
  );
}

export default PermissionCard;
