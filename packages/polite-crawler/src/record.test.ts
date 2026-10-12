import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { makeRecord, stableStringify } from "./record.ts";
import { VERSION } from "./version.ts";

describe("capture records", () => {
  it("hash to the ids of earlier capture logs, so old citations still resolve", () => {
    const record = makeRecord({
      source: "fetch",
      kind: "capture",
      payload: {
        url: "https://example.com/",
        status: 200,
        outcome: "ok",
        nested: { b: 1, a: [2, { d: null, c: "x" }] },
      },
      received_at: "2026-10-07T12:00:00.000Z",
      external_id: "https://example.com/",
    });
    // the id that the earlier envelope code gave for the same input
    expect(record.id).toBe("fetch.6d57153296df");
    expect(record.content_hash).toBe(
      "6d57153296df99c94e78e2fc07cac2efe0022302d1edda232e0dea7662cadb62",
    );
  });

  it("write keys in order and leave undefined values out", () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [1, null] } })).toBe(
      '{"a":{"c":[1,null]},"b":1}',
    );
  });

  it("keep a label out of the hash", () => {
    const base = { source: "fetch", kind: "skipped", payload: {}, received_at: "2026-10-07T12:00:00Z" };
    expect(makeRecord({ ...base, scope: "private" }).id).toBe(makeRecord(base).id);
  });

  it("keep labels out of the hash, so an input with no labels hashes as before", () => {
    const input = {
      source: "fetch",
      kind: "capture",
      payload: { url: "https://example.com/", status: 200, outcome: "ok", nested: { b: 1, a: [2, { d: null, c: "x" }] } },
      received_at: "2026-10-07T12:00:00.000Z",
      external_id: "https://example.com/",
    };
    const labelled = makeRecord({ ...input, scope: "intimate", labels: { carrier: "gift-17", intent: "buy" } });
    expect(labelled.id).toBe("fetch.6d57153296df");
    expect(labelled.labels).toEqual({ carrier: "gift-17", intent: "buy" });
    expect(makeRecord({ ...input, labels: {} })).toEqual(makeRecord(input));
  });
});

describe("the version", () => {
  it("agrees with package.json", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
