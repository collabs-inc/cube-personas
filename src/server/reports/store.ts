// Adapted from cube-computer: src/main/cubed/personas/reports.ts
//
// Worker reports and the persona's acknowledgements of them. One file per
// report under a directory per persona, plus one `acknowledged.json`; all of
// it is read once at `load()` and served from memory afterwards, since this
// server is the only writer. A report stays on disk after it is
// acknowledged, so `latestFor` can still name an agent's newest one.
//
// Delivery is at least once: losing the acknowledgements file means every
// report is re-sent, never that one is dropped.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentReport } from "../../shared/types";

const ACKNOWLEDGED = "acknowledged.json";

const directoryKey = (id: string): string => encodeURIComponent(id).replace(/\./g, "%2E");
const fileKey = (id: string): string => createHash("sha256").update(id).digest("hex");

function isReport(value: unknown): value is AgentReport {
  if (!value || typeof value !== "object") return false;
  const r = value as AgentReport;
  return [r.reportId, r.personaId, r.agentId, r.text, r.title, r.cwd, r.at].every(v => typeof v === "string")
    && typeof r.messageUnavailable === "boolean"
    && ["ended", "exited", "interrupted"].includes(r.kind);
}

export class ReportStore {
  /** Every report: those on disk sorted by time at load, then those recorded since. */
  private readonly reports = new Map<string, AgentReport>();
  private readonly acknowledged = new Set<string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  async load(): Promise<void> {
    this.reports.clear();
    this.acknowledged.clear();
    const found: AgentReport[] = [];
    for (const sub of await this.list(this.dir)) {
      if (sub === ACKNOWLEDGED || sub.endsWith(".corrupt") || sub.endsWith(".tmp")) continue;
      const personaDir = join(this.dir, sub);
      for (const name of await this.list(personaDir)) {
        if (!name.endsWith(".json")) continue;
        const file = join(personaDir, name);
        try {
          const value: unknown = JSON.parse(await readFile(file, "utf8"));
          if (!isReport(value)) throw new Error("not a report");
          found.push(value);
        } catch {
          await rename(file, `${file}.corrupt`).catch(() => undefined);
          this.log(`Report file ${sub}/${name} could not be read; one worker report was lost and it was kept as ${name}.corrupt.`);
        }
      }
    }
    found.sort((a, b) => a.at.localeCompare(b.at) || a.reportId.localeCompare(b.reportId));
    for (const r of found) this.reports.set(r.reportId, r);
    for (const id of await this.readAcknowledged()) this.acknowledged.add(id);
  }

  /** Stores a report; `false` when its id is already stored, which changes nothing. */
  async record(report: AgentReport): Promise<boolean> {
    if (this.reports.has(report.reportId)) return false;
    // Claimed synchronously, so a concurrent duplicate also sees it as stored.
    this.reports.set(report.reportId, structuredClone(report));
    const file = join(this.dir, directoryKey(report.personaId), `${fileKey(report.reportId)}.json`);
    try {
      await this.enqueue(() => this.writeAtomic(file, JSON.stringify(report)));
    } catch (error) {
      // Not persisted: release the claim, so a retry stores it rather than reporting a duplicate.
      this.reports.delete(report.reportId);
      throw error;
    }
    return true;
  }

  /** The persona's unacknowledged reports, oldest first. */
  pending(personaId: string): AgentReport[] {
    const out: AgentReport[] = [];
    for (const r of this.reports.values()) {
      if (r.personaId === personaId && !this.acknowledged.has(r.reportId)) out.push(structuredClone(r));
    }
    // Stable: reports of one instant keep the order they were recorded in.
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * Acknowledges the persona's own pending reports among `ids`. Anything else
   * — another persona's report, an unknown id, one already acknowledged — is
   * ignored, since the persona's `ack` reaches here unfiltered.
   */
  async acknowledge(personaId: string, ids: string[]): Promise<void> {
    let changed = false;
    for (const id of ids) {
      const r = this.reports.get(id);
      if (r?.personaId !== personaId || this.acknowledged.has(id)) continue;
      this.acknowledged.add(id);
      changed = true;
    }
    if (!changed) return;
    await this.enqueue(() => this.writeAtomic(join(this.dir, ACKNOWLEDGED), JSON.stringify([...this.acknowledged])));
  }

  /** The agent's newest report, acknowledged or not. */
  latestFor(agentId: string): AgentReport | null {
    let latest: AgentReport | null = null;
    for (const r of this.reports.values()) {
      if (r.agentId === agentId && (latest === null || r.at >= latest.at)) latest = r;
    }
    return latest === null ? null : structuredClone(latest);
  }

  /** Forgets a deleted persona's reports and removes their directory. Acknowledgements of them stay, harmlessly. */
  async removePersona(personaId: string): Promise<void> {
    for (const [id, r] of this.reports) if (r.personaId === personaId) this.reports.delete(id);
    await this.enqueue(() => rm(join(this.dir, directoryKey(personaId)), { recursive: true, force: true }));
  }

  // --- internals ---------------------------------------------------------

  private async list(dir: string): Promise<string[]> {
    try { return await readdir(dir); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw error;
    }
  }

  private async readAcknowledged(): Promise<string[]> {
    const file = join(this.dir, ACKNOWLEDGED);
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const ids: unknown = JSON.parse(text);
      if (!Array.isArray(ids) || !ids.every(id => typeof id === "string")) throw new Error("not a list of ids");
      return ids;
    } catch {
      await rename(file, `${file}.corrupt`);
      this.log(`State file reports/${ACKNOWLEDGED} could not be read; report acknowledgements were lost (those reports will be delivered again) and it was kept as ${ACKNOWLEDGED}.corrupt.`);
      return [];
    }
  }

  /** Serializes writes; a failed write does not stop the next one. */
  private enqueue(write: () => Promise<void>): Promise<void> {
    const next = this.writes.then(write);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async writeAtomic(file: string, data: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(file), `.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, file);
    } finally { await rm(tmp, { force: true }); }
  }
}
