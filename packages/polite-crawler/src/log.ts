import { createReadStream, existsSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CaptureRecord } from "./record.ts";

/** A scan filter selects the records of one source, one kind, or the records after one time. */
export interface CaptureFilter {
  readonly source?: string | undefined;
  readonly kind?: string | undefined;
  /** This value is an ISO 8601 time. The scan gives the records received at this time or later. */
  readonly since?: string | undefined;
}

/** A damaged line is a line of the log that is not a record: a torn append, or bytes that a crash left. */
export interface DamagedLine {
  /** This value is the path of the file. */
  readonly path: string;
  /** This value is the number of the line in the file, from 1. */
  readonly line: number;
}

/** These options change a scan. */
export interface ScanOptions {
  /** The scan skips a damaged line, and it gives the line to this function. */
  readonly onDamaged?: ((damaged: DamagedLine) => void) | undefined;
}

/** The read side of the capture log is what `reindex` replays. */
export interface CaptureReader {
  scan(filter?: CaptureFilter, options?: ScanOptions): AsyncIterable<CaptureRecord>;
}

/** These options change a capture log. */
export interface CaptureLogOptions {
  /**
   * When this value is true (the default), the log writes each batch of appends to the disk
   * (`fdatasync`) before the appends finish. Thus a power cut does not lose a record that the
   * crawler reported.
   */
  readonly sync?: boolean | undefined;
}

interface Pending {
  readonly path: string;
  readonly line: string;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const MONTH_FILE = /^(\d{2})(?:\.[^.]+)?\.ndjson$/;
const YEAR_DIR = /^\d{4}$/;
const NEWLINE = 0x0a;

/** This function writes the whole buffer. A write to a file can write less than the buffer, and the loop writes the rest. */
const writeAll = async (handle: FileHandle, bytes: Buffer): Promise<void> => {
  let at = 0;
  while (at < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, at, bytes.length - at);
    at += bytesWritten;
  }
};

/**
 * This function reads a file line by line, as bytes, so a long file does not become one string. It
 * gives each line and tells if a line break ends it.
 */
async function* linesOf(
  path: string,
): AsyncGenerator<{ readonly text: string; readonly complete: boolean }> {
  const decoder = new TextDecoder("utf-8");
  let rest: Buffer | undefined;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    const data = rest === undefined ? chunk : Buffer.concat([rest, chunk]);
    rest = undefined;
    let start = 0;
    for (;;) {
      const end = data.indexOf(NEWLINE, start);
      if (end === -1) break;
      yield { text: decoder.decode(data.subarray(start, end)), complete: true };
      start = end + 1;
    }
    if (start < data.length) rest = Buffer.from(data.subarray(start));
  }
  if (rest !== undefined && rest.length > 0) yield { text: decoder.decode(rest), complete: false };
}

const monthKey = (year: string, file: string): string =>
  `${year}-${MONTH_FILE.exec(file)?.[1] ?? "00"}`;

/**
 * The capture log keeps each fetch decision as one line of JSON in
 * `<dir>/<source>/<yyyy>/<mm>.ndjson`. It is the record of each access that the crawler makes.
 *
 * These are the rules of the log:
 *
 * - The log appends a batch of records with one write, and it writes the batch to the disk before
 *   the appends finish.
 * - An append always starts on a new line. After a crash leaves a partial line, the next append
 *   starts after a line break. The partial line stays as a damaged line, and the record is good.
 * - A scan reads each file as a stream. It skips a damaged line, counts it, and continues.
 * - The log does not remove or change a line.
 *
 * Two processes can append to one log, because each batch is one write to a file in append mode.
 */
export class CaptureLog implements CaptureReader {
  private readonly handles = new Map<string, FileHandle>();
  private readonly pending: Pending[] = [];
  private draining: Promise<void> | undefined;
  private readonly sync: boolean;

  constructor(
    readonly dir: string,
    options: CaptureLogOptions = {},
  ) {
    this.sync = options.sync ?? true;
  }

  private pathOf(record: CaptureRecord): string {
    return join(
      this.dir,
      record.source,
      record.received_at.slice(0, 4),
      `${record.received_at.slice(5, 7)}.ndjson`,
    );
  }

  private async handleFor(path: string): Promise<FileHandle> {
    const known = this.handles.get(path);
    if (known !== undefined) return known;
    // the folders and the files are for the owner only, where the system has modes
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "a+", 0o600);
    this.handles.set(path, handle);
    return handle;
  }

  /** This method tells if the last byte of a file is not a line break: a partial line that a crash left. */
  private static async needsBreak(handle: FileHandle): Promise<boolean> {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== NEWLINE;
  }

  append(record: CaptureRecord): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ path: this.pathOf(record), line, resolve, reject });
      this.kick();
    });
  }

  /** This method starts the writer when it is not in progress. A record that comes as the writer stops starts it again. */
  private kick(): void {
    if (this.draining !== undefined) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.pending.length > 0) this.kick();
    });
  }

  /** This method writes the waiting records in batches: one write and one sync for each file. */
  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0);
      const byPath = new Map<string, Pending[]>();
      for (const item of batch) {
        const list = byPath.get(item.path);
        if (list === undefined) byPath.set(item.path, [item]);
        else list.push(item);
      }
      for (const [path, items] of byPath) {
        try {
          const handle = await this.handleFor(path);
          const lead = (await CaptureLog.needsBreak(handle)) ? "\n" : "";
          await writeAll(
            handle,
            Buffer.from(`${lead}${items.map((item) => item.line).join("")}`, "utf8"),
          );
          if (this.sync) await handle.datasync();
          for (const item of items) item.resolve();
        } catch (error) {
          // a handle that failed is opened again for the next append
          const handle = this.handles.get(path);
          this.handles.delete(path);
          await handle?.close().catch(() => undefined);
          for (const item of items) item.reject(error);
        }
      }
    }
  }

  /** This method waits until each append in progress is on the disk. */
  async flush(): Promise<void> {
    while (this.draining !== undefined) await this.draining;
  }

  /** This method gives the record files of one source, in the sequence of time. It skips the months before `since`. */
  private async filesOf(source: string, since: string | undefined): Promise<string[]> {
    const sourceDir = join(this.dir, source);
    if (!existsSync(sourceDir)) return [];
    const from = since?.slice(0, 7);
    const years = (await readdir(sourceDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && YEAR_DIR.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const files: string[] = [];
    for (const year of years) {
      if (from !== undefined && year < from.slice(0, 4)) continue;
      const months = (await readdir(join(sourceDir, year)))
        .filter((name) => MONTH_FILE.test(name))
        .sort();
      for (const month of months) {
        if (from !== undefined && monthKey(year, month) < from) continue;
        files.push(join(sourceDir, year, month));
      }
    }
    return files;
  }

  /** This method reads the records of one source in the sequence of the files. */
  private async *readSource(
    source: string,
    filter: CaptureFilter | undefined,
    options: ScanOptions | undefined,
  ): AsyncGenerator<CaptureRecord> {
    for (const path of await this.filesOf(source, filter?.since)) {
      let number = 0;
      for await (const { text, complete } of linesOf(path)) {
        number += 1;
        const trimmed = text.trim();
        if (trimmed.length === 0) continue;
        let row: CaptureRecord;
        try {
          row = JSON.parse(trimmed) as CaptureRecord;
          if (typeof row !== "object" || row === null || typeof row.received_at !== "string") {
            throw new Error("not a record");
          }
        } catch {
          // the append of a different process can be in progress at the end of the file
          if (complete) options?.onDamaged?.({ path, line: number });
          continue;
        }
        if (filter?.kind !== undefined && row.kind !== filter.kind) continue;
        if (filter?.since !== undefined && row.received_at < filter.since) continue;
        yield row;
      }
    }
  }

  /**
   * This method reads the records that agree with the filter. It first waits for the appends that
   * are in progress. It reads each file as a stream, so its memory does not grow with the log.
   *
   * The records of one source come in the sequence of the files. The records of two or more sources
   * merge in the sequence of `received_at`.
   */
  async *scan(filter?: CaptureFilter, options?: ScanOptions): AsyncIterable<CaptureRecord> {
    await this.flush();
    const sources =
      filter?.source !== undefined
        ? [filter.source]
        : existsSync(this.dir)
          ? (await readdir(this.dir, { withFileTypes: true }))
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
              .sort()
          : [];
    if (sources.length === 1) {
      yield* this.readSource(sources[0]!, filter, options);
      return;
    }
    // a merge of the sources: the next record is the earliest head
    const streams = sources.map((source) =>
      this.readSource(source, filter, options)[Symbol.asyncIterator](),
    );
    const heads: Array<CaptureRecord | undefined> = [];
    for (const stream of streams)
      heads.push((await stream.next()).value as CaptureRecord | undefined);
    for (;;) {
      let pick = -1;
      for (const [index, head] of heads.entries()) {
        if (head !== undefined && (pick === -1 || head.received_at < heads[pick]!.received_at)) {
          pick = index;
        }
      }
      if (pick === -1) return;
      yield heads[pick]!;
      heads[pick] = (await streams[pick]!.next()).value as CaptureRecord | undefined;
    }
  }

  /** This method writes the appends in progress, then closes the files. A later append opens them again. */
  async close(): Promise<void> {
    await this.flush();
    const handles = [...this.handles.values()];
    this.handles.clear();
    for (const handle of handles) await handle.close();
  }
}
