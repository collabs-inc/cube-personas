/**
 * The persona's context folder in the pick column: a list from `files:list`
 * where a directory expands in place (read when first opened) and a file
 * opens read-only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CaretRight, File as FileIcon, Folder } from "@phosphor-icons/react";
import { getApi } from "../api";

type Entry = { name: string; dir: boolean };
type Listing = { status: "loading" } | { status: "ok"; entries: Entry[] } | { status: "error"; message: string };

/** `dir/name`, with exactly one slash between them. */
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function Directory({ personaId, path, depth, listings, expanded, onToggle, onOpenFile }: {
  personaId: string; path: string; depth: number;
  listings: Record<string, Listing>; expanded: ReadonlySet<string>;
  onToggle(path: string): void; onOpenFile(path: string): void;
}) {
  const listing = listings[path];
  if (!listing || listing.status === "loading") return null;
  if (listing.status === "error") return <p className="persona-pick-error" role="alert" style={{ paddingLeft: 8 + depth * 14 }}>{listing.message}</p>;
  if (listing.entries.length === 0) return <p className="context-folder-empty" style={{ paddingLeft: 8 + depth * 14 }}>Empty folder</p>;
  return <ul className="context-folder-list" role={depth === 0 ? "tree" : "group"}>
    {listing.entries.map((entry) => {
      const child = joinPath(path, entry.name);
      const open = entry.dir && expanded.has(child);
      return <li key={entry.name} role="treeitem" aria-expanded={entry.dir ? open : undefined}>
        <button type="button" className="context-folder-row" style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => entry.dir ? onToggle(child) : onOpenFile(child)}>
          {entry.dir
            ? <><CaretRight className="context-folder-caret" data-open={open || undefined} size={11} aria-hidden="true" /><Folder size={14} aria-hidden="true" /></>
            : <><span className="context-folder-caret-space" /><FileIcon size={14} aria-hidden="true" /></>}
          <span className="context-folder-name">{entry.name}</span>
        </button>
        {open && <Directory personaId={personaId} path={child} depth={depth + 1} listings={listings} expanded={expanded}
          onToggle={onToggle} onOpenFile={onOpenFile} />}
      </li>;
    })}
  </ul>;
}

export function ContextFolder({ personaId, root, active = true, onOpenFile }: {
  personaId: string; root: string; active?: boolean; onOpenFile(path: string): void;
}) {
  const api = getApi();
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const requests = useRef(new Map<string, number>());

  const read = useCallback((path: string): void => {
    const version = (requests.current.get(path) ?? 0) + 1;
    requests.current.set(path, version);
    setListings((held) => held[path]?.status === "ok" ? held : { ...held, [path]: { status: "loading" } });
    api.request("files:list", { personaId, path }).then(
      ({ entries }) => { if (requests.current.get(path) === version) setListings((held) => ({ ...held, [path]: { status: "ok", entries } })); },
      (err: unknown) => { if (requests.current.get(path) === version) setListings((held) => ({ ...held, [path]: { status: "error", message: err instanceof Error ? err.message : String(err) } })); },
    );
  }, [api, personaId]);

  useEffect(() => {
    if (!active) return;
    read(root);
    for (const path of expandedRef.current) read(path);
  }, [read, root, active]);

  const toggle = (path: string): void => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      // Read a directory the first time it opens; later opens show what was read.
      if (listings[path]?.status !== "ok") read(path);
    }
    setExpanded(next);
  };

  return <div className="context-folder">
    <p className="context-folder-root" title={root}>{root}</p>
    <Directory personaId={personaId} path={root} depth={0} listings={listings} expanded={expanded}
      onToggle={toggle} onOpenFile={onOpenFile} />
  </div>;
}
