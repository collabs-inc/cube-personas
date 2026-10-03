/**
 * The persona's `## Repositories` block, edited as text. Save hands the text
 * to the server, which checks it; a refusal is shown as the server's own
 * sentence and the dialog stays open with the text as typed.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getApi } from "../api";

/** A modal over the page: Escape or the backdrop cancels. */
export function PersonaDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("textarea, input, button");
    first?.focus();
    return () => previous?.focus?.();
  }, []);
  return <div className="persona-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className="persona-dialog" role="dialog" aria-modal="true" aria-label={title}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <h2 className="persona-dialog-title">{title}</h2>
      {children}
    </div>
  </div>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ReposDialog({ personaId, onClose }: { personaId: string; onClose(): void }) {
  const api = getApi();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    api.request("repos:get", { personaId }).then(
      (result) => { if (current) setText(result.text); },
      (err: unknown) => { if (current) { setText(""); setError(message(err)); } },
    );
    return () => { current = false; };
  }, [api, personaId]);

  const save = (): void => {
    if (text === null) return;
    setSaving(true);
    api.request("repos:set", { personaId, text }).then(
      () => { setSaving(false); onClose(); },
      (err: unknown) => { setSaving(false); setError(message(err)); },
    );
  };

  return <PersonaDialog title="Repositories" onClose={onClose}>
    <p className="persona-dialog-note">The repositories this persona knows, as its context folder lists them.</p>
    <textarea className="persona-dialog-textarea" aria-label="Repositories" spellCheck={false}
      value={text ?? ""} disabled={text === null} rows={10}
      onChange={(event) => { setText(event.target.value); setError(null); }}
      onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); } }} />
    {error !== null && <p className="persona-dialog-error" role="alert">{error}</p>}
    <div className="persona-dialog-actions">
      <button type="button" className="persona-dialog-button" onClick={onClose}>Cancel</button>
      <button type="button" className="persona-dialog-button persona-dialog-primary" disabled={text === null || saving} onClick={save}>Save</button>
    </div>
  </PersonaDialog>;
}
