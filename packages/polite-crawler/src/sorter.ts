import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const NEWLINE = 0x0a;

/** This function compares two lines by their bytes. */
const byBytes = (a: Buffer, b: Buffer): number => Buffer.compare(a, b);

/** This function reads a file line by line, as bytes. A line holds no line break. */
async function* linesOf(path: string): AsyncGenerator<Buffer> {
  let rest: Buffer | undefined;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    const data = rest === undefined ? chunk : Buffer.concat([rest, chunk]);
    rest = undefined;
    let start = 0;
    for (;;) {
      const end = data.indexOf(NEWLINE, start);
      if (end === -1) break;
      yield data.subarray(start, end);
      start = end + 1;
    }
    if (start < data.length) rest = Buffer.from(data.subarray(start));
  }
  if (rest !== undefined && rest.length > 0) yield rest;
}

/**
 * A line sorter sorts lines of text in the sequence of their UTF-8 bytes (the sequence of
 * `LC_ALL=C sort`). It keeps no more than `limit` bytes of lines in memory. When it has more, it
 * writes them to a sorted file in `dir`. At the end it merges the files. Thus its memory does not
 * grow with the count of lines. The WACZ export sorts its index and its page list with it.
 *
 * A line must not hold a line break.
 */
export class LineSorter {
  private lines: Buffer[] = [];
  private bytes = 0;
  private readonly runs: string[] = [];

  constructor(
    private readonly dir: string,
    private readonly limit: number = 8 * 1024 * 1024,
  ) {}

  /** This value is the count of sorted files that the sorter wrote. */
  get files(): number {
    return this.runs.length;
  }

  async add(line: string): Promise<void> {
    const bytes = Buffer.from(line, "utf8");
    if (bytes.includes(NEWLINE)) throw new Error("a line to sort holds a line break");
    this.lines.push(bytes);
    // each line also costs an object in memory, so the count adds a little for each line
    this.bytes += bytes.length + 64;
    if (this.bytes >= this.limit) await this.spill();
  }

  private async spill(): Promise<void> {
    if (this.lines.length === 0) return;
    this.lines.sort(byBytes);
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${String(this.runs.length)}.lines`);
    const parts: Buffer[] = [];
    const newline = Buffer.from([NEWLINE]);
    for (const line of this.lines) parts.push(line, newline);
    await writeFile(path, Buffer.concat(parts), { mode: 0o600 });
    this.runs.push(path);
    this.lines = [];
    this.bytes = 0;
  }

  /** This method gives each line in the sorted sequence. Use it one time, after the last `add`. */
  async *sorted(): AsyncGenerator<Buffer> {
    if (this.runs.length === 0) {
      const lines = this.lines.sort(byBytes);
      this.lines = [];
      yield* lines;
      return;
    }
    await this.spill();
    const readers = this.runs.map((path) => linesOf(path)[Symbol.asyncIterator]());
    const heads: Array<Buffer | undefined> = [];
    for (const reader of readers) heads.push((await reader.next()).value ?? undefined);
    for (;;) {
      let pick = -1;
      for (const [at, head] of heads.entries()) {
        if (head !== undefined && (pick === -1 || Buffer.compare(head, heads[pick]!) < 0))
          pick = at;
      }
      if (pick === -1) return;
      yield heads[pick]!;
      heads[pick] = (await readers[pick]!.next()).value ?? undefined;
    }
  }
}
