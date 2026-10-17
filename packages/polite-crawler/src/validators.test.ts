import type { IncomingHttpHeaders, Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "./blobs.ts";
import type { CrawlerOptions } from "./crawler.ts";
import { Crawler } from "./crawler.ts";
import { DocIndex } from "./docs.ts";
import { SqliteHostStateStore } from "./hoststate.ts";
import { CaptureLog } from "./log.ts";
import type { ValidatorMemo, ValidatorReport } from "./politeness.ts";
import {
  MemoryHostStateStore,
  VALIDATOR_MEMO,
  nextValidatorMemo,
  validatorsToSend,
} from "./politeness.ts";
import type { CaptureRecord } from "./record.ts";
import { removeDir, tempDir } from "./test-helpers.ts";

// The validator memo (finding A-13). A server examines If-None-Match first and ignores
// If-Modified-Since with it (RFC 9110, section 13.1.3), so a host with unstable ETags never
// answers 304 to a request with the two. The memo learns that, and sends the date alone.

const cleanups: Array<() => Promise<void> | void> = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

const LAST_MODIFIED = "Wed, 01 Oct 2025 08:00:00 GMT";

/**
 * A server with a stable Last-Modified date. Its ETag differs at each request (each answer comes
 * from a different edge node) until `site.stable` is true. It applies the order of RFC 9110:
 * If-None-Match first, and If-Modified-Since only without it.
 */
const unstableSite = async () => {
  const hits: Array<{ readonly headers: IncomingHttpHeaders; readonly status: number }> = [];
  const state = { stable: false };
  const server = createServer((request, response) => {
    const etag = state.stable ? '"stable"' : `"edge-${String(hits.length)}"`;
    const inm = request.headers["if-none-match"];
    const ims = request.headers["if-modified-since"];
    const notModified =
      inm !== undefined
        ? inm === etag
        : ims !== undefined && Date.parse(ims) >= Date.parse(LAST_MODIFIED);
    hits.push({ headers: request.headers, status: notModified ? 304 : 200 });
    if (notModified) {
      response.writeHead(304, { etag, "last-modified": LAST_MODIFIED });
      response.end();
      return;
    }
    response.writeHead(200, {
      etag,
      "last-modified": LAST_MODIFIED,
      "content-type": "text/plain",
    });
    response.end("The menu is the same each day.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, hits, state };
};

const storeIn = async (): Promise<string> => {
  const dir = await tempDir("validators");
  cleanups.push(() => removeDir(dir));
  return dir;
};

const crawlerIn = (dir: string, options: Partial<CrawlerOptions> = {}) => {
  const log = new CaptureLog(join(dir, "captures"));
  const index = new DocIndex(join(dir, "index.sqlite"));
  const crawler = new Crawler({
    token: "PoliteCrawler",
    userAgent: "PoliteCrawler/0.1 (test)",
    log,
    blobs: new FileBlobStore(join(dir, "blobs")),
    index,
    random: () => 0.5,
    egress: { allowPrivate: true },
    ...options,
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await crawler.close();
    await log.close();
    index.close();
  };
  cleanups.push(close);
  // minIntervalMs 0: the host needs no rest between the requests of the test
  const revisit = (url: string) =>
    crawler.fetch({ url, mode: "api", recipe: "t", maxAgeMs: 0, minIntervalMs: 0 });
  const captures = async (): Promise<CaptureRecord[]> => {
    const rows: CaptureRecord[] = [];
    for await (const row of new CaptureLog(join(dir, "captures")).scan({ source: "fetch" }))
      rows.push(row);
    return rows;
  };
  return { crawler, revisit, captures, close };
};

const sent = (headers: IncomingHttpHeaders): string[] =>
  ["if-none-match", "if-modified-since"].filter((name) => headers[name] !== undefined);

const report = (
  answer: ValidatorReport["answer"],
  etag = true,
  lastModified = true,
): ValidatorReport => ({ etag, lastModified, answer });

const replay = (reports: readonly ValidatorReport[], now = 0): ValidatorMemo | undefined =>
  reports.reduce<ValidatorMemo | undefined>(
    (memo, one) => nextValidatorMemo(memo, one, now),
    undefined,
  );

const BOTH = { etag: true, lastModified: true };

describe("the rules of the validator memo", () => {
  it("stops the ETag after the same body comes back three times, and sends the date alone", () => {
    const two = replay([report("same"), report("same")]);
    expect(two).toMatchObject({ skipEtag: false, etagMisses: 2 });
    expect(validatorsToSend(two, BOTH, 0)).toEqual(BOTH);
    const three = nextValidatorMemo(two, report("same"), 5000);
    expect(three).toMatchObject({ skipEtag: true, etag: "fails", changedAt: 5000 });
    expect(validatorsToSend(three, BOTH, 6000)).toEqual({ etag: false, lastModified: true });
    // a copy with no Last-Modified date keeps its ETag, because nothing else can give a 304
    expect(validatorsToSend(three, { etag: true, lastModified: false }, 6000)).toEqual({
      etag: true,
      lastModified: false,
    });
    // a 304 to the date alone marks the date as the validator that works
    expect(nextValidatorMemo(three, report("not-modified", false), 7000)).toMatchObject({
      skipEtag: true,
      lastModified: "works",
      sinceProbe: 1,
    });
  });

  it("counts only the same body: a 304 starts the count again, and a changed body tells nothing", () => {
    const memo = replay([
      report("same"),
      report("same"),
      report("not-modified"),
      report("same"),
      report("changed"),
      report("same"),
    ]);
    expect(memo).toMatchObject({ skipEtag: false, etag: "works", etagMisses: 2 });
  });

  it("does not stop the ETag of a host that sends no Last-Modified date", () => {
    const memo = replay([
      report("same", true, false),
      report("same", true, false),
      report("same", true, false),
    ]);
    expect(memo).toMatchObject({ skipEtag: false, etag: "fails", etagMisses: 3 });
  });

  it("probes the ETag after a number of requests or after an age, and starts it again on a 304", () => {
    const off = replay([report("same"), report("same"), report("same")], 1000)!;
    let memo = off;
    for (let at = 0; at < VALIDATOR_MEMO.probeEvery - 1; at += 1)
      memo = nextValidatorMemo(memo, report("not-modified", false), 2000);
    expect(validatorsToSend(memo, BOTH, 2000)).toEqual({ etag: false, lastModified: true });
    memo = nextValidatorMemo(memo, report("not-modified", false), 2000);
    expect(validatorsToSend(memo, BOTH, 2000)).toEqual(BOTH);
    // the age gives a probe too, also with few requests
    expect(validatorsToSend(off, BOTH, 1000 + VALIDATOR_MEMO.probeAgeMs - 1)).toEqual({
      etag: false,
      lastModified: true,
    });
    expect(validatorsToSend(off, BOTH, 1000 + VALIDATOR_MEMO.probeAgeMs)).toEqual(BOTH);
    // a probe that gets a 304 starts the ETag again
    const back = nextValidatorMemo(memo, report("not-modified"), 3000);
    expect(back).toMatchObject({ skipEtag: false, etag: "works", etagMisses: 0, changedAt: 3000 });
    expect(validatorsToSend(back, BOTH, 3000)).toEqual(BOTH);
  });

  it("keeps the ETag stopped after a probe that gets a 200, and waits for the next probe", () => {
    let memo = replay([report("same"), report("same"), report("same")], 1000)!;
    for (let at = 0; at < VALIDATOR_MEMO.probeEvery; at += 1)
      memo = nextValidatorMemo(memo, report("not-modified", false), 2000);
    for (const answer of ["same", "changed"] as const) {
      const after = nextValidatorMemo(memo, report(answer), 4000);
      expect(after).toMatchObject({ skipEtag: true, sinceProbe: 0, changedAt: 4000 });
      expect(validatorsToSend(after, BOTH, 4000)).toEqual({ etag: false, lastModified: true });
    }
  });

  it("sends the two validators again when neither works, and records it", () => {
    let memo = replay([report("same"), report("same"), report("same")], 1000)!;
    for (let at = 0; at < VALIDATOR_MEMO.misses; at += 1)
      memo = nextValidatorMemo(memo, report("same", false), 2000);
    expect(memo).toMatchObject({ skipEtag: false, etag: "fails", lastModified: "fails" });
    expect(validatorsToSend(memo, BOTH, 2000)).toEqual(BOTH);
    // more failures do not stop the ETag again at once, so the memo does not swing
    memo = nextValidatorMemo(memo, report("same"), 3000);
    expect(memo.skipEtag).toBe(false);
    // after probeAgeMs, the date alone gets a new try
    memo = nextValidatorMemo(memo, report("same"), 2000 + VALIDATOR_MEMO.probeAgeMs);
    expect(memo).toMatchObject({ skipEtag: true, dateMisses: 0 });
  });

  it("keeps the memos of the hosts used last in a store in memory", () => {
    const store = new MemoryHostStateStore(2);
    for (const host of ["a", "b", "c"]) store.noteValidators(host, report("same"), 0);
    store.noteValidators("b", report("same"), 0);
    store.noteValidators("d", report("same"), 0);
    expect(store.validators("a")).toBeUndefined();
    expect(store.validators("c")).toBeUndefined();
    expect(store.validators("b")).toMatchObject({ etagMisses: 2 });
    expect(store.validators("d")).toMatchObject({ etagMisses: 1 });
  });
});

describe("a host with unstable ETags", () => {
  it("gets 200 for the first revisits, then 304 when the crawler sends only the date", async () => {
    const site = await unstableSite();
    const { revisit, captures } = crawlerIn(await storeIn());
    const url = `${site.origin}/menu`;
    expect((await revisit(url)).outcome).toBe("ok");
    for (let at = 0; at < VALIDATOR_MEMO.misses; at += 1)
      expect((await revisit(url)).outcome).toBe("ok");
    const after = await revisit(url);
    expect(after).toMatchObject({ outcome: "not-modified", fromCache: false });
    expect(new TextDecoder().decode(after.body)).toBe("The menu is the same each day.");
    expect(site.hits.map((hit) => sent(hit.headers))).toEqual([
      [],
      ["if-none-match", "if-modified-since"],
      ["if-none-match", "if-modified-since"],
      ["if-none-match", "if-modified-since"],
      ["if-modified-since"],
    ]);
    expect(site.hits.map((hit) => hit.status)).toEqual([200, 200, 200, 200, 304]);
    // the capture log tells which validators each request sent
    const rows = await captures();
    expect(rows.map((row) => (row.payload as { validators?: string[] }).validators)).toEqual([
      undefined,
      ["if-none-match", "if-modified-since"],
      ["if-none-match", "if-modified-since"],
      ["if-none-match", "if-modified-since"],
      ["if-modified-since"],
    ]);
    expect(rows.at(-1)!.kind).toBe("revisit");
  });

  it("probes the ETag again, and sends it again when the host fixes it", async () => {
    const site = await unstableSite();
    const { revisit } = crawlerIn(await storeIn());
    const url = `${site.origin}/menu`;
    for (let at = 0; at <= VALIDATOR_MEMO.misses; at += 1) await revisit(url);
    // the host fixes its ETags; a 304 to the date carries the stable ETag into the store
    site.state.stable = true;
    for (let at = 0; at < VALIDATOR_MEMO.probeEvery; at += 1)
      expect((await revisit(url)).outcome).toBe("not-modified");
    const probe = await revisit(url);
    expect(probe.outcome).toBe("not-modified");
    const next = await revisit(url);
    expect(next.outcome).toBe("not-modified");
    const last = site.hits.slice(-3).map((hit) => hit.headers["if-none-match"]);
    expect(last).toEqual([undefined, '"stable"', '"stable"']);
  });

  it("keeps the memo in hosts.sqlite, so a new process sends the date alone at once", async () => {
    const site = await unstableSite();
    const dir = await storeIn();
    const url = `${site.origin}/menu`;
    const hostsFile = join(dir, "hosts.sqlite");
    const first = new SqliteHostStateStore(hostsFile);
    cleanups.push(() => first.close());
    const one = crawlerIn(dir, { hostState: first });
    for (let at = 0; at <= VALIDATOR_MEMO.misses; at += 1) await one.revisit(url);
    await one.close();
    first.close();
    const second = new SqliteHostStateStore(hostsFile);
    cleanups.push(() => second.close());
    const two = crawlerIn(dir, { hostState: second });
    expect((await two.revisit(url)).outcome).toBe("not-modified");
    expect(sent(site.hits.at(-1)!.headers)).toEqual(["if-modified-since"]);
  });

  it("sends the two validators when the memo fails, and the fetch goes on", async () => {
    const site = await unstableSite();
    const store = new MemoryHostStateStore();
    const broken = Object.assign(Object.create(store) as MemoryHostStateStore, {
      validators: () => {
        throw new Error("disk full");
      },
      noteValidators: () => {
        throw new Error("disk full");
      },
    });
    const { revisit } = crawlerIn(await storeIn(), { hostState: broken });
    const url = `${site.origin}/menu`;
    for (let at = 0; at <= VALIDATOR_MEMO.misses + 1; at += 1)
      expect((await revisit(url)).outcome).toBe("ok");
    expect(sent(site.hits.at(-1)!.headers)).toEqual(["if-none-match", "if-modified-since"]);
  });
});
