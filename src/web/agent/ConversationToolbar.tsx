// Adapted from cube-computer: src/windows/app/src/items/agent/ConversationToolbar.tsx
import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check, Copy, DotsThree, DownloadSimple, MagnifyingGlass, Robot, X } from "@phosphor-icons/react";
import { ConversationHeaderContext } from "./ConversationChrome";

export interface ConversationToolbarProps {
  name: string;
  title: string;
  harness: string;
  status: string;
  state: "idle" | "running" | "waiting" | "offline";
  query: string;
  searchOpen: boolean;
  matches: number;
  matchIndex: number;
  onSearch: (query: string) => void;
  onToggleSearch: () => void;
  onNavigate: (direction: number) => void;
  onCopy: () => Promise<void>;
  onExport: () => void;
}

export function ConversationToolbar(props: ConversationToolbarProps) {
  const header = useContext(ConversationHeaderContext);
  const headerHost = header?.host;
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, []);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copy = (): void => {
    props.onCopy().then(() => { setCopied(true); setCopyError(false); setTimeout(() => setCopied(false), 1600); }, () => setCopyError(true));
  };
  const toolbar = (
      <div className="agent-toolbar" onPointerDown={headerHost ? header?.onPointerDown : undefined}>
        <div className="agent-identity">
          <span className={`agent-harness-icon agent-${props.harness}`} role="img" aria-label={props.name} title={`${props.name} · ${props.status}`}>
            <Robot size={14} aria-hidden="true" />
            {props.state !== "idle" && <span className="agent-status-dot" data-state={props.state} aria-hidden="true" />}
          </span>
          <span className="agent-conversation-title" title={props.title}>{props.title}</span>
          <span className="agent-connection-label" role="status">{props.status === "Ready" ? "" : props.status}</span>
        </div>
        <div className="agent-toolbar-actions" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
          <button className="agent-icon-button" type="button" aria-label="Search conversation" data-tooltip="Search conversation" data-shortcut="CommandOrControl+F" aria-pressed={props.searchOpen} onClick={props.onToggleSearch}><MagnifyingGlass size={15} /></button>
          <details className="agent-more" ref={menuRef} onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
          }} onBlur={(event) => {
            if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
          }}>
            <summary className="agent-icon-button agent-more-trigger" aria-label="Conversation actions" title="Conversation actions"><DotsThree size={19} weight="bold" /></summary>
            <div className="agent-more-popover">
              <button className="agent-menu-action" type="button" aria-label="Copy conversation" onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />}<span>{copyError ? "Copy failed — retry" : copied ? "Copied" : "Copy conversation"}</span></button>
              <button className="agent-menu-action" type="button" aria-label="Export Markdown" onClick={() => { props.onExport(); if (menuRef.current) menuRef.current.open = false; }}><DownloadSimple size={15} /><span>Export Markdown</span></button>
            </div>
          </details>
        </div>
      </div>
  );
  return (
    <>
      {headerHost ? createPortal(toolbar, headerHost) : toolbar}
      {props.searchOpen && (
        <div className="agent-search" role="search">
          <MagnifyingGlass size={14} aria-hidden="true" />
          <input className="agent-search-input" aria-label="Find in conversation" placeholder="Find in conversation…" value={props.query}
            autoFocus onChange={(event) => props.onSearch(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); props.onToggleSearch(); } if (event.key === "Enter") { event.preventDefault(); props.onNavigate(event.shiftKey ? -1 : 1); } }} />
          <span className="agent-search-count" aria-live="polite">{props.query ? props.matches ? `${props.matchIndex + 1} / ${props.matches}` : "No matches" : ""}</span>
          <button className="agent-icon-button" type="button" aria-label="Previous match" data-tooltip="Previous match" data-shortcut="Shift+Enter" disabled={!props.matches} onClick={() => props.onNavigate(-1)}><ArrowUp size={13} /></button>
          <button className="agent-icon-button" type="button" aria-label="Next match" data-tooltip="Next match" data-shortcut="Enter" disabled={!props.matches} onClick={() => props.onNavigate(1)}><ArrowDown size={13} /></button>
          <button className="agent-icon-button" type="button" aria-label="Close search" data-tooltip="Close search" data-shortcut="Escape" onClick={props.onToggleSearch}><X size={13} /></button>
        </div>
      )}
    </>
  );
}
