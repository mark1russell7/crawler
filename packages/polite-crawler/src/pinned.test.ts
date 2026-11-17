import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Exchange, Reply, Transport } from "./api.ts";
import { HostScheduler } from "./politeness.ts";
import type { Clock } from "./politeness.ts";
import type { PinnedClient, PinnedSource } from "./pinned.ts";
import { downloadPinned, isNoRead, NoRead, pinnedClient, pinnedFile, sha256Of } from "./pinned.ts";

const bytes = new TextEncoder().encode("abase\nabash\n");
const other = new TextEncoder().encode("a different file\n");
const mirrorA = "https://mirror-a.example/list.txt";
const mirrorB = "https://mirror-b.example/list.txt";
const origin = "https://origin.example/list.txt";
const source: PinnedSource = { url: origin, sha256: sha256Of(bytes), mirrors: [mirrorA, mirrorB] };

const reply = (
  status: number,
  body?: Uint8Array,
  headers: Readonly<Record<string, string>> = {},
): Reply => ({
  status,
  statusText: "",
  headers,
  body: "",
  ...(body === undefined ? {} : { bytes: body }),
});

/** A client with a clock that does not wait, and a transport that gives the next answer of each URL. */
function scripted(answers: Readonly<Record<string, readonly (Reply | Error)[]>>): {
  readonly client: PinnedClient;
  readonly requests: string[];
  readonly clock: { time: number };
} {
  const state = { time: 0 };
  const clock: Clock = {
    now: () => state.time,
    sleep: async (ms) => {
      state.time += ms;
    },
  };
  const requests: string[] = [];
  const next = new Map<string, number>();
  const transport: Transport = async (exchange: Exchange) => {
    requests.push(exchange.url);
    expect(exchange.read).toBe("bytes");
    const list = answers[exchange.url] ?? [];
    const index = next.get(exchange.url) ?? 0;
    next.set(exchange.url, index + 1);
    const answer = list[Math.min(index, list.length - 1)];
    if (answer === undefined) return reply(404);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const pace = { scheduler: new HostScheduler(clock, 2), now: clock.now, random: () => 0 };
  return { client: { pace, transport }, requests, clock: state };
}

describe("downloadPinned", () => {
  it("takes the bytes of the first mirror and sends no other request", async () => {
    const { client, requests } = scripted({ [mirrorA]: [reply(200, bytes)] });
    expect(await downloadPinned(client, "list.txt", source)).toEqual(bytes);
    expect(requests).toEqual([mirrorA]);
  });

  it("tries a source again after a 503, after the backoff of the host, then goes to the next source", async () => {
    const { client, requests, clock } = scripted({
      [mirrorA]: [reply(503)],
      [mirrorB]: [reply(503), reply(200, bytes)],
    });
    expect(await downloadPinned(client, "list.txt", source)).toEqual(bytes);
    expect(requests).toEqual([mirrorA, mirrorA, mirrorA, mirrorB, mirrorB]);
    expect(clock.time).toBeGreaterThan(0);
  });

  it("tries a source again when the request gives no answer", async () => {
    const { client, requests } = scripted({
      [mirrorA]: [new TypeError("fetch failed"), reply(200, bytes)],
    });
    expect(await downloadPinned(client, "list.txt", source)).toEqual(bytes);
    expect(requests).toEqual([mirrorA, mirrorA]);
  });

  it("goes to the next source at once after a 404", async () => {
    const { client, requests } = scripted({ [mirrorB]: [reply(200, bytes)] });
    expect(await downloadPinned(client, "list.txt", source)).toEqual(bytes);
    expect(requests).toEqual([mirrorA, mirrorB]);
  });

  it("follows a redirect to another host, and a redirect is not a try", async () => {
    const moved = "https://files.example/list.txt";
    const { client, requests } = scripted({
      [mirrorA]: [reply(307, undefined, { location: moved })],
      [moved]: [reply(503), reply(503), reply(200, bytes)],
    });
    expect(await downloadPinned(client, "list.txt", source)).toEqual(bytes);
    expect(requests).toEqual([mirrorA, moved, moved, moved]);
  });

  it("stops at the limit of redirects", async () => {
    const loop = "https://loop.example/list.txt";
    const { client, requests } = scripted({
      [mirrorA]: [reply(302, undefined, { location: loop })],
      [loop]: [reply(302, undefined, { location: loop })],
      [mirrorB]: [reply(200, bytes)],
    });
    expect(await downloadPinned(client, "list.txt", source, { redirects: 2 })).toEqual(bytes);
    expect(requests).toEqual([mirrorA, loop, loop, mirrorB]);
  });

  it("does not follow a redirect to a scheme that is not HTTP", async () => {
    const { client, requests } = scripted({
      [mirrorA]: [reply(302, undefined, { location: "ftp://files.example/list.txt" })],
      [mirrorB]: [reply(200, bytes)],
    });
    expect(await downloadPinned(client, "list.txt", source)).toEqual(bytes);
    expect(requests).toEqual([mirrorA, mirrorB]);
  });

  it("refuses bytes with a different SHA-256 and goes to the next source", async () => {
    const { client, requests } = scripted({
      [mirrorA]: [reply(200, other)],
      [mirrorB]: [reply(200, bytes)],
    });
    expect(await downloadPinned(client, "list.txt", source)).toEqual(bytes);
    expect(requests).toEqual([mirrorA, mirrorB]);
  });

  it("tries the URL last, and a source with no mirrors is its URL only", async () => {
    const { client, requests } = scripted({ [origin]: [reply(200, bytes)] });
    expect(
      await downloadPinned(client, "list.txt", { url: origin, sha256: source.sha256 }),
    ).toEqual(bytes);
    expect(requests).toEqual([origin]);
  });

  it("throws NoRead with each try when no source gives the bytes", async () => {
    const { client } = scripted({
      [mirrorA]: [reply(404)],
      [mirrorB]: [reply(200, other)],
      [origin]: [reply(503)],
    });
    const error: unknown = await downloadPinned(client, "list.txt", source).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(isNoRead(error)).toBe(true);
    const noRead = error as NoRead;
    expect(noRead.file).toBe("list.txt");
    expect(noRead.tries.map((one) => one.url)).toEqual([mirrorA, mirrorB, origin, origin, origin]);
    expect(noRead.tries[1]?.result).toContain(sha256Of(other));
    expect(noRead.message).toMatch(/^no read: /u);
  });

  it("keeps an error that is not of the send", async () => {
    const { client } = scripted({});
    const aborted = new AbortController();
    aborted.abort(new Error("stopped"));
    await expect(
      downloadPinned(client, "list.txt", source, { signal: aborted.signal }),
    ).rejects.not.toBeInstanceOf(NoRead);
  });
});

describe("pinnedClient", () => {
  it("refuses a User-Agent that the transport refuses", () => {
    expect(() => pinnedClient({ userAgent: "" })).toThrow(/User-Agent/u);
  });
});

describe("pinnedFile", () => {
  const folders: string[] = [];
  const folder = (): string => {
    const made = mkdtempSync(join(tmpdir(), "pinned-"));
    folders.push(made);
    return made;
  };
  afterEach(() => {
    for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
  });

  it("reads a file with the correct SHA-256 from the folder and sends no request", async () => {
    const place = folder();
    writeFileSync(join(place, "list.txt"), bytes);
    const { client, requests } = scripted({});
    expect(await pinnedFile(client, place, "list.txt", source)).toEqual(bytes);
    expect(requests).toEqual([]);
  });

  it("downloads again when the file in the folder has other bytes, and leaves no temporary file", async () => {
    const place = folder();
    writeFileSync(join(place, "list.txt"), other);
    const { client, requests } = scripted({ [mirrorA]: [reply(200, bytes)] });
    await pinnedFile(client, place, "list.txt", source);
    expect(requests).toEqual([mirrorA]);
    expect(sha256Of(readFileSync(join(place, "list.txt")))).toBe(source.sha256);
    expect(readdirSync(place)).toEqual(["list.txt"]);
  });

  it("makes the folder, and writes nothing when no source gives the bytes", async () => {
    const place = join(folder(), "new");
    const { client } = scripted({});
    await expect(pinnedFile(client, place, "list.txt", source)).rejects.toBeInstanceOf(NoRead);
    expect(existsSync(join(place, "list.txt"))).toBe(false);
  });
});
