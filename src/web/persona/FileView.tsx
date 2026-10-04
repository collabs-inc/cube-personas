/** A file, read-only, as `files:read` returns it (the first 1 MB at most). */
import { useEffect, useState } from "react";
import { getApi } from "../api";

type Loaded = { status: "loading" } | { status: "ok"; text: string; truncated: boolean } | { status: "error"; message: string };

export function FileView({ personaId, path, active = true }: { personaId: string; path: string; active?: boolean }) {
  const api = getApi();
  const [file, setFile] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    if (!active) return;
    let current = true;
    setFile((held) => held.status === "ok" ? held : { status: "loading" });
    api.request("files:read", { personaId, path }).then(
      ({ text, truncated }) => { if (current) setFile({ status: "ok", text, truncated }); },
      (err: unknown) => { if (current) setFile({ status: "error", message: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { current = false; };
  }, [api, personaId, path, active]);

  if (file.status === "loading") return <div className="file-view file-view-loading" />;
  if (file.status === "error") return <div className="file-view"><p className="persona-pick-error" role="alert">{file.message}</p></div>;
  return <div className="file-view">
    {file.truncated && <p className="file-view-note" role="status">Showing the first 1 MB.</p>}
    <pre className="file-view-text">{file.text}</pre>
  </div>;
}
