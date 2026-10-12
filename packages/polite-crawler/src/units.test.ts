import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classify, parseRetryAfter } from "./classify.ts";
import { CaptureLog } from "./log.ts";
import { HostScheduler, backoffMs } from "./politeness.ts";
import { makeRecord } from "./record.ts";
import { readSignals } from "./signals.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const headers =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

describe("classifying responses", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  it("reads Retry-After as seconds or as a date", () => {
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("Wed, 07 Oct 2026 12:02:00 GMT", now)).toBe(120_000);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });
  it("recognizes challenges, licence demands and refusals", () => {
    expect(classify(202, headers({ "x-amzn-waf-action": "challenge" }), now).outcome).toBe(
      "challenge",
    );
    expect(classify(405, headers({ "x-amzn-waf-action": "captcha" }), now).outcome).toBe(
      "challenge",
    );
    expect(classify(402, headers({ "crawler-price": "USD 0.01" }), now)).toMatchObject({
      outcome: "payment-required",
      note: "price USD 0.01",
    });
    expect(classify(403, headers({}), now).outcome).toBe("blocked");
    // a busy gateway is a reason to wait, not a failure
    expect(classify(504, headers({}), now).outcome).toBe("unavailable");
    expect(classify(503, headers({ "retry-after": "60" }), now)).toMatchObject({
      outcome: "unavailable",
      retryAfterMs: 60_000,
    });
  });
});

describe("usage signals", () => {
  it("lets a no anywhere win, and ignores training opt-outs", () => {
    expect(readSignals(["content-signal: search=yes, ai-train=no"], headers({})).ai_input).toBe(
      "unset",
    );
    expect(readSignals([], headers({ "content-usage": "ai-use=n" })).ai_input).toBe("no");
    expect(
      readSignals(["content-signal: ai-input=yes"], headers({ "content-signal": "ai-input=no" }))
        .ai_input,
    ).toBe("no");
  });
});

describe("pacing across hosts", () => {
  it("runs different hosts at once and one host at a time", async () => {
    const scheduler = new HostScheduler({ now: () => 0, sleep: () => Promise.resolve() }, 8);
    let inFlight = 0;
    let peak = 0;
    const perHost = new Map<string, number>();
    const task = (host: string) => async () => {
      inFlight += 1;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      peak = Math.max(peak, inFlight);
      expect(perHost.get(host)).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      perHost.set(host, perHost.get(host)! - 1);
      inFlight -= 1;
      return { value: host, delayMs: 0 };
    };
    const hosts = ["a", "b", "c", "a", "b", "c"];
    await Promise.all(hosts.map((host) => scheduler.run(host, task(host))));
    expect(peak).toBe(3);
  });
  it("backs off with full jitter, capped", () => {
    expect(backoffMs(1, 1000, 60_000, () => 0.5)).toBe(500);
    expect(backoffMs(4, 1000, 60_000, () => 0.999)).toBe(7992);
    expect(backoffMs(20, 1000, 60_000, () => 1)).toBe(60_000);
  });
});

describe("the capture log", () => {
  it("drops a torn last line before appending, once", async () => {
    dir = await mkdtemp(join(tmpdir(), "polite-crawler-log-"));
    const shard = join(dir, "fetch", "2026");
    await mkdir(shard, { recursive: true });
    await writeFile(join(shard, "10.ndjson"), '{"complete":true}\n{"torn":', "utf8");
    const log = new CaptureLog(dir);
    const envelope = makeRecord({
      source: "fetch",
      kind: "capture",
      payload: { url: "https://x.example/" },
      received_at: "2026-10-07T12:00:00.000Z",
    });
    await log.append(envelope);
    await log.append({ ...envelope, id: "fetch.second" });
    await log.close();
    const lines = (await readFile(join(shard, "10.ndjson"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('{"complete":true}');
    expect(JSON.parse(lines[2]!).id).toBe("fetch.second");
  });
});
