// Adapted from cube-computer: src/windows/app/src/items/agent/SessionControls.tsx
import { useState } from "react";
import { SlidersHorizontal, CaretDown } from "@phosphor-icons/react";
import type { Transcript } from "./transcript";
import type { SessionConfigOption } from "./session-controls";

export interface SessionControlsProps {
  presentation?: "inline" | "panel";
  emptyMessage?: string | undefined;
  transcript: Transcript;
  disabled: boolean;
  onConfig: (id: string, value: string | boolean) => Promise<void>;
  onMode: (id: string) => void | Promise<void>;
  onModel: (id: string) => void | Promise<void>;
}

function ConfigControl({ option, disabled, onChange, compact = false }: {
  option: SessionConfigOption; disabled: boolean; compact?: boolean;
  onChange: (id: string, value: string | boolean) => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (value: string | boolean): void => {
    setSending(true); setError(null);
    onChange(option.id, value).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Could not change setting.");
    }).finally(() => setSending(false));
  };
  return (
    <label className={compact ? "agent-setting-compact" : "agent-setting-row"} title={option.description ?? option.name}>
      {!compact && <span className="agent-setting-name">{option.name}</span>}
      {option.type === "boolean" ? (
        <input className="agent-setting-checkbox" type="checkbox" role="switch" aria-label={option.name}
          checked={option.currentValue} disabled={disabled || sending} onChange={(event) => change(event.currentTarget.checked)} />
      ) : (
        <span className="agent-setting-select-wrap">
          <select className="agent-setting-select" aria-label={option.name} value={option.currentValue}
            disabled={disabled || sending} onChange={(event) => change(event.currentTarget.value)}>
            {option.options.map((entry) => "group" in entry ? (
              <optgroup key={entry.group} label={entry.name}>
                {entry.options.map((choice) => <option key={choice.value} value={choice.value}>{choice.name}</option>)}
              </optgroup>
            ) : <option key={entry.value} value={entry.value}>{entry.name}</option>)}
          </select>
          <CaretDown className="agent-setting-chevron" size={10} aria-hidden="true" />
        </span>
      )}
      {!compact && option.description && <span className="agent-setting-description">{option.description}</span>}
      {error && <span className="agent-setting-error" role="alert">{error}</span>}
    </label>
  );
}

export function SessionControls({ transcript, disabled, onConfig, onMode, onModel, emptyMessage, presentation = "inline" }: SessionControlsProps) {
  const [legacySending, setLegacySending] = useState<string | null>(null);
  const changeLegacy = (kind: "mode" | "model", value: string): void => {
    setLegacySending(kind);
    void Promise.resolve().then(() => (kind === "mode" ? onMode : onModel)(value)).catch(() => {}).finally(() => setLegacySending(null));
  };
  const configs = transcript.configOptions;
  const inline = presentation === "panel" ? [] : configs.filter((option) => option.type === "select" && (option.category === "model" || option.category === "mode")).slice(0, 2);
  const extra = configs.filter((option) => !inline.includes(option));
  const pending = (id: string): boolean => transcript.controlRequests.some((request) => request.configId === id);
  return (
    <div className="agent-session-controls">
      {configs.length === 0 && transcript.models.available.length === 0 && transcript.modes.available.length <= 1
        && emptyMessage && <p className="agent-settings-empty" role="status">{emptyMessage}</p>}
      {inline.map((option) => <ConfigControl key={option.id} option={option} compact
        disabled={disabled || pending(option.id)} onChange={onConfig} />)}
      {configs.length === 0 && transcript.models.available.length > 0 && (
        <select className="agent-setting-select" aria-label="Model" value={transcript.models.current ?? ""} disabled={disabled || legacySending !== null || transcript.controlRequests.some((request) => request.method === "session/set_model")}
          onChange={(event) => changeLegacy("model", event.currentTarget.value)}>
          {transcript.models.available.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      )}
      {configs.length === 0 && transcript.modes.available.length > 1 && (
        <select className="agent-setting-select" aria-label="Mode" value={transcript.modes.current ?? ""} disabled={disabled || legacySending !== null || transcript.controlRequests.some((request) => request.method === "session/set_mode")}
          onChange={(event) => changeLegacy("mode", event.currentTarget.value)}>
          {transcript.modes.available.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
        </select>
      )}
      {extra.length > 0 && (presentation === "panel" ? <div className="agent-settings-list" role="group" aria-label="Session settings">
        {extra.map((option) => <ConfigControl key={option.id} option={option} disabled={disabled || pending(option.id)} onChange={onConfig} />)}
      </div> : (
        <details className="agent-settings">
          <summary className="agent-settings-trigger" aria-label="Agent settings" title="Agent settings">
            <SlidersHorizontal size={15} aria-hidden="true" />
          </summary>
          <div className="agent-settings-popover" role="group" aria-label="Session settings">
            <div className="agent-settings-heading">Session settings</div>
            <div className="agent-settings-caption">Applies to this conversation</div>
            {extra.map((option) => <ConfigControl key={option.id} option={option} disabled={disabled || pending(option.id)} onChange={onConfig} />)}
          </div>
        </details>
      ))}
    </div>
  );
}
