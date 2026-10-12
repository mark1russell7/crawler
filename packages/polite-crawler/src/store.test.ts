import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import type { DamagedLine } from "./log.ts";
import { CaptureLog } from "./log.ts";
import type { CaptureRecord } from "./record.ts";
import { makeRecord } from "./record.ts";
import { removeDir, tempDir } from "./test-helpers.ts";

let dir: string | undefined;
const logs: CaptureLog[] = [];
afterEach(async () => {
  for (const log of logs.splice(0)) await log.close();
  if (dir !== undefined) await removeDir(dir);
  dir = undefined;
});

const record = (at: string, source = "fetch", extra: Record<string, unknown> = {}): CaptureRecord =>
  makeRecord({ source, kind: "capture", payload: { url: "https://x.example/", ...extra }, received_at: at });

const scanAll = async (log: CaptureLog, damaged: DamagedLine[] = [], since?: string) => {
  const rows: CaptureRecord[] = [];
  for await (const row of log.scan(since === undefined ? undefined : { since }, { onDamaged: (line) => damaged.push(line) })) {
    rows.push(row);
  }
  return rows;
};

describe("the capture log", () => {
  it("starts an append on a new line after a torn last line, and skips the torn line as damage", async () => {
    dir = await tempDir("log");
    const shard = join(dir, "fetch", "2026");
    await mkdir(shard, { recursive: true });
    const first = record("2026-10-07T11:00:00.000Z");
    await writeFile(join(shard, "10.ndjson"), `${JSON.stringify(first)}\n{"torn":`, "utf8");
    const log = new CaptureLog(dir);
    logs.push(log);
    await log.append(record("2026-10-07T12:00:00.000Z"));
    await log.append({ ...record("2026-10-07T12:00:01.000Z"), id: "fetch.second" });
    await log.close();
    const lines = (await readFile(join(shard, "10.ndjson"), "utf8")).split("\n");
    // the log removes nothing: the torn line stays, and a line break ends it
    expect(lines[1]).toBe('{"torn":');
    const damaged: DamagedLine[] = [];
    const rows = await scanAll(log, damaged);
    expect(rows.map((row) => row.id)).toEqual([first.id, record("2026-10-07T12:00:00.000Z").id, "fetch.second"]);
    expect(damaged).toEqual([{ path: join(shard, "10.ndjson"), line: 2 }]);
  });

  it("skips and counts a damaged line in the middle of a file, and reads the lines after it", async () => {
    dir = await tempDir("log");
    const shard = join(dir, "fetch", "2026");
    await mkdir(shard, { recursive: true });
    const a = record("2026-10-07T11:00:00.000Z");
    const b = record("2026-10-07T11:00:02.000Z", "fetch", { n: 2 });
    // an invalid byte and a glued fragment, as a crash of a different process leaves them
    const bytes = Buffer.concat([
      Buffer.from(`${JSON.stringify(a)}\n`),
      Buffer.from([0xff, 0xfe, 0x0a]),
      Buffer.from(`{"id{"id":"x"}\n${JSON.stringify(b)}\n`),
    ]);
    await writeFile(join(shard, "10.ndjson"), bytes);
    const log = new CaptureLog(dir);
    logs.push(log);
    const damaged: DamagedLine[] = [];
    expect((await scanAll(log, damaged)).map((row) => row.id)).toEqual([a.id, b.id]);
    expect(damaged.map((line) => line.line)).toEqual([2, 3]);
  });

  it("skips the files of the months before since, and merges two sources in the sequence of time", async () => {
    dir = await tempDir("log");
    await mkdir(join(dir, "fetch", "2026"), { recursive: true });
    // an old month that is garbage: a scan with since never reads it
    await writeFile(join(dir, "fetch", "2026", "01.ndjson"), "garbage\n", "utf8");
    const log = new CaptureLog(dir);
    logs.push(log);
    await log.append(record("2026-10-07T12:00:02.000Z", "fetch"));
    await log.append(record("2026-10-07T12:00:01.000Z", "watch"));
    await log.append(record("2026-10-07T12:00:03.000Z", "watch"));
    const damaged: DamagedLine[] = [];
    const rows = await scanAll(log, damaged, "2026-10-01T00:00:00.000Z");
    expect(rows.map((row) => [row.source, row.received_at])).toEqual([
      ["watch", "2026-10-07T12:00:01.000Z"],
      ["fetch", "2026-10-07T12:00:02.000Z"],
      ["watch", "2026-10-07T12:00:03.000Z"],
    ]);
    expect(damaged).toEqual([]);
    const all: DamagedLine[] = [];
    await scanAll(log, all);
    expect(all).toHaveLength(1);
  });

  it("writes many appends at the same time as whole lines, in batches", async () => {
    dir = await tempDir("log");
    const log = new CaptureLog(dir);
    logs.push(log);
    const appended = Array.from({ length: 300 }, (_, index) =>
      record(`2026-10-07T12:00:00.000Z`, "fetch", { index, pad: "x".repeat(index * 10) }),
    );
    await Promise.all(appended.map((row) => log.append(row)));
    const damaged: DamagedLine[] = [];
    const rows = await scanAll(log, damaged);
    expect(rows).toHaveLength(300);
    expect(damaged).toEqual([]);
  });

  it("writes the same lines from two logs on one folder, as two processes do", async () => {
    dir = await tempDir("log");
    const one = new CaptureLog(dir);
    const two = new CaptureLog(dir);
    logs.push(one, two);
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        (index % 2 === 0 ? one : two).append(record("2026-10-07T12:00:00.000Z", "fetch", { index })),
      ),
    );
    await one.close();
    await two.close();
    const damaged: DamagedLine[] = [];
    expect(await scanAll(one, damaged)).toHaveLength(100);
    expect(damaged).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("makes its files for the owner only", async () => {
    dir = await tempDir("log");
    const log = new CaptureLog(dir);
    logs.push(log);
    await log.append(record("2026-10-07T12:00:00.000Z"));
    expect((await stat(join(dir, "fetch", "2026", "10.ndjson"))).mode & 0o077).toBe(0);
  });
});

describe("the blob store", () => {
  const bytes = new TextEncoder().encode("same ".repeat(1000));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const pathOf = (root: string) => join(root, hash.slice(0, 2), hash.slice(2, 4), hash);

  it("stores the same bytes from many writers at once", async () => {
    dir = await tempDir("blobs");
    for (let round = 0; round < 20; round += 1) {
      const root = join(dir, String(round));
      // two stores on one folder act as two processes: they share no state
      const stores = [new FileBlobStore(root), new FileBlobStore(root), new FileBlobStore(root)];
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) => stores[index % 3]!.put(bytes)),
      );
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
      expect(new TextDecoder().decode(await stores[0]!.get(hash))).toBe("same ".repeat(1000));
      // no temporary file stays
      expect(await readdir(join(root, hash.slice(0, 2), hash.slice(2, 4)))).toEqual([hash]);
    }
  });

  it("writes a torn blob again, and never gives a damaged blob as the body", async () => {
    dir = await tempDir("blobs");
    const store = new FileBlobStore(dir);
    await mkdir(join(dir, hash.slice(0, 2), hash.slice(2, 4)), { recursive: true });
    await writeFile(pathOf(dir), "");
    expect(await store.get(hash)).toBeUndefined();
    expect(await store.put(bytes)).toEqual({ hash, existed: false });
    expect((await store.get(hash))?.length).toBe(bytes.length);
    // a file of the right size with the wrong bytes moves away on the first get
    await writeFile(pathOf(dir), new Uint8Array(bytes.length));
    expect(await store.get(hash)).toBeUndefined();
    expect(await store.put(bytes)).toEqual({ hash, existed: false });
    expect((await store.get(hash))?.length).toBe(bytes.length);
  });

  it("gives nothing for a name that is not a hash", async () => {
    dir = await tempDir("blobs");
    const store = new FileBlobStore(dir);
    expect(await store.get("../../etc/passwd")).toBeUndefined();
    expect(await store.get("")).toBeUndefined();
  });
});
