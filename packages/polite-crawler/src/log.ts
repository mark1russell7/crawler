import { existsSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, readdir, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CaptureRecord } from "./record.ts";

/** A scan filter selects the records of one source, one kind, or the records after one time. */
export interface CaptureFilter {
  readonly source?: string | undefined;
  readonly kind?: string | undefined;
  /** This value is an ISO 8601 time. The scan gives the records received at this time or later. */
  readonly since?: string | undefined;
}

/** The read side of the capture log is what `reindex` replays. */
export interface CaptureReader {
  scan(filter?: CaptureFilter): AsyncIterable<CaptureRecord>;
}

/**
 * The capture log keeps each fetch decision as one line of JSON in
 * `<dir>/<source>/<yyyy>/<mm>.ndjson`. It is the record of each access that the crawler makes.
 *
 * A crawl appends thousands of lines, so the log keeps each file open. The log repairs a file when
 * it first opens it. A crash during an append can leave a partial last line, and the log removes
 * it. One process writes the log, and the appends go in sequence.
 */
export class CaptureLog implements CaptureReader {
  private readonly handles = new Map<string, FileHandle>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  private async handleFor(record: CaptureRecord): Promise<FileHandle> {
    const path = join(
      this.dir,
      record.source,
      record.received_at.slice(0, 4),
      `${record.received_at.slice(5, 7)}.ndjson`,
    );
    const known = this.handles.get(path);
    if (known !== undefined) return known;
    await mkdir(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const text = await readFile(path, "utf8");
      if (text.length > 0 && !text.endsWith("\n")) {
        // a crash during an append: the partial line never completed
        await truncate(path, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1), "utf8"));
      }
    }
    const handle = await open(path, "a");
    this.handles.set(path, handle);
    return handle;
  }

  append(record: CaptureRecord): Promise<void> {
    const next = this.chain.then(async () => {
      const handle = await this.handleFor(record);
      await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async readSource(source: string): Promise<CaptureRecord[]> {
    const sourceDir = join(this.dir, source);
    if (!existsSync(sourceDir)) return [];
    const rows: CaptureRecord[] = [];
    const years = (await readdir(sourceDir, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
    for (const year of years) {
      const yearDir = join(sourceDir, year.name);
      const months = (await readdir(yearDir)).filter((name) => name.endsWith(".ndjson")).sort();
      for (const month of months) {
        const path = join(yearDir, month);
        const lines = (await readFile(path, "utf8")).split("\n");
        for (const [index, line] of lines.entries()) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            rows.push(JSON.parse(trimmed) as CaptureRecord);
          } catch (cause) {
            // a partial last line is an append that a crash stopped; a bad line before it is damage
            if (lines.slice(index + 1).every((rest) => rest.trim().length === 0)) break;
            throw new Error(`a damaged capture line at ${path}:${String(index + 1)}`, { cause });
          }
        }
      }
    }
    return rows;
  }

  /**
   * This method reads the records that agree with the filter, in the sequence of their receipt.
   * It first waits for the appends that are in progress.
   */
  async *scan(filter?: CaptureFilter): AsyncIterable<CaptureRecord> {
    await this.chain;
    const sources =
      filter?.source !== undefined
        ? [filter.source]
        : existsSync(this.dir)
          ? (await readdir(this.dir, { withFileTypes: true }))
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
          : [];
    const rows: CaptureRecord[] = [];
    for (const source of sources) rows.push(...(await this.readSource(source)));
    rows.sort((a, b) => a.received_at.localeCompare(b.received_at));
    for (const row of rows) {
      if (filter?.kind !== undefined && row.kind !== filter.kind) continue;
      if (filter?.since !== undefined && row.received_at < filter.since) continue;
      yield row;
    }
  }

  async close(): Promise<void> {
    await this.chain;
    for (const handle of this.handles.values()) await handle.close();
    this.handles.clear();
  }
}
