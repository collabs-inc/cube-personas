// Adapted from cube-computer: src/windows/app/src/persona/PersonaView.tsx (column handle and workspace navigation) and src/windows/app/src/desktop/system/PersonasSurface.tsx (vertical persona list)
/**
 * A vertical persona list beside the selected conversation and workspace.
 * The workspace shows its collection or one picked item. Visited personas
 * and details stay mounted so navigation preserves drafts and live views.
 * All data and actions use this application's own server contract.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowLeft, Asterisk, CaretDown, DotsThree, OpenAiLogo, Plus, X } from "@phosphor-icons/react";
import type { Harness, Persona } from "../../shared/types";
import { getApi } from "../api";
import { Conversation } from "../agent/Conversation";
import { usePersonas, type PersonaStatus } from "../stores/personas";
import { useWorkers } from "../stores/workers";
import { PersonaAvatar } from "./PersonaAvatar";
import { readWeights, resizeColumns, saveWeights, type ColumnWeights } from "./geometry";
import { useWorkspaceTree, WorkspaceList, type Pick } from "./WorkspaceList";
import { PersonaDialog, ReposDialog } from "./ReposDialog";
import { ContextFolder } from "./ContextFolder";
import { WorkerTerminal } from "./WorkerTerminal";
import { ArtifactFrame } from "./ArtifactFrame";
import { FileView } from "./FileView";
import "./PersonaView.css";

const SELECTED_KEY = "personas:selected";

function readSelected(): string | null {
  try { return localStorage.getItem(SELECTED_KEY); } catch { return null; }
}

function saveSelected(id: string): void {
  try { localStorage.setItem(SELECTED_KEY, id); } catch { /* Storage can be unavailable. */ }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function personaName(persona: Persona): string {
  return persona.name || "Persona";
}

const HARNESS_NAMES: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };

function HarnessBadge({ harness }: { harness: Harness }) {
  return <span className={`persona-harness persona-harness-${harness}`} role="img" aria-label={HARNESS_NAMES[harness]}>
    {harness === "codex" ? <OpenAiLogo weight="bold" /> : <Asterisk weight="bold" />}
  </span>;
}

function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    (cb) => { document.addEventListener("visibilitychange", cb); return () => document.removeEventListener("visibilitychange", cb); },
    () => document.visibilityState !== "hidden",
  );
}

/** Which menu is open, and the button that opened it (it anchors and toggles the menu). */
interface OpenMenu { id: string; trigger: HTMLElement }

/**
 * A small menu under its trigger; a press anywhere else or Escape closes it.
 *
 * It is `position: fixed` at the trigger's rect and rendered outside the
 * switcher's scroller, so no scrolling ancestor can clip it. A
 * press on the trigger itself is left to the trigger's own click, which
 * toggles the menu shut rather than closing and reopening it.
 */
function Menu({ trigger, onClose, children, label }: { trigger: HTMLElement; onClose(): void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const rect = trigger.getBoundingClientRect();
  const [position, setPosition] = useState({ top: rect.bottom + 4, left: rect.left });
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const anchor = trigger.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const below = anchor.bottom + 4;
    const top = below + bounds.height <= window.innerHeight - 8 ? below : anchor.top - bounds.height - 4;
    setPosition({
      top: Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)),
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
    });
  }, [trigger]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || trigger.contains(target)) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    // Scrolling the list would leave a fixed menu behind its trigger.
    const scrolled = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", onClose);
    ref.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, trigger]);
  return <div ref={ref} className="persona-menu" role="menu" aria-label={label}
    style={{ position: "fixed", ...position, maxHeight: "calc(100dvh - 16px)", overflowY: "auto" }}>{children}</div>;
}

type Dialog =
  | { kind: "rename"; persona: Persona }
  | { kind: "delete"; persona: Persona }
  | { kind: "repos" };

/** The context folder named in Delete's question, before the server has said it. */
const fallbackContextFolder = (id: string): string => `~/.cube/personas/${id}`;

function RenameDialog({ persona, onClose }: { persona: Persona; onClose(): void }) {
  const api = getApi();
  const [name, setName] = useState(persona.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    api.request("persona:rename", { id: persona.id, name: trimmed }).then(onClose, (err: unknown) => setError(message(err)));
  };
  return <PersonaDialog title="Rename persona" onClose={onClose}>
    <input className="persona-dialog-input" aria-label="Name" value={name}
      onChange={(event) => { setName(event.target.value); setError(null); }}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }} />
    {error !== null && <p className="persona-dialog-error" role="alert">{error}</p>}
    <div className="persona-dialog-actions">
      <button type="button" className="persona-dialog-button" onClick={onClose}>Cancel</button>
      <button type="button" className="persona-dialog-button persona-dialog-primary" disabled={!name.trim()} onClick={save}>Save</button>
    </div>
  </PersonaDialog>;
}

function DeleteDialog({ persona, onClose }: { persona: Persona; onClose(): void }) {
  const api = getApi();
  const [folder, setFolder] = useState(fallbackContextFolder(persona.id));
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    let current = true;
    api.request("workspace:get", { personaId: persona.id }).then(
      (tree) => { if (current) setFolder(tree.contextFolder.path); },
      () => { /* the fallback names the same folder */ },
    );
    return () => { current = false; };
  }, [api, persona.id]);
  const confirm = (): void => {
    setDeleting(true);
    api.request("persona:delete", { id: persona.id }).then(onClose, (err: unknown) => { setDeleting(false); setError(message(err)); });
  };
  return <PersonaDialog title={`Delete ${personaName(persona)}`} onClose={onClose}>
    <p className="persona-dialog-note">Delete this persona? Its conversation and workers end. Its files stay in {folder}.</p>
    {error !== null && <p className="persona-dialog-error" role="alert">{error}</p>}
    <div className="persona-dialog-actions">
      <button type="button" className="persona-dialog-button" onClick={onClose}>Cancel</button>
      <button type="button" className="persona-dialog-button persona-dialog-danger" disabled={deleting} onClick={confirm}>Delete</button>
    </div>
  </PersonaDialog>;
}

function Switcher({ personas, status, shownId, visible, onSelect, onCreate, onDialog }: {
  personas: Persona[]; status: Record<string, PersonaStatus>; shownId: string | null; visible: boolean;
  onSelect(id: string): void; onCreate(harness: Harness): void; onDialog(dialog: Dialog): void;
}) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const toggle = (id: string, trigger: HTMLElement): void => setMenu(menu?.id === id ? null : { id, trigger });
  const menuPersona = menu && menu.id !== "new" ? personas.find((persona) => persona.id === menu.id) : undefined;
  // Only the list scrolls; menus are its siblings so they remain unclipped.
  return <nav className="persona-switcher" aria-label="Personas">
    <div className="persona-switcher-heading">Personas</div>
    <div className="persona-switch-strip">
      {personas.map((persona) => {
        const name = personaName(persona);
        const working = (status[persona.id]?.state ?? persona.state) === "busy";
        // The shown persona is being read: its ring would only flash until mark-read lands.
        const unread = persona.unread && !(persona.id === shownId && visible);
        return <div key={persona.id} className="persona-switch-group">
          <button type="button" className="persona-switch" aria-label={name} title={name} aria-pressed={persona.id === shownId}
            onClick={() => onSelect(persona.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              const trigger = event.currentTarget.parentElement?.querySelector<HTMLElement>(".persona-switch-menu");
              if (trigger) setMenu({ id: persona.id, trigger });
            }}>
            <PersonaAvatar seed={persona.id} working={working} unread={unread} badge={<HarnessBadge harness={persona.harness} />} />
            <span className="persona-switch-name">{name}</span>
          </button>
          <button type="button" className="persona-switch-menu" aria-label={`Actions for ${name}`} aria-haspopup="menu"
            aria-expanded={menu?.id === persona.id} onClick={(event) => toggle(persona.id, event.currentTarget)}>
            <DotsThree size={14} weight="bold" aria-hidden="true" />
          </button>
        </div>;
      })}
      <div className="persona-switch-group persona-new">
        <button type="button" className="persona-new-button" onClick={() => onCreate("claude")}><Plus size={13} aria-hidden="true" />New</button>
        <button type="button" className="persona-new-more" aria-label="More ways to create a persona" aria-haspopup="menu"
          aria-expanded={menu?.id === "new"} onClick={(event) => toggle("new", event.currentTarget)}>
          <CaretDown size={11} aria-hidden="true" />
        </button>
      </div>
    </div>
    {menuPersona && <Menu key={menuPersona.id} trigger={menu!.trigger} label={`Actions for ${personaName(menuPersona)}`} onClose={closeMenu}>
      <button type="button" role="menuitem" className="persona-menu-item" onClick={() => { closeMenu(); onDialog({ kind: "rename", persona: menuPersona }); }}>Rename</button>
      <button type="button" role="menuitem" className="persona-menu-item persona-menu-danger" onClick={() => { closeMenu(); onDialog({ kind: "delete", persona: menuPersona }); }}>Delete</button>
    </Menu>}
    {menu?.id === "new" && <Menu key="new" trigger={menu.trigger} label="New persona" onClose={closeMenu}>
      <button type="button" role="menuitem" className="persona-menu-item" onClick={() => { closeMenu(); onCreate("claude"); }}>New Claude Code persona</button>
      <button type="button" role="menuitem" className="persona-menu-item" onClick={() => { closeMenu(); onCreate("codex"); }}>New Codex persona</button>
    </Menu>}
  </nav>;
}

/**
 * A boundary between two columns: drag it, or focus it and use the arrow
 * keys. Sized wider than the seam it sits on so grabbing it never means
 * aiming at a hairline.
 */
function ColumnHandle({ weights, measure, onChange, label }: {
  weights: ColumnWeights; measure(): number; onChange(weights: ColumnWeights): void; label: string;
}) {
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const start = weights;
    const width = measure();
    handle.setPointerCapture?.(event.pointerId);
    const move = (moved: PointerEvent) => onChange(resizeColumns(start, moved.clientX - startX, width));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      // Releasing a capture the browser already dropped throws.
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const key = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0;
    if (step === 0) return;
    event.preventDefault();
    onChange(resizeColumns(weights, step, measure()));
  };
  return <div className="persona-column-handle" role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
    onPointerDown={drag} onKeyDown={key} />;
}

/**
 * A link from the chat, as a path the file routes accept: `file:` and a line
 * suffix dropped, a relative path taken from the context folder — or null for
 * a relative path while that folder is still unknown.
 */
export function resolveChatPath(path: string, contextFolder: string | null): string | null {
  let resolved = path.trim();
  if (/^file:/i.test(resolved)) {
    try { resolved = decodeURIComponent(new URL(resolved).pathname); } catch { resolved = resolved.replace(/^file:\/*/i, "/"); }
  }
  resolved = resolved.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, "");
  if (resolved.startsWith("/")) return resolved;
  // Relative to a folder not yet known: nothing to open yet.
  if (contextFolder === null) return null;
  return `${contextFolder.replace(/\/+$/, "")}/${resolved.replace(/^\.\//, "")}`;
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").at(-1) || path;
}

function WorkspaceDetail({ personaId, pick, active, contextFolder, onPick, onBack }: {
  personaId: string; pick: Pick; active: boolean; contextFolder: string | null; onPick(pick: Pick): void; onBack(): void;
}) {
  const workers = useWorkers(personaId);
  const worker = pick.kind === "worker" ? workers.find((candidate) => candidate.id === pick.id) : undefined;
  const title = pick.kind === "worker" ? worker?.title || "Worker"
    : pick.kind === "artifact" ? pick.name
      : pick.kind === "file" ? basename(pick.path)
        : pick.kind === "notice" ? "File"
          : "Context folder";
  return <div className="persona-pick">
    <div className="persona-list-heading persona-pick-heading">
      <button type="button" className="persona-workspace-back"
        aria-label={pick.kind === "file" && pick.fromContext ? "Back to the context folder" : "Back to workspace list"}
        onClick={onBack}><ArrowLeft size={14} /></button>
      <span className="persona-list-title" title={pick.kind === "file" ? pick.path : title}>{title}</span>
    </div>
    <div className="persona-pick-body">
      {pick.kind === "worker" && <WorkerTerminal key={pick.id} workerId={pick.id} worker={worker} />}
      {pick.kind === "artifact" && <ArtifactFrame key={pick.path} personaId={personaId} path={pick.path} name={pick.name} />}
      {pick.kind === "file" && <FileView key={pick.path} personaId={personaId} path={pick.path} active={active} />}
      {pick.kind === "notice" && <p className="persona-pick-note" role="status">{pick.text}</p>}
      {pick.kind === "context" && contextFolder !== null && <ContextFolder personaId={personaId} root={contextFolder} active={active}
        onOpenFile={(path) => onPick({ kind: "file", path, fromContext: true })} />}
    </div>
  </div>;
}

/** Stable keys keep each visited terminal, frame and context tree alive. */
function pickKey(pick: Pick): string {
  switch (pick.kind) {
    case "worker": return `worker:${pick.id}`;
    case "artifact": return `artifact:${pick.path}`;
    case "file": return `file:${pick.path}`;
    case "context": return "context";
    case "notice": return "notice";
  }
}

/** One persona's conversation and workspace; hidden personas stay mounted. */
function PersonaView({ personaId, visible, onDialog }: { personaId: string; visible: boolean; onDialog(dialog: Dialog): void }) {
  const workspace = useWorkspaceTree(personaId);
  const [pick, setPick] = useState<Pick | null>(null);
  const [visited, setVisited] = useState<Record<string, Pick>>({});
  const [weights, setWeights] = useState<ColumnWeights>(readWeights);
  const columnsRef = useRef<HTMLDivElement>(null);
  const contextFolder = workspace.tree?.contextFolder.path ?? null;

  const changeWeights = useCallback((next: ColumnWeights) => { setWeights(next); saveWeights(next); }, []);
  // The page's width when nothing has been laid out (a hidden tab) is the window's.
  const measure = useCallback(() => columnsRef.current?.getBoundingClientRect().width || window.innerWidth, []);
  const openPick = useCallback((next: Pick) => {
    setVisited((held) => ({ ...held, [pickKey(next)]: next }));
    setPick(next);
  }, []);
  const openPath = useCallback((path: string) => {
    const resolved = resolveChatPath(path, contextFolder);
    openPick(resolved === null ? { kind: "notice", text: "Still loading this persona's files." } : { kind: "file", path: resolved, fromContext: false });
  }, [contextFolder, openPick]);
  const back = () => {
    if (pick?.kind === "file" && pick.fromContext) openPick({ kind: "context" });
    else setPick(null);
  };

  const column = (index: 0 | 1) => ({ flexGrow: weights[index], flexShrink: 1, flexBasis: 0 });
  return <div className="persona-columns" ref={columnsRef}>
    <section className="persona-column persona-column-conversation" style={column(0)} aria-label="Conversation">
      <Conversation personaId={personaId} onOpenPath={openPath} />
    </section>
    <ColumnHandle weights={weights} measure={measure} onChange={changeWeights} label="Resize the conversation column" />
    <section className="persona-column persona-column-workspace" style={column(1)} aria-label="Workspace">
      <div className="persona-workspace-page" hidden={pick !== null} inert={pick !== null}>
        <WorkspaceList workspace={workspace} pick={pick} onPick={openPick}
          onOpenRepos={() => onDialog({ kind: "repos" })} onOpenContext={() => openPick({ kind: "context" })} />
      </div>
      {Object.entries(visited).map(([key, detail]) => {
        const active = pick !== null && key === pickKey(pick);
        return <div key={key} className="persona-workspace-page" hidden={!active} inert={!active}>
          <WorkspaceDetail personaId={personaId} pick={detail} active={active && visible} contextFolder={contextFolder} onPick={openPick} onBack={back} />
        </div>;
      })}
    </section>
  </div>;
}

export function PersonaApp() {
  const api = getApi();
  const { personas, loaded, status } = usePersonas();
  const visible = useDocumentVisible();
  const ordered = useMemo(() => [...personas].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0), [personas]);
  const [selectedId, setSelectedId] = useState<string | null>(readSelected);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [visited, setVisited] = useState<string[]>([]);
  const shown = ordered.find((persona) => persona.id === selectedId) ?? ordered[0] ?? null;

  const select = useCallback((id: string) => { setSelectedId(id); saveSelected(id); }, []);

  const create = useCallback((harness: Harness) => {
    setCreating(true);
    setError(null);
    api.request("persona:create", { harness }).then(
      (persona) => { setCreating(false); select(persona.id); },
      (err: unknown) => { setCreating(false); setError(message(err)); },
    );
  }, [api, select]);

  // The shown persona's replies are read as they arrive.
  const shownId = shown?.id ?? null;
  useEffect(() => {
    if (shownId !== null) setVisited((held) => held.includes(shownId) ? held : [...held, shownId]);
  }, [shownId]);
  const shownUnread = shown?.unread ?? false;
  useEffect(() => {
    if (shownId === null || !shownUnread || !visible) return;
    api.request("persona:mark-read", { id: shownId }).catch((err: unknown) => {
      console.warn("[personas] persona:mark-read failed:", message(err));
    });
  }, [api, shownId, shownUnread, visible]);

  const closeDialog = useCallback(() => setDialog(null), []);
  const dialogs = dialog === null ? null
    : dialog.kind === "rename" ? <RenameDialog persona={dialog.persona} onClose={closeDialog} />
      : dialog.kind === "delete" ? <DeleteDialog persona={dialog.persona} onClose={closeDialog} />
        : shownId !== null ? <ReposDialog personaId={shownId} onClose={closeDialog} /> : null;

  if (!loaded) return <div className="personas-app" />;

  if (ordered.length === 0) {
    return <div className="personas-app">
      <div className="personas-empty">
        <p className="persona-empty-title">No personas yet</p>
        <p className="persona-empty-note">A persona is a long-running agent that directs Claude Code and Codex workers on this machine.</p>
        <button type="button" className="persona-dialog-button persona-dialog-primary" disabled={creating} onClick={() => create("claude")}>New persona</button>
        {error !== null && <p className="persona-dialog-error" role="alert">{error}</p>}
      </div>
    </div>;
  }

  return <div className="personas-app">
    <Switcher personas={ordered} status={status} shownId={shownId} visible={visible} onSelect={select} onCreate={create} onDialog={setDialog} />
    <main className="persona-content">
      {error !== null && <div className="persona-app-error" role="alert"><span>{error}</span>
        <button type="button" className="persona-list-tool" aria-label="Dismiss error" onClick={() => setError(null)}><X size={13} /></button></div>}
      {ordered.filter((persona) => persona.id === shownId || visited.includes(persona.id)).map((persona) =>
        <div key={persona.id} className="persona-retained-view" hidden={persona.id !== shownId} inert={persona.id !== shownId}>
          <PersonaView personaId={persona.id} visible={persona.id === shownId && visible} onDialog={setDialog} />
        </div>)}
    </main>
    {dialogs}
  </div>;
}
