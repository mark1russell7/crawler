import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import type { HybridCrawler } from "./open.ts";
import { openCrawler } from "./open.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

const page = (
  words: string,
) => `<!doctype html><html lang="en"><head><title>Example page</title></head>
<body><h1>Example page</h1><p>${`${words} `.repeat(40)}</p></body></html>`;
const FIRST = page("The first text of the example page.");
const SECOND = page("The second text of the example page, after a change.");
const HTML = { "content-type": "text/html; charset=utf-8" };

let dir: string | undefined;
let crawler: HybridCrawler | undefined;

afterEach(async () => {
  await crawler?.close();
  crawler = undefined;
  if (dir !== undefined) await removeDir(dir);
  dir = undefined;
});

/** This function opens a crawler on a site whose page gives each answer of the list, in order. */
const setup = async (
  answers: ReadonlyArray<{ status: number; body?: string; headers?: Record<string, string> }>,
) => {
  dir = await tempDir("body");
  const agent = new MockAgent();
  agent.disableNetConnect();
  const site = agent.get("https://site.example");
  site.intercept({ path: "/robots.txt" }).reply(200, "User-agent: *\nAllow: /\n").persist();
  for (const answer of answers) {
    site
      .intercept({ path: "/page" })
      .reply(answer.status, answer.body ?? "", { headers: { ...HTML, ...answer.headers } });
  }
  crawler = openCrawler({ dir, renderer: false, dispatcher: agent, clock: fakeClock() });
  return crawler;
};

const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);
const URL_OF_PAGE = "https://site.example/page";

describe("body and unchanged", () => {
  it("gives the body of a capture and tells a 304, the same bytes and new bytes apart", async () => {
    const polite = await setup([
      { status: 200, body: FIRST, headers: { etag: '"v1"' } },
      { status: 304, headers: { etag: '"v1"' } },
      { status: 200, body: FIRST },
      { status: 200, body: SECOND },
    ]);
    const first = await polite.fetch(URL_OF_PAGE, { maxAge: "0s" });
    expect(first).toMatchObject({ outcome: "ok", from_cache: false, unchanged: false });
    expect(first.blob).toMatch(/^[0-9a-f]{64}$/);
    expect(text(await polite.body(first.capture!))).toBe(FIRST);

    const revalidated = await polite.fetch(URL_OF_PAGE, { maxAge: "0s" });
    expect(revalidated).toMatchObject({
      outcome: "not-modified",
      unchanged: true,
      blob: first.blob,
    });

    const same = await polite.fetch(URL_OF_PAGE, { maxAge: "0s" });
    expect(same).toMatchObject({
      outcome: "ok",
      from_cache: false,
      unchanged: true,
      blob: first.blob,
    });

    const changed = await polite.fetch(URL_OF_PAGE, { maxAge: "0s" });
    expect(changed).toMatchObject({ outcome: "ok", unchanged: false });
    expect(changed.blob).not.toBe(first.blob);
    expect(text(await polite.body(changed.capture!))).toBe(SECOND);
    // the earlier capture keeps its own body
    expect(text(await polite.body(first.capture!))).toBe(FIRST);
  });

  it("tells that the stored copy answered with no request", async () => {
    const polite = await setup([
      { status: 200, body: FIRST, headers: { "cache-control": "max-age=3600" } },
    ]);
    const first = await polite.fetch(URL_OF_PAGE);
    const cached = await polite.fetch(URL_OF_PAGE);
    expect(cached).toMatchObject({
      from_cache: true,
      unchanged: true,
      blob: first.blob,
      capture: first.capture,
    });
  });

  it("gives no body for a page that asked not to be AI input, and none for an unknown capture", async () => {
    const polite = await setup([
      { status: 200, body: FIRST, headers: { "content-signal": "ai-input=no" } },
    ]);
    const held = await polite.fetch(URL_OF_PAGE);
    expect(held.held_back).toBe(true);
    expect(held.capture).not.toBeNull();
    expect(await polite.body(held.capture!)).toBeUndefined();
    expect(await polite.body("no-such-capture")).toBeUndefined();
  });
});
