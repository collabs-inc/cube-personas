// Adapted from cube-computer: src/windows/app/src/items/agent/AgentItem.tsx
/**
 * One persona's conversation, as the page shows it.
 *
 * The stream is the server's and the model is `transcript-store`'s; this
 * component owns exactly three things — when to read, what the user's
 * gestures put on the wire, and where the column is scrolled to. It is Cube's
 * `AgentItem` for a persona, cut loose from Cube's catalog, machines and
 * attach scheduler:
 *
 *  - READ: `persona:open` from the cursor this page already holds, on mount
 *    and again on every reconnect (frames sent while the socket was down
 *    never reached this page). `beginOpen` makes a reconnect racing an open
 *    safe, and `abortOpen` in the `catch` is mandatory — see
 *    transcript-store's own doc comment for what a missing one costs.
 *  - STATE: the server's `persona:state` is the truth about whether a prompt
 *    can be admitted. While it is not `ready`, the composer queues (Cube's
 *    prompt queue) instead of sending; the queue drains when it is. A send
 *    the server refuses as busy (`BUSY_MARKER`) was a race lost against a
 *    worker report: the message joins the queue rather than failing.
 *  - The persona's own record log holds every launch, so a restart is the
 *    same conversation continuing — unlike Cube's respawn, nothing resets.
 *
 * Dropped from Cube: agent sign-in, the attach scheduler, machine status,
 * persona events and decisions, file mentions and opening files in panes.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { ArrowDown, ListPlus, PencilSimple, Play, X } from "@phosphor-icons/react";
import { BUSY_MARKER, MESSAGE_TOO_LARGE_PREFIX, type JsonRpcMessage } from "../../shared/agent-protocol";
import { getApi, type Api, type ApiStatus } from "../api";
import { setPersonaStatus, usePersona, usePersonaStatus } from "../stores/personas";
import { useTheme } from "../use-theme";
import { LoadingPulse } from "./LoadingPulse";
import { Composer } from "./Composer";
import { restoreComposerDraft } from "./composer-state";
import { SessionControls } from "./SessionControls";
import { ConversationToolbar } from "./ConversationToolbar";
import { LivePersonaWorkersStatus } from "./PersonaWorkersStatus";
import { promptLabel, searchTurns, transcriptMarkdown } from "./conversation-logic";
import { promptQueueFor, usePromptQueue } from "./prompt-queue";
import { PermissionCard } from "./PermissionCard";
import { TurnView } from "./TurnView";
import { AgentContent } from "./AgentContent";
import { shouldStickToBottom } from "./agent-item-logic";
import {
  abortOpen,
  applyFrame,
  applyOpen,
  beginOpen,
  getTranscript,
  nextRequestId,
  useTranscript,
} from "./transcript-store";
import { cancelNotification, permissionResponse, promptRequest } from "./transcript";
import { turnActivity } from "./activity-state";
import "./AgentItem.css";
import "./Conversation.css";

const HARNESS_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

/** What a banner says about a failure: the server's own sentence, less any marker. */
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const at = message.indexOf(MESSAGE_TOO_LARGE_PREFIX);
  return at === -1 ? message : message.slice(at + MESSAGE_TOO_LARGE_PREFIX.length);
}

/** The server would not admit a prompt now; it will when the persona is ready. */
function isBusyError(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).startsWith(BUSY_MARKER);
}

function useApiStatus(api: Api): ApiStatus {
  return useSyncExternalStore(api.onStatus, api.status);
}

const NARROW_QUERY = "(max-width: 699px)";

/** Below 700px the composer behaves as on a phone: Enter is a newline, the arrow sends. */
function useIsNarrow(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    if (typeof window.matchMedia !== "function") return () => {};
    const media = window.matchMedia(NARROW_QUERY);
    media.addEventListener("change", cb);
    return () => media.removeEventListener("change", cb);
  }, []);
  return useSyncExternalStore(subscribe, () =>
    typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches);
}

const noSettingChange = (): Promise<void> => Promise.reject(new Error("Personas cannot change this setting."));

/** `onOpenPath` opens a file path the conversation links to; without it, paths are plain text. */
export function Conversation({ personaId, onOpenPath }: { personaId: string; onOpenPath?: (path: string) => void }) {
  useTheme();
  const api = getApi();
  const connection = useApiStatus(api);
  const connected = connection === "open";
  const persona = usePersona(personaId);
  const personaStatus = usePersonaStatus(personaId);
  const state = personaStatus?.state ?? persona?.state ?? "starting";
  const transcript = useTranscript(personaId);
  const narrow = useIsNarrow();
  const dropSurfaceRef = useRef<HTMLDivElement>(null);
  const draftKey = `persona:${personaId}`;

  // A failure the USER caused and can retry: a send that did not land, a
  // restart that was refused. Never a read failure, which has its own row.
  const [actionError, setActionError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const queue = promptQueueFor(personaId);
  const queued = usePromptQueue(personaId);

  const columnRef = useRef<HTMLDivElement>(null);
  // Whether new output should keep following the reader down. Starts true:
  // a freshly opened conversation opens at its end.
  const stickRef = useRef(true);
  const lastScrollTop = useRef(0);

  const stopped = state === "stopped" || state === "failed";
  const sessionReady = state === "ready" || state === "busy";
  const running = !stopped && (transcript.running || state === "busy");
  const starting = state === "starting" && transcript.turns.length === 0 && transcript.pending.length === 0
    && transcript.handshakeError === null && transcript.authRequired === null && attachError === null;

  // Focus the composer once it mounts (after the starting surface).
  useEffect(() => {
    if (!starting) dropSurfaceRef.current?.querySelector<HTMLTextAreaElement>(".agent-composer-input")?.focus({ preventScroll: true });
  }, [starting]);

  /**
   * Re-reads the conversation from the cursor this page holds to the log's
   * end. Shared by the first read and every reconnect — they differ only in
   * what the cursor already is.
   */
  const openConversation = useCallback(async (): Promise<void> => {
    const token = beginOpen(personaId);
    try {
      const held = getTranscript(personaId).seq;
      let result = await api.request("persona:open", { id: personaId, ...(held > 0 ? { sinceSeq: held } : {}) });
      // The server's log ends before this page's cursor: it was lost or
      // restored under the page. Read it again from the start, as a replacement.
      if (held > 0 && result.seq < held) result = await api.request("persona:open", { id: personaId });
      applyOpen(personaId, {
        sessionId: personaId,
        seq: result.seq,
        // The records follow on from this page's cursor, or replace what it
        // holds: the server sends only its log's trailing window, so a page
        // whose cursor is older than that (or past the log's end) starts over.
        reset: result.startSeq !== held,
        records: result.records,
        activePrompt: result.activePrompt === null ? null : { id: result.activePrompt },
      }, token);
      setPersonaStatus(personaId, { state: result.state, activePrompt: result.activePrompt });
      setAttachError(null);
    } catch (err) {
      // MANDATORY: without it the store buffers every later frame for this
      // persona for the life of the page.
      abortOpen(personaId, token);
      setAttachError(errorText(err));
    }
  }, [api, personaId]);

  useEffect(() => {
    const offFrame = api.on("persona:frame", ({ id, record }) => {
      if (id === personaId) applyFrame(personaId, record);
    });
    const offReconnect = api.onReconnect(() => { void openConversation(); });
    void openConversation();
    return () => { offFrame(); offReconnect(); };
  }, [api, personaId, openConversation]);

  // Follows the conversation down while the reader is at the bottom of it.
  // Layout, not passive: the scroll has to land in the same frame the new
  // content is painted in, or the column visibly jumps.
  useLayoutEffect(() => {
    const column = columnRef.current;
    if (!column || !stickRef.current) return;
    column.scrollTop = column.scrollHeight;
    lastScrollTop.current = column.scrollTop;
  }, [transcript]);

  // Images and expanded tool output can resize after a stream frame. Keep
  // following only if the reader has not deliberately scrolled away.
  useEffect(() => {
    const column = columnRef.current;
    const content = column?.firstElementChild;
    if (!column || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) { column.scrollTop = column.scrollHeight; lastScrollTop.current = column.scrollTop; }
    });
    observer.observe(content, { box: "border-box" });
    // Queue rows, errors and the composer can change the viewport without
    // changing the response. Keep its approval/status visible when pinned.
    observer.observe(column, { box: "border-box" });
    return () => observer.disconnect();
  }, [starting]);

  /** Puts one message on the wire; rejects with the server's error, untouched. */
  const send = useCallback(async (message: JsonRpcMessage): Promise<void> => {
    await api.request("persona:send", { id: personaId, message });
    setActionError(null);
  }, [api, personaId]);

  /** `send`, recording a failure for the banner before passing it on. */
  const sendReported = useCallback(async (message: JsonRpcMessage): Promise<void> => {
    try {
      await send(message);
    } catch (err) {
      setActionError(errorText(err));
      throw err;
    }
  }, [send]);

  // The server overwrites a prompt's sessionId with its own, so before the
  // handshake records arrive any string will do.
  const acpSessionId = transcript.acpSessionId ?? persona?.acpSessionId ?? "";
  const turns = transcript.turns;
  const openTurnId = turns.at(-1)?.end === null ? turns.at(-1)!.id : undefined;

  /** The server said busy, so it is: hold the queue until it says ready. */
  const markBusy = useCallback((): void => {
    setPersonaStatus(personaId, { state: "busy", activePrompt: personaStatus?.activePrompt ?? null });
  }, [personaId, personaStatus?.activePrompt]);

  useEffect(() => {
    queue.observe(turns, !stopped && connected);
    if (stopped) queue.interrupt("The persona stopped. Restart it before sending queued messages.");
  }, [queue, turns, stopped, connected]);

  // Drain the queue, one message at a time, whenever the persona is ready.
  useEffect(() => {
    if (state !== "ready" || transcript.pending.length || !connected) return;
    if (!queued.entries.length || queued.pausedReason || queued.awaitingTurnId || queued.sendingId) return;
    const requestId = nextRequestId(personaId);
    const entry = queue.claim(requestId);
    if (!entry) return;
    void send(promptRequest(requestId, acpSessionId, entry.blocks)).then(
      () => queue.accepted(),
      (error: unknown) => {
        if (isBusyError(error)) { markBusy(); queue.release(); return; }
        setActionError(errorText(error));
        queue.failed(errorText(error));
      },
    );
  }, [queue, queued, state, transcript.pending.length, connected, acpSessionId, personaId, send, markBusy]);

  const enqueue = useCallback((blocks: ContentBlock[]): void => {
    try { queue.add(blocks, openTurnId); setActionError(null); }
    catch (error) { setActionError(errorText(error)); throw error; }
  }, [queue, openTurnId]);

  // Returns the promise rather than voiding it: the composer clears its
  // draft on resolve and keeps it on reject. A busy refusal resolves — the
  // message now waits in the queue.
  const onSend = useCallback(async (blocks: ContentBlock[]): Promise<void> => {
    if (state !== "ready") { enqueue(blocks); return; }
    try {
      await send(promptRequest(nextRequestId(personaId), acpSessionId, blocks));
    } catch (err) {
      if (!isBusyError(err)) { setActionError(errorText(err)); throw err; }
      markBusy();
      enqueue(blocks);
    }
  }, [state, enqueue, send, personaId, acpSessionId, markBusy]);

  // Carries no draft, and its failure is already on the banner: the
  // rejection is swallowed rather than left unhandled.
  const onStop = useCallback((): void => {
    queue.pause("Stopped by you. Review the queue before continuing.");
    void sendReported(cancelNotification(acpSessionId)).catch(() => {});
  }, [acpSessionId, sendReported, queue]);

  const onRestart = useCallback((): void => {
    setRestarting(true);
    setActionError(null);
    api.request("persona:restart", { id: personaId })
      .catch((err: unknown) => setActionError(errorText(err)))
      .finally(() => setRestarting(false));
  }, [api, personaId]);

  const harness = persona?.harness ?? "the agent";
  const harnessName = HARNESS_NAMES[harness] ?? harness;
  const name = persona?.name ?? "Persona";
  const empty = turns.length === 0 && transcript.handshakeError === null && transcript.pending.length === 0;
  const matches = useMemo(() => searchTurns(turns, query), [turns, query]);
  const currentMatch = matches.length ? matchIndex % matches.length : 0;
  const jumpLatest = (): void => {
    stickRef.current = true; setAwayFromBottom(false);
    const column = columnRef.current;
    if (column) { column.scrollTop = column.scrollHeight; lastScrollTop.current = column.scrollTop; }
  };
  const navigateMatch = (direction: number): void => {
    if (!matches.length) return;
    setMatchIndex((current) => (current + direction + matches.length) % matches.length);
  };
  useEffect(() => {
    if (!searchOpen || !matches.length) return;
    stickRef.current = false;
    setAwayFromBottom(true);
    const found = Array.from(columnRef.current?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? []).find((element) => element.dataset.turnId === matches[currentMatch]);
    found?.scrollIntoView?.({ block: "center", behavior: "auto" });
  }, [searchOpen, matches, currentMatch]);
  const title = transcript.sessionInfo.title ?? name;
  const approvals = transcript.pending.length > 0 ? <div className="agent-pending-permissions">
    {transcript.pending.map((pending) => <PermissionCard key={JSON.stringify(pending.requestId)} pending={pending} disabled={stopped || !connected}
      onChoose={(optionId) => sendReported(permissionResponse(pending.requestId, optionId))} />)}
  </div> : undefined;
  const exportConversation = (): void => {
    const url = URL.createObjectURL(new Blob([transcriptMarkdown(turns, title)], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${title.replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 80) || "conversation"}.md`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Keep the loading surface through spawn and ACP initialization. Existing
  // history and actionable startup failures remain visible.
  if (starting) {
    return <LoadingPulse className="agent-item-loading" label={`Starting ${harnessName}`} />;
  }

  const offline = connection === "closed";
  return (
    <div ref={dropSurfaceRef} className="agent-item persona-conversation" onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing && !event.defaultPrevented && !stopped && connected && running) {
        event.preventDefault(); event.stopPropagation(); onStop();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); event.stopPropagation(); setSearchOpen(true); }
    }}>
      <ConversationToolbar name={harnessName} harness={harness} title={title}
        status={stopped ? (state === "failed" ? "Failed" : "Stopped") : offline ? "Offline" : !connected ? "Connecting…" : transcript.pending.length ? "Needs your input" : running ? "Working" : sessionReady ? "Ready" : "Starting…"}
        state={stopped || offline ? "offline" : transcript.pending.length ? "waiting" : running ? "running" : "idle"}
        query={query} searchOpen={searchOpen} matches={matches.length} matchIndex={currentMatch}
        onSearch={(value) => { setQuery(value); setMatchIndex(0); }} onToggleSearch={() => setSearchOpen((open) => !open)} onNavigate={navigateMatch}
        onCopy={() => navigator.clipboard.writeText(transcriptMarkdown(turns, title))} onExport={exportConversation} />
      <div
        ref={columnRef}
        className="agent-transcript"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = shouldStickToBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
          // Layout growth can deliver a scroll event before ResizeObserver.
          // Only movement toward earlier messages relinquishes following;
          // a delayed programmatic scroll must not unpin the reader.
          if (atBottom || el.scrollTop < lastScrollTop.current) stickRef.current = atBottom;
          lastScrollTop.current = el.scrollTop;
          setAwayFromBottom(!stickRef.current);
        }}
      >
        <div className="agent-transcript-content">
        {empty && <div className="persona-welcome">
          <h2 className="persona-welcome-name">{name}</h2>
          <p className="persona-welcome-note">What’s on your mind?</p>
        </div>}
        {turns.map((turn) => (
          <Fragment key={turn.id}>
            <div className="agent-turn-anchor" data-turn-id={turn.id}
              data-search-match={searchOpen && matches[currentMatch] === turn.id || undefined}>
              <TurnView turn={turn} quietActivity
                name={harnessName} harness={harness} onOpenPath={onOpenPath}
                searchQuery={searchOpen ? query : ""}
                activity={turnActivity(turn, {
                  current: turn === turns.at(-1) && (transcript.running || transcript.pending.length > 0),
                  connected, stopped,
                })}
                approvals={turn === turns.at(-1) ? approvals : undefined} />
            </div>
          </Fragment>
        ))}
        <LivePersonaWorkersStatus personaId={personaId} />
        {turns.length === 0 && approvals && <TurnView quietActivity
          turn={{ id: "pending-approval", user: [], blocks: [], end: null }}
          activity={stopped ? "interrupted" : connected ? "live" : "unconfirmed"}
          name={harnessName} harness={harness} approvals={approvals} />}
        {transcript.compaction.map((compaction) => <div className="agent-compaction" key={compaction.compactionId} role="status">
          {compaction.status === "in_progress" ? "Compacting conversation…" : compaction.status === "completed" ? "Conversation compacted" : `Compaction ${compaction.status}`}
          {compaction.error && <div className="agent-action-error">{compaction.error}</div>}
          {compaction.summary.length > 0 && <details className="agent-compaction-summary"><summary>View summary</summary>
            {compaction.summary.map((content, index) => <AgentContent key={index} content={content} />)}
          </details>}
        </div>)}
        {transcript.authRequired ? (
          <div className="agent-error-card agent-auth-card" role="alert">
            <div className="agent-error-title">{harnessName} needs you to sign in</div>
            <div className="agent-error-message">Sign in to {harnessName} on this machine, then restart the persona.</div>
          </div>
        ) : transcript.handshakeError !== null && (
          <div className="agent-error-card" role="alert">
            <div className="agent-error-title">{harnessName} could not start</div>
            <div className="agent-error-message">{transcript.handshakeError}</div>
          </div>
        )}
        </div>
      </div>

      <div className="agent-footer">
        {awayFromBottom && <button type="button" className="agent-jump-latest" onClick={jumpLatest}><ArrowDown size={13} aria-hidden="true" />{approvals ? "Review request" : "Latest messages"}</button>}
        {attachError !== null && <div className="agent-action-error" role="alert"><span>{attachError}</span><button className="agent-text-button" type="button" onClick={() => { void openConversation(); }}>Reconnect</button></div>}
        {actionError !== null && (
          <div className="agent-action-error" role="alert"><span>{actionError}</span><button className="agent-icon-button" type="button" aria-label="Dismiss error" onClick={() => setActionError(null)}><X size={13} /></button></div>
        )}
        {queued.entries.length > 0 && <div className="agent-queue">
          <div className="agent-queue-header"><ListPlus size={14} aria-hidden="true" /><span>{queued.entries.length} queued {queued.entries.length === 1 ? "message" : "messages"}</span>
            {queued.pausedReason && <button className="agent-text-button" type="button" disabled={stopped || !connected || running} onClick={() => queue.resume()}><Play size={12} />Continue queue</button>}
          </div>
          {queued.pausedReason && <div className="agent-queue-paused" role="status">{queued.pausedReason}</div>}
          {queued.entries.map((entry) => <div className="agent-queue-entry" key={entry.id}>
            <span className="agent-queue-label">{promptLabel(entry.blocks)}</span>
            <button className="agent-icon-button" type="button" aria-label="Edit queued message" disabled={entry.id === queued.sendingId} onClick={() => { const removed = queue.remove(entry.id); if (removed) restoreComposerDraft(draftKey, removed.blocks); }}><PencilSimple size={13} /></button>
            <button className="agent-icon-button" type="button" aria-label="Remove queued message" disabled={entry.id === queued.sendingId} onClick={() => queue.remove(entry.id)}><X size={13} /></button>
          </div>)}
        </div>}
        {stopped && (
          <div className="agent-stopped">
            <div className="agent-stopped-row">
              <span className="agent-stopped-label">{state === "failed" ? persona?.failure ?? "The persona could not start." : "Persona stopped"}</span>
              <button type="button" className="agent-resume" disabled={restarting} onClick={onRestart}>
                {restarting ? "Restarting…" : "Restart"}
              </button>
            </div>
          </div>
        )}
        {/* Mounted even while the persona is stopped, disabled rather than
            removed: an adapter that dies mid-sentence must not take the
            half-written sentence with it. Restart brings the same draft
            back to a live session. */}
        <Composer
          compact
          key={draftKey}
          dropSurfaceRef={dropSurfaceRef}
          itemId={draftKey}
          usage={transcript.usage}
          disabled={stopped || !sessionReady || connection === "connecting"}
          running={running}
          modes={{ current: null, available: [] }}
          commands={transcript.commands}
          narrow={narrow}
          imageSupported={transcript.promptCapabilities?.image === true}
          onQueue={enqueue}
          onSend={onSend}
          onStop={onStop}
          onSetMode={() => {}}
          placeholder={stopped ? "Persona stopped — Restart to keep going" : sessionReady ? `Message ${name}…` : `Starting ${harnessName}…`}
        >{/* The server admits only prompts, cancels and permission answers
            from the page, so the session's settings are shown, not changed. */}
          <SessionControls transcript={transcript} disabled presentation="panel"
            emptyMessage="This agent hasn’t provided conversation settings for this session."
            onConfig={noSettingChange} onMode={noSettingChange} onModel={noSettingChange} /></Composer>
      </div>
    </div>
  );
}

export default Conversation;
