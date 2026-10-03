// A worker's terminal output, kept as its trailing `capBytes` bytes and
// mirrored to a file so an attach after a restart still has something to
// paint. The cut never lands inside a UTF-8 sequence. Writes are batched:
// at most one per second while output arrives, plus one on `flush()`.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FLUSH_INTERVAL_MS = 1000;

/** The trailing `cap` bytes of `buf`, advanced past any UTF-8 continuation bytes at the cut. */
function trailing(buf: Buffer, cap: number): Buffer {
  if (buf.length <= cap) return buf;
  let start = buf.length - cap;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start);
}

export class Scrollback {
  private buf: Buffer = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly capBytes = 262144,
  ) {}

  /** Restores what the last flush wrote; a missing file means empty. */
  async load(): Promise<void> {
    try {
      this.buf = Buffer.from(trailing(await readFile(this.path), this.capBytes));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.buf = Buffer.alloc(0);
    }
  }

  push(data: string): void {
    if (data.length === 0) return;
    this.buf = Buffer.from(trailing(Buffer.concat([this.buf, Buffer.from(data, "utf8")]), this.capBytes));
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch((err) => console.warn(`scrollback: could not save worker output (${(err as Error).message})`));
      }, FLUSH_INTERVAL_MS);
      this.timer.unref();
    }
  }

  text(): string {
    return this.buf.toString("utf8");
  }

  /** Writes the current text now (temp file then rename), cancelling any pending batched write. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Chain writes so two flushes never race on the temp file.
    this.writing = this.writing.catch(() => {}).then(() => this.write());
    return this.writing;
  }

  private async write(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot = this.buf;
    const tmp = `${this.path}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmp, snapshot);
      await rename(tmp, this.path);
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }
}
