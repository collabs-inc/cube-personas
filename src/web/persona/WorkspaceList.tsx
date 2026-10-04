// Adapted from cube-computer: src/windows/app/src/persona/PersonaTree.tsx
//
// Changes: the rows come from the server's `workspace:get`, and are grouped
// as the tree the server sends — repositories, their
// checkouts, the workers and artifacts in each — with the context folder's
// artifacts last. Renaming, the place badge's mini sidebar and the row menus
// are gone; a worker row carries a state dot and its latest report's first
// line instead of Cube's attention spinner and vendor logo.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FileHtml, Folder, GitBranch, GitFork } from "@phosphor-icons/react";
import type { WorkspaceTree, WorkspaceWorker } from "../../shared/types";
import { getApi } from "../api";
import { usePersonaStatus } from "../stores/personas";

/** What replaces the collection in the workspace. */
export type Pick =
  | { kind: "worker"; id: string }
  | { kind: "artifact"; path: string; name: string }
  | { kind: "file"; path: string; fromContext: boolean }
  | { kind: "context" }
  /** A sentence in place of something that cannot open yet. */
  | { kind: "notice"; text: string };

export interface WorkspaceState {
  tree: WorkspaceTree | null;
  error: string | null;
}

/**
 * How long a burst of worker and report changes is gathered before the
 * workspace is read again. Each read runs a few git commands per checkout and
 * per worker on the server, and worker states flip on every turn.
 */
export const RELOAD_DEBOUNCE_MS = 400;

/**
 * The persona's workspace, read on mount and again whenever it may have
 * changed: its workers changed, a report arrived, its own turn ended (it may
 * have written an artifact), or the socket came back. Changes are gathered
 * for RELOAD_DEBOUNCE_MS into one read.
 */
export function useWorkspaceTree(personaId: string): WorkspaceState {
  const api = getApi();
  const [state, setState] = useState<WorkspaceState>({ tree: null, error: null });
  const latest = useRef(0);

  const load = useCallback((): void => {
    const mine = ++latest.current;
    api.request("workspace:get", { personaId }).then(
      (tree) => { if (mine === latest.current) setState({ tree, error: null }); },
      (err: unknown) => {
        if (mine === latest.current) setState((held) => ({ tree: held.tree, error: err instanceof Error ? err.message : String(err) }));
      },
    );
  }, [api, personaId]);

  useEffect(() => {
    setState({ tree: null, error: null });
    load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = (): void => {
      if (timer !== null) return;
      timer = setTimeout(() => { timer = null; load(); }, RELOAD_DEBOUNCE_MS);
    };
    const offs = [
      api.on("workers:changed", (event) => { if (event.personaId === personaId) soon(); }),
      api.on("reports:changed", (event) => { if (event.personaId === personaId) soon(); }),
      api.onReconnect(load),
    ];
    return () => {
      if (timer !== null) clearTimeout(timer);
      for (const off of offs) off();
    };
  }, [api, personaId, load]);

  const personaState = usePersonaStatus(personaId)?.state;
  const previous = useRef(personaState);
  useEffect(() => {
    if (previous.current === "busy" && personaState !== "busy") load();
    previous.current = personaState;
  }, [personaState, load]);

  return state;
}

/** The first line of a report with any text, for a row's second line. */
export function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== "");
  return line ?? null;
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").at(-1) || path;
}

const STATE_LABELS: Record<WorkspaceWorker["state"], string> = { running: "Working", idle: "Idle", exited: "Exited" };

function WorkerRow({ worker, picked, onPick }: { worker: WorkspaceWorker; picked: boolean; onPick(): void }) {
  const report = firstLine(worker.latestReport);
  return <button type="button" className="persona-subitem persona-worker-row" data-worker-id={worker.id} aria-pressed={picked}
    title={`${worker.title} · ${STATE_LABELS[worker.state]}`} onClick={onPick}>
    <span className="persona-worker-dot" data-state={worker.state} role="img" aria-label={STATE_LABELS[worker.state]} />
    <span className="persona-worker-copy">
      <span className="persona-subitem-copy">{worker.title || (worker.harness === "codex" ? "Codex worker" : "Claude worker")}</span>
      {report !== null && <span className="persona-worker-report">{report}</span>}
    </span>
  </button>;
}

function ArtifactRow({ artifact, picked, onPick }: { artifact: { path: string; name: string }; picked: boolean; onPick(): void }) {
  return <button type="button" className="persona-subitem" data-artifact-path={artifact.path} aria-pressed={picked}
    title={artifact.path} onClick={onPick}>
    <span className="persona-worker-icon"><FileHtml size={15} aria-hidden="true" /></span>
    <span className="persona-subitem-copy">{artifact.name}</span>
  </button>;
}

function Section({ title, icon, note, children, depth = 0 }: { title: string; icon: ReactNode; note?: string; children?: ReactNode; depth?: number }) {
  return <div className="persona-section" role="group" aria-label={title} data-depth={depth}>
    <div className={depth === 0 ? "persona-tree-repo" : "persona-tree-checkout"}>
      {icon}<span className="persona-tree-branch">{title}</span>
      {note && <span className="persona-checkout-label">{note}</span>}
    </div>
    {children}
  </div>;
}

export function WorkspaceList({ workspace, pick, onPick, onOpenRepos, onOpenContext }: {
  workspace: WorkspaceState;
  pick: Pick | null;
  onPick(pick: Pick): void;
  onOpenRepos(): void;
  onOpenContext(): void;
}) {
  const { tree, error } = workspace;
  const isWorker = (id: string) => pick?.kind === "worker" && pick.id === id;
  const isArtifact = (path: string) => pick?.kind === "artifact" && pick.path === path;
  const artifactRow = (artifact: { path: string; name: string }) => <ArtifactRow key={artifact.path} artifact={artifact}
    picked={isArtifact(artifact.path)} onPick={() => onPick({ kind: "artifact", path: artifact.path, name: artifact.name })} />;
  const empty = tree !== null && tree.repos.length === 0 && tree.contextFolder.artifacts.length === 0;

  return <div className="persona-list-surface">
    <div className="persona-list-heading">
      <span className="persona-list-title">Workspace</span>
      <div className="persona-list-tools">
        <button type="button" className="persona-list-tool" aria-label="Repositories" title="Repositories" onClick={onOpenRepos}><GitFork size={14} aria-hidden="true" /><span>Repositories</span></button>
        <button type="button" className="persona-list-tool" aria-pressed={pick?.kind === "context"} disabled={tree === null}
          aria-label="Context folder" title="Context folder" onClick={onOpenContext}><Folder size={14} aria-hidden="true" /><span>Context folder</span></button>
      </div>
    </div>
    {error !== null && <p className="persona-pick-error" role="alert">{error}</p>}
    {empty ? <div className="persona-empty">
      <p className="persona-empty-title">Workers and artifacts appear here</p>
      <p className="persona-empty-note">Ask the persona to start one.</p>
    </div> : tree !== null && <div className="persona-tree">
      {tree.repos.map((repo) => <Section key={repo.root} title={repo.name} icon={<GitFork size={13} aria-hidden="true" />}
        note={repo.stale ? "missing" : !repo.known ? "not listed" : undefined}>
        {repo.checkouts.map((checkout) => <Section key={checkout.root} depth={1}
          title={checkout.branch ?? basename(checkout.root)} icon={<GitBranch size={13} aria-hidden="true" />}
          note={checkout.root !== repo.root ? basename(checkout.root) : undefined}>
          {checkout.workers.map((worker) => <WorkerRow key={worker.id} worker={worker} picked={isWorker(worker.id)}
            onPick={() => onPick({ kind: "worker", id: worker.id })} />)}
          {checkout.artifacts.map(artifactRow)}
        </Section>)}
      </Section>)}
      <Section title="Context folder" icon={<Folder size={13} aria-hidden="true" />}>
        {tree.contextFolder.artifacts.map(artifactRow)}
      </Section>
    </div>}
  </div>;
}
