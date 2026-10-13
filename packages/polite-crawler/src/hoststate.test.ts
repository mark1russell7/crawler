import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import { Crawler } from "./crawler.ts";
import { DocIndex } from "./docs.ts";
import { SqliteHostStateStore } from "./hoststate.ts";
import { CaptureLog } from "./log.ts";
import { DEFAULT_POLICY, restAfter } from "./politeness.ts";
import { removeDir, tempDir } from "./test-helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const storeIn = async (): Promise<string> => {
  const dir = await tempDir("hosts");
  cleanups.push(() => removeDir(dir));
  return dir;
};

const open = (path: string, pollMs?: number): SqliteHostStateStore => {
  const store = new SqliteHostStateStore(path, pollMs === undefined ? {} : { pollMs });
  cleanups.push(() => store.close());
  return store;
};

describe("the SQLite host state store", () => {
  it("gives the slot to one holder at a time, and keeps the pace through a reset", async () => {
    const store = open(join(await storeIn(), "hosts.sqlite"));
    expect(store.reserve("a", 0, 100)).toBe(0);
    // the holder of the lease waits for its end, as the store in memory does
    expect(store.reserve("a", 10, 100)).toBe(90);
    store.release("a", 3000);
    expect(store.reserve("a", 1000, 100)).toBe(2000);
    expect(store.record("a", "failure")).toEqual({ failures: 1, waits: 0 });
    expect(store.record("a", "wait")).toEqual({ failures: 1, waits: 1 });
    expect(store.record("a", "neutral")).toEqual({ failures: 1, waits: 1 });
    expect(store.record("a", "success")).toEqual({ failures: 0, waits: 0 });
    store.stop("a", 9000, "challenge");
    store.stop("a", 5000, "blocked");
    expect(store.stopped("a", 4000)).toEqual({ until: 9000, reason: "challenge" });
    expect(store.stopped("a", 9000)).toBeUndefined();
    store.stop("b", Number.POSITIVE_INFINITY, "blocked");
    expect(store.stopped("b", 9000)).toEqual({
      until: Number.POSITIVE_INFINITY,
      reason: "blocked",
    });
    store.defer("a", 4000);
    store.reset();
    expect(store.stopped("a", 4000)).toBeUndefined();
    expect(store.stopped("b", 4000)).toBeUndefined();
    expect(store.reserve("a", 3500, 100)).toBe(500);
  });

  it("shares the lease, the pace and the stops between two stores on one file, as two processes do", async () => {
    const path = join(await storeIn(), "hosts.sqlite");
    const one = open(path);
    const two = open(path);
    expect(one.reserve("a", 0, 300_000)).toBe(0);
    // the lease of a different process gives a short wait and a new question
    expect(two.reserve("a", 10, 300_000)).toBe(1000);
    // a release by a store that does not hold the lease does not end it
    two.release("a", 0);
    expect(two.reserve("a", 20, 300_000)).toBe(1000);
    one.release("a", 3000);
    expect(two.reserve("a", 1000, 100)).toBe(2000);
    expect(two.reserve("a", 3000, 100)).toBe(0);
    one.stop("a", 50_000, "challenge");
    expect(two.stopped("a", 4000)).toEqual({ until: 50_000, reason: "challenge" });
    expect(two.record("a", "failure")).toEqual({ failures: 1, waits: 0 });
    expect(one.record("a", "failure")).toEqual({ failures: 2, waits: 0 });
  });

  it("forgets idle hosts", async () => {
    const store = open(join(await storeIn(), "hosts.sqlite"));
    for (let index = 0; index < 1200; index += 1) {
      store.reserve(`host${String(index)}`, index, 1);
      store.release(`host${String(index)}`, index);
    }
    store.stop("kept", Number.POSITIVE_INFINITY, "blocked");
    expect(store.size).toBeLessThan(400);
    expect(store.stopped("kept", 2000)).toBeDefined();
  });
});

describe("two crawlers on one store", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("keep one pace for a host and share its stops", async () => {
    const dir = await storeIn();
    // the real clock: two processes share the time of the computer, not a clock of a test
    const seen: Array<{ readonly path: string; readonly at: number }> = [];
    const server = createServer((request, response) => {
      seen.push({ path: request.url ?? "", at: Date.now() });
      if (request.url === "/refuse") {
        response.writeHead(403);
        response.end();
        return;
      }
      response.end(`page ${request.url ?? ""}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const crawlerOn = (name: string): Crawler => {
      const log = new CaptureLog(join(dir, "captures"));
      const index = new DocIndex(join(dir, `index-${name}.sqlite`));
      const crawler = new Crawler({
        token: "PoliteCrawler",
        userAgent: "PoliteCrawler/0.1 (test)",
        log,
        blobs: new FileBlobStore(join(dir, "blobs")),
        index,
        random: () => 0.5,
        egress: { allowPrivate: true },
        politeness: { apiIntervalMs: 150 },
        hostState: open(join(dir, "hosts.sqlite"), 20),
      });
      cleanups.push(async () => {
        await crawler.close();
        index.close();
      });
      return crawler;
    };
    const a = crawlerOn("a");
    const b = crawlerOn("b");
    await Promise.all([
      ...[1, 2, 3].map((n) =>
        a.fetch({ url: `${origin}/a${String(n)}`, mode: "api", recipe: "t" }),
      ),
      ...[1, 2, 3].map((n) =>
        b.fetch({ url: `${origin}/b${String(n)}`, mode: "api", recipe: "t" }),
      ),
    ]);
    const times = seen.map((hit) => hit.at).sort((x, y) => x - y);
    expect(times).toHaveLength(6);
    // a timer of the system can fire a little early, so the test permits a few milliseconds
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(145);
    }
    // a stop that one crawler learns holds for the other
    expect((await a.fetch({ url: `${origin}/refuse`, mode: "api", recipe: "t" })).outcome).toBe(
      "blocked",
    );
    const after = await b.fetch({ url: `${origin}/b4`, mode: "api", recipe: "t" });
    expect(after).toMatchObject({ outcome: "skipped" });
    expect(after.note).toMatch(/^host stopped until .*: blocked$/);
  });
});

describe("the rest of a host", () => {
  it("is the interval, the crawl delay, the slow answer or the Retry-After, the longest", () => {
    expect(restAfter(DEFAULT_POLICY, { kind: "page", elapsedMs: 100 })).toEqual({
      ms: 3000,
      reason: "pace",
    });
    expect(restAfter(DEFAULT_POLICY, { kind: "api", elapsedMs: 10_000 })).toEqual({
      ms: 1000,
      reason: "pace",
    });
    expect(restAfter(DEFAULT_POLICY, { kind: "page", elapsedMs: 2000 })).toEqual({
      ms: 10_000,
      reason: "slow",
    });
    expect(restAfter(DEFAULT_POLICY, { kind: "render", elapsedMs: 60_000 })).toEqual({
      ms: 30_000,
      reason: "slow",
    });
    expect(
      restAfter(DEFAULT_POLICY, { kind: "page", elapsedMs: 0, crawlDelaySeconds: 10 }),
    ).toEqual({
      ms: 10_000,
      reason: "crawl-delay",
    });
    expect(
      restAfter(DEFAULT_POLICY, { kind: "page", elapsedMs: 0, crawlDelaySeconds: 3600 }).ms,
    ).toBe(60_000);
    expect(restAfter(DEFAULT_POLICY, { kind: "api", elapsedMs: 0, minIntervalMs: 200 })).toEqual({
      ms: 200,
      reason: "pace",
    });
    expect(
      restAfter(DEFAULT_POLICY, { kind: "page", elapsedMs: 0, retryAfterMs: 120_000 }),
    ).toEqual({
      ms: 120_000,
      reason: "retry-after",
    });
  });
});
