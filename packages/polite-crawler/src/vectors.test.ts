import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { unitVector } from "./embed.ts";
import { removeDir, tempDir } from "./test-helpers.ts";
import { VECTORS_SCHEMA, VectorStore } from "./vectors.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const open = async (): Promise<{ dir: string; path: string; store: VectorStore }> => {
  const dir = await tempDir("vectors");
  const path = join(dir, "vectors.sqlite");
  const store = new VectorStore(path);
  cleanups.push(async () => {
    store.close();
    await removeDir(dir);
  });
  return { dir, path, store };
};

const v = (...values: number[]): Float32Array => unitVector(values);

const write = (
  store: VectorStore,
  sha: string,
  vectors: readonly Float32Array[],
  docs: readonly string[],
  plan = "p1",
): void =>
  store.put({
    embedder: "e",
    dimensions: 3,
    sha,
    plan,
    chars: 100,
    chunks: vectors.map((vector, at) => ({ start: at * 10, end: at * 10 + 10, vector })),
    docs,
    at: "2026-10-17T00:00:00.000Z",
  });

describe("VectorStore", () => {
  it("keeps the chunks of each text, and gives the best chunk of each text", async () => {
    const { store } = await open();
    write(store, "s1", [v(1, 0, 0), v(0, 1, 0)], ["a", "b"]);
    write(store, "s2", [v(0, 0, 1)], ["c"]);
    expect(store.plan("e", "s1")).toBe("p1");
    expect(store.plan("e", "s3")).toBeUndefined();
    expect(store.plan("other", "s1")).toBeUndefined();
    expect(store.pointed("e", "a")).toBe("s1");
    expect(store.dimensions("e")).toBe(3);
    expect(store.chunks("e", "s1").map((chunk) => [chunk.chunk, chunk.start, chunk.end])).toEqual([
      [0, 0, 10],
      [1, 10, 20],
    ]);
    const hits = store.search("e", v(0, 1, 0.1));
    expect(hits.map((hit) => [hit.sha, hit.chunk, hit.docs])).toEqual([
      ["s1", 1, ["a", "b"]],
      ["s2", 0, ["c"]],
    ]);
    expect(hits[0]!.similarity).toBeCloseTo(0.995, 3);
    expect(store.search("e", v(1, 0, 0), { within: ["c"] }).map((hit) => hit.sha)).toEqual(["s2"]);
    expect(store.best("e", "s1", v(1, 0, 0))).toMatchObject({ chunk: 0, start: 0, end: 10 });
    expect(store.best("e", "missing", v(1, 0, 0))).toBeUndefined();
    expect(store.search("nobody", v(1, 0, 0))).toEqual([]);
    expect(() => store.search("e", v(1, 0))).toThrow(/dimensions/);
    expect(store.counts("e")).toEqual({ texts: 2, chunks: 3, docs: 3, bytes: 36 });
    expect(store.counts()).toEqual({ texts: 2, chunks: 3, docs: 3, bytes: 36 });
  });

  it("follows the pointers in memory: a new text, a moved document, a forgotten one", async () => {
    const { store } = await open();
    write(store, "s1", [v(1, 0, 0)], ["a"]);
    expect(store.search("e", v(1, 0, 0)).map((hit) => hit.docs)).toEqual([["a"]]);
    // the search read the vectors into memory; the next writes change them there
    write(store, "s2", [v(0, 1, 0)], ["b"]);
    store.point("e", "c", "s1", "2026-10-17T00:00:00.000Z");
    expect(store.search("e", v(1, 0, 0)).map((hit) => [hit.sha, hit.docs])).toEqual([
      ["s1", ["a", "c"]],
      ["s2", ["b"]],
    ]);
    store.point("e", "a", "s2", "2026-10-17T00:00:00.000Z");
    store.forget("e", "c");
    store.forget("e", "nobody");
    expect(store.search("e", v(1, 0, 0)).map((hit) => [hit.sha, hit.docs])).toEqual([
      ["s2", ["b", "a"]],
    ]);
    expect(store.pointed("e", "c")).toBeUndefined();
    // a text with a new plan gets new chunks
    write(store, "s2", [v(0, 0, 1), v(1, 0, 0)], ["b"], "p2");
    expect(store.plan("e", "s2")).toBe("p2");
    expect(store.best("e", "s2", v(1, 0, 0))).toMatchObject({ chunk: 1 });
  });

  it("points a document at a text that no document pointed at when the vectors loaded", async () => {
    const { store } = await open();
    write(store, "s1", [v(1, 0, 0)], ["a"]);
    store.forget("e", "a");
    expect(store.search("e", v(1, 0, 0))).toEqual([]);
    store.point("e", "b", "s1", "2026-10-17T00:00:00.000Z");
    expect(store.search("e", v(1, 0, 0)).map((hit) => hit.docs)).toEqual([["b"]]);
  });

  it("reads the vectors again after a write of a different process", async () => {
    const { path, store } = await open();
    write(store, "s1", [v(1, 0, 0)], ["a"]);
    expect(store.search("e", v(0, 1, 0)).map((hit) => hit.sha)).toEqual(["s1"]);
    const other = new VectorStore(path);
    cleanups.push(() => other.close());
    write(other, "s2", [v(0, 1, 0)], ["b"]);
    expect(store.search("e", v(0, 1, 0)).map((hit) => hit.sha)).toEqual(["s2", "s1"]);
  });

  it("refuses a vector of the wrong length and new dimensions for a known embedder", async () => {
    const { store } = await open();
    expect(() => write(store, "s1", [new Float32Array(2)], ["a"])).toThrow(
      /vector of 2 dimensions, not 3/,
    );
    write(store, "s0", [], ["z"]);
    expect(store.dimensions("e")).toBeUndefined();
    write(store, "s1", [v(1, 0, 0)], ["a"]);
    expect(() =>
      store.put({
        embedder: "e",
        dimensions: 4,
        sha: "s2",
        plan: "p1",
        chars: 1,
        chunks: [{ start: 0, end: 1, vector: unitVector([1, 0, 0, 0]) }],
        docs: ["b"],
        at: "2026-10-17T00:00:00.000Z",
      }),
    ).toThrow(/holds vectors of 3 dimensions for the embedder e, and it gave 4/);
    expect(store.plan("e", "s2")).toBeUndefined();
  });

  it("opens a file of a different schema empty, and refuses work after close", async () => {
    const { path, store } = await open();
    write(store, "s1", [v(1, 0, 0)], ["a"]);
    store.close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${String(VECTORS_SCHEMA + 1)}`);
    db.close();
    const again = new VectorStore(path);
    cleanups.push(() => again.close());
    expect(again.counts()).toEqual({ texts: 0, chunks: 0, docs: 0, bytes: 0 });
    store.close();
    expect(() => store.plan("e", "s1")).toThrow(/closed/);
    expect(() => write(store, "s1", [v(1, 0, 0)], ["a"])).toThrow(/closed/);
    const memory = new VectorStore(":memory:");
    expect(memory.counts().texts).toBe(0);
    memory.close();
  });
});
