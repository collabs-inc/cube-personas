// Adapted from cube-computer: src/windows/app/src/items/agent/ToolScreenshot.tsx
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ImageSquare } from "@phosphor-icons/react";
import type { LoadScreenshot, ScreenshotReference } from "./tool-screenshots";

export function ToolScreenshot(props: {
  reference: ScreenshotReference;
  load: LoadScreenshot;
  onOpenPath: (nativePath: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(typeof IntersectionObserver === "undefined");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ status: "idle" | "loading" | "missing" } | { status: "loaded"; url: string }>({ status: "idle" });
  const filename = props.reference.nativePath.replaceAll("\\", "/").split("/").at(-1) ?? props.reference.nativePath;

  useEffect(() => {
    const element = root.current;
    if (!element || nearby || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setNearby(true); observer.disconnect(); }
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [nearby]);

  useEffect(() => {
    if (!nearby) return;
    let cancelled = false;
    setState({ status: "loading" });
    props.load(props.reference.rendererPath).then(
      image => { if (!cancelled) setState({ status: "loaded", url: image.url }); },
      () => { if (!cancelled) setState({ status: "missing" }); },
    );
    return () => { cancelled = true; };
  }, [nearby, attempt, props.load, props.reference.rendererPath]);

  return <div ref={root} className="agent-tool-screenshot">
    {state.status === "loaded" && <button type="button" className="agent-tool-screenshot-open" onClick={() => props.onOpenPath(props.reference.nativePath)} aria-label={`Open full image ${filename}`}>
      <img src={state.url} alt={filename} loading="lazy" onError={() => setState({ status: "missing" })} />
    </button>}
    {state.status === "loading" && <div className="agent-tool-screenshot-loading" role="status"><ImageSquare size={18} /> Loading screenshot…</div>}
    {state.status === "missing" && <div className="agent-tool-screenshot-missing" role="status">
      <span>Screenshot no longer available</span>
      <button type="button" className="agent-tool-screenshot-retry" onClick={() => setAttempt(value => value + 1)}><ArrowClockwise size={13} /> Retry</button>
    </div>}
    <span className="agent-tool-screenshot-name" title={props.reference.nativePath}>{filename}</span>
  </div>;
}
