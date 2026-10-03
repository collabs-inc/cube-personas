export type Harness = "claude" | "codex";
export type PersonaState = "starting" | "ready" | "busy" | "stopped" | "failed";

export interface Persona {
  id: string;
  name: string | null;
  harness: Harness;
  createdAt: string;
  acpSessionId: string | null;
  launchId: string | null;
  pid: number | null;
  cmdline: string | null;
  state: PersonaState;
  failure?: string;
  unread: boolean;
}

export type WorkerState = "running" | "idle" | "exited";

export interface Worker {
  id: string;
  personaId: string;
  harness: Harness;
  cwd: string;
  title: string;
  sessionId: string | null;
  launchId: string;
  pid: number | null;
  cmdline: string | null;
  state: WorkerState;
  exitCode?: number;
  createdAt: string;
  lastReportId: string | null;
}

export interface AgentReport {
  reportId: string;
  personaId: string;
  agentId: string;
  kind: "ended" | "exited" | "interrupted";
  text: string;
  messageUnavailable: boolean;
  title: string;
  cwd: string;
  at: string;
  exitCode?: number;
}

export interface RepoEntry {
  path: string;
  name: string;
  known: boolean;
}

/**
 * A worker as the workspace list shows it. `latestReport` is the text of its
 * latest report, when it has one: the list shows its first line. Optional, so
 * a plain `Worker` is one too.
 */
export type WorkspaceWorker = Worker & { latestReport?: string | null };

export interface WorkspaceTree {
  repos: Array<{
    root: string;
    name: string;
    known: boolean;
    stale: boolean;
    checkouts: Array<{
      root: string;
      branch: string | null;
      workers: WorkspaceWorker[];
      artifacts: Array<{ path: string; name: string }>;
    }>;
  }>;
  contextFolder: { path: string; artifacts: Array<{ path: string; name: string }> };
}
