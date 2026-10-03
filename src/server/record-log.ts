// One persona's conversation as an append-only log: every JSON-RPC message
// that crossed its adapter's pipe, in either direction, one JSON line each
// in `<dir>/log.jsonl`. `seq` numbers records from 1 and is what a page
// reconnecting hands back to receive only what it has not seen.
//
// The file is complete and never trimmed. Memory holds only a trailing
// window of it (at most WINDOW_MAX_RECORDS records and WINDOW_MAX_BYTES of
// their JSON), which is all a page is ever sent: a long-running persona's
// log grows for weeks, and neither the server's heap nor a page's first
// read should grow with it. Whatever must know about the whole history
// watches every record go by through `observe`, on open and on append.
import { createReadStream, appendFileSync, mkdirSync } from "node:fs";
import { truncate } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRecord, JsonRpcMessage } from "../shared/agent-protocol";

/** Records kept in memory: the last several turns of a streamed conversation. */
export const WINDOW_MAX_RECORDS = 5000;
/** JSON bytes kept in memory; the newest record is always kept, whatever its size. */
export const WINDOW_MAX_BYTES = 4 * 1024 * 1024;

export interface RecordLogOptions {
  maxRecords?: number;
  maxBytes?: number;
  /** Sees every record, oldest first: each one read on open, then each one appended. */
  observe?: (record: AgentRecord) => void;
}

export class RecordLog {
  private readonly file: string;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly observe: (record: AgentRecord) => void;
  private window: AgentRecord[] = [];
  private sizes: number[] = [];
  private windowBytes = 0;
  private lastSeq = 0;

  constructor(private readonly dir: string, opts: RecordLogOptions = {}) {
    this.file = join(dir, "log.jsonl");
    this.maxRecords = opts.maxRecords ?? WINDOW_MAX_RECORDS;
    this.maxBytes = opts.maxBytes ?? WINDOW_MAX_BYTES;
    this.observe = opts.observe ?? (() => {});
  }

  /** Reads the existing log, streaming. A torn last line (a crash mid-write) is dropped and cut from the file. */
  async open(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    this.window = [];
    this.sizes = [];
    this.windowBytes = 0;
    this.lastSeq = 0;
    let keptBytes = 0;
    let totalBytes = 0;
    let pending: Buffer[] = [];
    const take = (line: Buffer): void => {
      keptBytes += line.length + 1;
      const text = line.toString("utf8");
      let record: AgentRecord;
      try {
        record = JSON.parse(text) as AgentRecord;
      } catch {
        console.warn(`record log: skipped an unreadable record after seq ${this.lastSeq}`);
        return;
      }
      this.keep(record, line.length + 1);
    };
    try {
      for await (const chunk of createReadStream(this.file) as AsyncIterable<Buffer>) {
        totalBytes += chunk.length;
        let at = 0;
        for (;;) {
          const nl = chunk.indexOf(0x0a, at);
          if (nl === -1) break;
          pending.push(chunk.subarray(at, nl));
          take(pending.length === 1 ? pending[0]! : Buffer.concat(pending));
          pending = [];
          at = nl + 1;
        }
        if (at < chunk.length) pending.push(Buffer.from(chunk.subarray(at)));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    // No newline after the last line: the write never finished.
    if (keptBytes < totalBytes) await truncate(this.file, keptBytes);
  }

  /** Appends one record synchronously, so records land on disk in the order they happened. */
  append(dir: "in" | "out", message: JsonRpcMessage): AgentRecord {
    const record: AgentRecord = { seq: this.lastSeq + 1, dir, message };
    const line = JSON.stringify(record) + "\n";
    appendFileSync(this.file, line);
    this.keep(record, Buffer.byteLength(line));
    return record;
  }

  /** Every record after `seq` that memory holds, in order; see `windowStart` for where that begins. */
  since(seq: number): AgentRecord[] {
    let lo = 0;
    let hi = this.window.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.window[mid]!.seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return this.window.slice(lo);
  }

  /** The seq memory's window follows on from: it holds every record after this one. */
  windowStart(): number {
    return this.window.length === 0 ? this.lastSeq : this.window[0]!.seq - 1;
  }

  /** The last record's seq, 0 when the log is empty. */
  seq(): number {
    return this.lastSeq;
  }

  private keep(record: AgentRecord, bytes: number): void {
    this.lastSeq = record.seq;
    this.window.push(record);
    this.sizes.push(bytes);
    this.windowBytes += bytes;
    let drop = 0;
    while (this.window.length - drop > 1
      && (this.window.length - drop > this.maxRecords || this.windowBytes > this.maxBytes)) {
      this.windowBytes -= this.sizes[drop]!;
      drop++;
    }
    if (drop > 0) {
      this.window.splice(0, drop);
      this.sizes.splice(0, drop);
    }
    this.observe(record);
  }
}
