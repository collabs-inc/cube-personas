// Adapted from cube-computer: packages/components/src/Terminal/TerminalTab.tsx (the xterm options and fit-addon use) and packages/components/src/Terminal/theme.ts (both palettes, verbatim)
/**
 * A worker's live terminal in the pick column.
 *
 * Cube's TerminalTab carries byte cursors, backfill, an attach scheduler and
 * a WebGL renderer; a worker here needs far less. Attach writes the trailing
 * output the server holds (at most 256 KiB), `worker:output` appends, the
 * keystrokes and the grid size go back to the pty. A reconnect re-attaches
 * from a reset screen, because output sent while the socket was down never
 * reached this page.
 *
 * Output that arrives while an attach is in flight is dropped, not written:
 * the server reads the trailing output when it handles the attach and the
 * socket delivers in order, so every such event is already in the reply.
 */
import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Worker } from "../../shared/types";
import { getApi } from "../api";
import { useDocumentTheme, type Theme } from "../use-theme";

const darkTheme: ITheme = {
  background: "rgba(8, 8, 8, 0)",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

// Every entry clears 4.5:1 against the light surface (rgb(248, 248, 248)).
// For the six hues "bright" is DARKER: on a light background emphasis reads
// as more ink, not less.
const lightTheme: ITheme = {
  background: "rgba(248, 248, 248, 0)",
  foreground: "#383a42",
  cursor: "#383a42",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  black: "#383a42",
  red: "#d1382a",
  green: "#3f7e3e",
  yellow: "#976701",
  blue: "#396bd9",
  magenta: "#a626a4",
  cyan: "#01749f",
  white: "#575a67",
  brightBlack: "#4f525e",
  brightRed: "#a3251a",
  brightGreen: "#2a6029",
  brightYellow: "#7d5602",
  brightBlue: "#2551b0",
  brightMagenta: "#7d1c7b",
  brightCyan: "#015877",
  brightWhite: "#6c707e",
};

function terminalTheme(theme: Theme): ITheme {
  return theme === "dark" ? darkTheme : lightTheme;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function exitText(code: number | null | undefined): string {
  return typeof code === "number" ? `Exited with code ${code}.` : "Exited.";
}

export function WorkerTerminal({ workerId, worker }: { workerId: string; worker: Worker | undefined }) {
  const api = getApi();
  const theme = useDocumentTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // How the worker ended, from its `worker:exit` event or the attach reply.
  const [exit, setExit] = useState<{ code: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      theme: terminalTheme(document.documentElement.classList.contains("dark") ? "dark" : "light"),
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 12,
      fontWeight: "300",
      fontWeightBold: "500",
      cursorBlink: true,
      scrollback: 20000,
      allowTransparency: document.documentElement.classList.contains("dark"),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    let disposed = false;
    let attaching = true;
    let generation = 0;

    const refit = (): void => {
      const { width, height } = host.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      try { fit.fit(); } catch { /* not measurable yet */ }
    };
    const sendSize = (): void => {
      api.request("worker:resize", { id: workerId, cols: term.cols, rows: term.rows }).catch(() => {});
    };

    const attach = async (): Promise<void> => {
      const mine = ++generation;
      attaching = true;
      try {
        const result = await api.request("worker:attach", { id: workerId });
        if (disposed || mine !== generation) return;
        if (mine > 1) term.reset();
        term.write(result.data);
        attaching = false;
        setError(null);
        if (result.exited) setExit((held) => held ?? { code: null });
      } catch (err) {
        if (disposed || mine !== generation) return;
        attaching = false;
        setError(message(err));
      }
    };

    const offs = [
      api.on("worker:output", ({ id, data }) => { if (id === workerId && !attaching) term.write(data); }),
      api.on("worker:exit", ({ id, exitCode }) => { if (id === workerId) setExit({ code: exitCode }); }),
      api.onReconnect(() => { void attach(); }),
    ];
    const input = term.onData((data) => {
      api.request("worker:input", { id: workerId, data }).catch((err: unknown) => setError(message(err)));
    });
    const resized = term.onResize(({ cols, rows }) => {
      api.request("worker:resize", { id: workerId, cols, rows }).catch(() => {});
    });

    refit();
    sendSize();
    void attach();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => refit());
      observer.observe(host);
    }

    return () => {
      disposed = true;
      observer?.disconnect();
      for (const off of offs) off();
      // Output for this worker stops coming to this page until it attaches again.
      api.request("worker:detach", { id: workerId }).catch(() => {});
      input.dispose();
      resized.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [api, workerId]);

  // A live theme change rethemes the terminal rather than recreating it.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.allowTransparency = theme === "dark";
    term.options.theme = terminalTheme(theme);
  }, [theme]);

  // A worker resumed after an exit is running again.
  const state = worker?.state;
  useEffect(() => {
    if (state === "running" || state === "idle") setExit(null);
  }, [state]);

  const ended = exit ?? (worker?.state === "exited" ? { code: worker.exitCode ?? null } : null);
  return <div className="worker-terminal">
    <div className="worker-terminal-host" ref={hostRef} onClick={() => termRef.current?.focus()} />
    {error !== null && <div className="worker-terminal-error" role="alert">{error}</div>}
    {ended !== null && <div className="worker-terminal-exit" role="status">{exitText(ended.code)}</div>}
  </div>;
}
