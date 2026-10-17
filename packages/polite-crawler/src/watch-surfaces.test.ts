import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { DiffResult } from "./diff.ts";
import { createMcpServer } from "./mcp.ts";
import type { PoliteCrawler } from "./open.ts";
import { realClock } from "./politeness.ts";
import type { ReadResult } from "./runtime.ts";
import { fakeClock } from "./test-helpers.ts";
import { removeDir, runCli, tempDir } from "./test-surfaces.ts";
import type { Reply } from "./test-site.ts";
import { htmlPage, pagesOf, testCrawler, testSite } from "./test-site.ts";
import type { WatchEntry, WatchEvent, WatchSummary } from "./watch.ts";

// The command line and the MCP tools of the time travel, the diff and the watch list. The command
// line runs in a child process on the real clock, so its tests fetch few pages. The MCP tests use
// the fake clock.

const SLOW = 60_000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const site = async (route: (path: string) => Reply | undefined, clock = realClock) => {
  const made = await testSite((path) => route(path), clock);
  cleanups.push(() => made.close());
  return made;
};

const store = async (): Promise<string> => {
  const dir = await tempDir("watch-cli");
  cleanups.push(() => removeDir(dir));
  return dir;
};

/** A page whose text the test changes. */
const changing = async (clock = realClock) => {
  const state = { text: "Hours: Tuesday to Sunday" };
  const made = await site(
    (path) => (path === "/" ? { type: "text/html", body: htmlPage(state.text) } : undefined),
    clock,
  );
  return { made, state, url: `${made.origin}/`, doc: `url:${made.origin}/` };
};

describe("the command line: watch, diff and read --at", () => {
  it(
    "gives 2 for a wrong command line, and opens no store",
    async () => {
      const dir = await store();
      const never = join(dir, "never");
      for (const [args, message] of [
        [["watch"], "watch wants add, remove, list or run"],
        [["watch", "start"], 'watch wants add, remove, list or run, not "start"'],
        [["watch", "add"], "watch add wants at least one URL"],
        [["watch", "list", "https://example.com/"], "watch list takes no URL"],
        [["watch", "add", "https://example.com/", "--every", "10m"], "--every wants 1h or more"],
        [["watch", "add", "https://example.com/", "--every", "soon"], "--every: not a duration"],
        [["watch", "list", "--every", "2h"], "--every is an option of watch add"],
        [["watch", "run", "--confirm", "1"], "--confirm is an option of watch add"],
        [
          ["watch", "add", "https://example.com/", "--budget", "1m"],
          "--budget is an option of watch run",
        ],
        [
          ["watch", "add", "https://example.com/", "--confirm", "3"],
          '--confirm is 1 or 2, not "3"',
        ],
        [["watch", "add", "https://example.com/", "--label", "bad"], "--label wants name=value"],
        [["watch", "add", "ftp://example.com/"], "watch add wants http or https URLs"],
        [["fetch", "https://example.com/", "--every", "1h"], "--every is an option of watch"],
        [
          ["read", "url:x", "--at", "soon"],
          '--at wants a time, such as 2026-10-01T12:00:00Z, not "soon"',
        ],
        [["diff", "url:x", "--at", "2026-10-01"], "--at is an option of read or verify"],
        [["diff", "url:x", "--from", "2026-13-45"], "--from wants a time"],
        [["diff", "url:x", "--to", " "], "--to wants a capture id or a time"],
        [["diff"], "diff wants one document id"],
      ] as const) {
        const ran = await runCli([...args, "--dir", never]);
        expect(ran.code, args.join(" ")).toBe(2);
        expect(ran.stderr).toContain(message);
      }
      expect(existsSync(never)).toBe(false);
    },
    SLOW,
  );

  it(
    "adds, lists, runs and removes a watch",
    async () => {
      const { made, url } = await changing();
      const dir = await store();
      const cli = (args: readonly string[]) =>
        runCli([...args, "--dir", dir, "--allow-private", "--no-browser"]);
      const added = await cli(["watch", "add", url, "--every", "2h", "--label", "k=v", "--json"]);
      expect(added.stderr).toBe("");
      expect(added.code).toBe(0);
      expect(JSON.parse(added.stdout)).toMatchObject([
        { url, every_ms: 2 * 3_600_000, labels: { k: "v" }, confirm: 2 },
      ]);
      const listed = await cli(["watch", "list"]);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain(url);
      expect(listed.stdout).toContain("every 2h");
      expect(listed.stdout).toContain("not checked yet");

      const ran = await cli(["watch", "run", "--budget", "1m", "--json"]);
      expect(ran.code).toBe(0);
      const out = JSON.parse(ran.stdout) as { events: WatchEvent[]; summary: WatchSummary };
      expect(out.events.map((event) => event.kind)).toEqual(["new"]);
      expect(out.summary).toMatchObject({ checked: 1, new: 1, due: 0, stopped: "done" });
      // nothing is due before two hours
      const again = await cli(["watch", "run"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("0 checked");
      expect(pagesOf(made)).toEqual(["/"]);
      const entries = JSON.parse((await cli(["watch", "list", "--json"])).stdout) as WatchEntry[];
      expect(entries[0]).toMatchObject({ checks: 1, last_kind: "new", doc: `url:${url}` });

      expect((await cli(["watch", "remove", url])).code).toBe(0);
      const gone = await cli(["watch", "remove", url]);
      expect(gone.code).toBe(1);
      expect(gone.stdout).toContain(`not on the list ${url}`);
      expect((await cli(["watch", "list"])).stdout).toContain("the watch list is empty");
    },
    SLOW,
  );

  it(
    "shows a diff, and reads and verifies the version of a time",
    async () => {
      const { state, url, doc } = await changing();
      const dir = await store();
      const cli = (args: readonly string[]) =>
        runCli([...args, "--dir", dir, "--allow-private", "--no-browser"]);
      expect((await cli(["fetch", url])).code).toBe(0);
      const between = new Date().toISOString();
      state.text = "Hours: Wednesday to Sunday";
      expect((await cli(["fetch", url, "--max-age", "0"])).code).toBe(0);

      const shown = await cli(["diff", doc]);
      expect(shown.stderr).toBe("");
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain("~ Hours: [-Tuesday-]{+Wednesday+} to Sunday");
      expect(shown.stdout).toMatch(
        /~ title: "Hours: Tuesday to Sunday" -> "Hours: Wednesday to Sunday"/,
      );
      const json = JSON.parse(
        (await cli(["diff", doc, "--to", between, "--json"])).stdout,
      ) as DiffResult;
      // the newest version at that time is the first version, so the two sides are one version
      expect(json.to.at).toBe(between);
      expect(json.from.capture).toBe(json.to.capture);

      const old = await cli(["read", doc, "--at", between, "--json"]);
      expect(old.code).toBe(0);
      const read = JSON.parse(old.stdout) as ReadResult;
      expect(read).toMatchObject({ at: between, before_first: false });
      expect(read.text).toContain("Tuesday");
      const text = await cli(["read", doc, "--at", between]);
      expect(text.stdout).toContain(`${read.capture} (${read.fetched_at})`);
      const early = await cli(["read", doc, "--at", "2020-01-01"]);
      expect(early.code).toBe(1);
      expect(early.stdout).toContain("has no version at 2020-01-01T00:00:00.000Z or before");
      expect((await cli(["verify", doc, "Tuesday to Sunday", "--at", between])).code).toBe(0);
      expect((await cli(["verify", doc, "Tuesday to Sunday"])).stdout).toContain(
        "(an earlier capture)",
      );
      const none = await cli(["verify", doc, "Tuesday to Sunday", "--at", "2020-01-01"]);
      expect(none.code).toBe(1);
      expect(none.stdout).toContain("has no version at");
    },
    SLOW,
  );
});

describe("the MCP tools crawl_diff and crawl_watch_list, and at", () => {
  const connect = async (crawler: PoliteCrawler) => {
    const server = createMcpServer(crawler);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      return {
        isError: result.isError === true,
        json: content[0]?.text ?? "",
        web: content[1]?.text ?? "",
        structured: result.structuredContent as Record<string, unknown> | undefined,
      };
    };
    return { client, call };
  };

  const local = async () => {
    const clock = fakeClock();
    const page = await changing(clock);
    const { crawler, close } = await testCrawler({ clock });
    cleanups.push(close);
    return { clock, ...page, crawler, ...(await connect(crawler)) };
  };

  it("lists the watched pages, and no tool adds a watch", async () => {
    const { client, call, crawler, url } = await local();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("crawl_watch_list");
    expect(names.filter((name) => /watch/.test(name))).toEqual(["crawl_watch_list"]);
    expect((await call("crawl_watch_list", {})).structured?.["entries"]).toEqual([]);
    await crawler.watch!.add(url, { every: "1h", scope: "private", labels: { lineage: "secret" } });
    const listed = await call("crawl_watch_list", {});
    expect(listed.isError).toBe(false);
    const entries = listed.structured?.["entries"] as Array<Record<string, unknown>>;
    expect(entries).toEqual([
      expect.objectContaining({ url, every_ms: 3_600_000, confirm: 2, checks: 0, pending: null }),
    ]);
    // the scope and the labels can name a private lineage
    expect(listed.json).not.toMatch(/private|secret|lineage/);
  });

  it("gives a diff with the page text in the envelope only, and reads and verifies at a time", async () => {
    const { call, crawler, clock, state, url, doc } = await local();
    const first = await crawler.fetch(url);
    clock.advance(86_400_000);
    state.text = "Hours: Wednesday to Sunday";
    await crawler.fetch(url, { maxAge: 0 });

    const diff = await call("crawl_diff", { doc });
    expect(diff.isError).toBe(false);
    expect(diff.structured).toMatchObject({
      doc,
      held_back: false,
      same: false,
      summary: { lines_changed: 1 },
      from: { capture: first.capture },
    });
    expect(diff.json).not.toMatch(/Tuesday|Wednesday/);
    expect(diff.web).toMatch(/^Text from web pages follows/);
    expect(diff.web).toContain("~ Hours: [-Tuesday-]{+Wednesday+} to Sunday");
    const pinned = await call("crawl_diff", { doc, from_at: first.fetched_at, to: first.capture });
    expect(pinned.structured).toMatchObject({ same: true, hunks: 0 });
    expect(
      (await call("crawl_diff", { doc, from: first.capture, from_at: first.fetched_at })).isError,
    ).toBe(true);
    expect((await call("crawl_diff", { doc: "url:https://none.example/" })).isError).toBe(true);

    const early = await call("crawl_read", { doc, at: "2026-01-01T00:00:00Z" });
    expect(early.structured).toMatchObject({
      before_first: true,
      at: "2026-01-01T00:00:00.000Z",
      capture: null,
      next_from: null,
    });
    expect(early.web).toBe("");
    const then = await call("crawl_read", { doc, at: first.fetched_at });
    expect(then.structured).toMatchObject({ capture: first.capture, before_first: false });
    expect(then.web).toContain("Tuesday");
    const verified = await call("crawl_verify", {
      doc,
      quote: "Tuesday to Sunday",
      at: first.fetched_at,
    });
    expect(verified.structured).toMatchObject({
      found: true,
      capture: first.capture,
      stale: false,
    });
    const both = await call("crawl_read", { doc, at: first.fetched_at, capture: first.capture });
    expect(both.isError).toBe(true);
  });
});
