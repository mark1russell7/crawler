import { describe, expect, it } from "vitest";
import {
  CHUNK_LIMITS,
  HYBRID_DEFAULTS,
  chunkText,
  chunkTokensOf,
  estimateTokens,
  fuseRanks,
  unitVector,
} from "./embed.ts";

const sentence = (n: number): string => `Sentence ${String(n)} has some plain words in it.`;

describe("estimateTokens", () => {
  it("counts words, long words, punctuation and segmented characters", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("the cat sat")).toBe(3);
    // a word of 13 letters is 3 tokens in the estimate, and the full stop is one more
    expect(estimateTokens("documentation.")).toBe(4);
    expect(estimateTokens("東京都")).toBe(3);
    expect(estimateTokens("café 😀")).toBe(2);
    expect(estimateTokens("  \n\t ")).toBe(0);
    expect(estimateTokens("abc def", 4)).toBe(1);
  });
});

describe("chunkText", () => {
  it("gives one chunk for a short text, with its exact positions", () => {
    const text = "  A short page.\n";
    const chunks = chunkText(text, { maxTokens: 100 });
    expect(chunks).toEqual([{ index: 0, start: 2, end: 15, text: "A short page." }]);
    expect(text.slice(chunks[0]!.start, chunks[0]!.end)).toBe(chunks[0]!.text);
    expect(chunkText("", { maxTokens: 100 })).toEqual([]);
    expect(chunkText(" \n \n", { maxTokens: 100 })).toEqual([]);
  });

  it("keeps whole sentences, ends a chunk at a paragraph, and shares a little text", () => {
    const paragraphs = [0, 1, 2, 3].map((p) =>
      [0, 1, 2, 3, 4].map((s) => sentence(p * 10 + s)).join(" "),
    );
    const text = paragraphs.join("\n");
    const tokens = estimateTokens(sentence(0));
    // a window of a little more than one paragraph: each chunk ends at the end of a paragraph
    const chunks = chunkText(text, { maxTokens: tokens * 7, overlapTokens: tokens });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(tokens * 7);
      expect(chunk.text).toMatch(/^Sentence \d+/);
      expect(chunk.text).toMatch(/in it\.$/);
    }
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, at) => at));
    // the first chunk is the first paragraph, and the second starts with its last sentence
    expect(chunks[0]!.text).toBe(paragraphs[0]);
    expect(chunks[1]!.text.startsWith(sentence(4))).toBe(true);
    expect(chunks[1]!.start).toBeLessThan(chunks[0]!.end);
    // each sentence is in a chunk
    for (let p = 0; p < 4; p += 1)
      for (let s = 0; s < 5; s += 1)
        expect(chunks.some((chunk) => chunk.text.includes(sentence(p * 10 + s)))).toBe(true);
  });

  it("gives no overlap when the overlap is 0, and limits an overlap to half a chunk", () => {
    const text = [0, 1, 2, 3, 4, 5].map(sentence).join(" ");
    const tokens = estimateTokens(sentence(0));
    const flat = chunkText(text, { maxTokens: tokens * 2, overlapTokens: 0 });
    expect(flat.map((chunk) => chunk.text)).toEqual([
      `${sentence(0)} ${sentence(1)}`,
      `${sentence(2)} ${sentence(3)}`,
      `${sentence(4)} ${sentence(5)}`,
    ]);
    const wide = chunkText(text, { maxTokens: tokens * 2, overlapTokens: 1000 });
    expect(wide.length).toBeLessThan(10);
    expect(wide.at(-1)!.text.endsWith(sentence(5))).toBe(true);
  });

  it("cuts a sentence that is longer than the window at its spaces, and a long word inside", () => {
    const words = Array.from({ length: 300 }, (_, at) => `word${String(at)}`).join(" ");
    const chunks = chunkText(words, { maxTokens: 20, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(10);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(20);
      expect(chunk.text).toMatch(/^word\d+( word\d+)*$/);
    }
    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(words);
    const long = "x".repeat(500);
    const parts = chunkText(long, { maxTokens: 10, overlapTokens: 0 });
    expect(parts.map((part) => part.text).join("")).toBe(long);
    for (const part of parts) expect(estimateTokens(part.text)).toBeLessThanOrEqual(10);
  });

  it("cuts Chinese text with no space, and keeps each surrogate pair whole", () => {
    const text = "東京都の天気は晴れです".repeat(20) + "😀".repeat(30);
    const chunks = chunkText(text, { maxTokens: 16, overlapTokens: 0 });
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(16);
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  it("stops at maxChunks, and checks its options", () => {
    const text = Array.from({ length: 200 }, (_, at) => sentence(at)).join("\n");
    expect(chunkText(text, { maxTokens: 12, maxChunks: 3 })).toHaveLength(3);
    expect(chunkText(text, { maxTokens: 12 })).toHaveLength(CHUNK_LIMITS.maxChunks);
    expect(() => chunkText(text, { maxTokens: 0 })).toThrow(RangeError);
    expect(() => chunkText(text, { maxTokens: 10, maxChunks: Number.NaN })).toThrow(RangeError);
  });
});

describe("chunkTokensOf", () => {
  it("fits the input limit of the model with a margin, to 512 tokens", () => {
    expect(chunkTokensOf({})).toBe(Math.floor(CHUNK_LIMITS.defaultTokens * CHUNK_LIMITS.fill));
    expect(chunkTokensOf({ maxInputTokens: 256 })).toBe(230);
    expect(chunkTokensOf({ maxInputTokens: 8192 })).toBe(460);
    expect(chunkTokensOf({ maxInputTokens: 0 })).toBe(230);
    expect(chunkTokensOf({ maxInputTokens: 4 })).toBe(8);
  });
});

describe("unitVector", () => {
  it("gives a length of 1, keeps zeros, and refuses a value that is not finite", () => {
    const unit = unitVector([3, 4]);
    expect([...unit].map((value) => Math.round(value * 1000) / 1000)).toEqual([0.6, 0.8]);
    expect([...unitVector([0, 0])]).toEqual([0, 0]);
    expect(() => unitVector([1, Number.NaN])).toThrow(RangeError);
  });
});

describe("fuseRanks: reciprocal rank fusion", () => {
  it("adds 1 / (k + rank) over the lists, the best first", () => {
    const fused = fuseRanks([
      ["a", "b", "c"],
      ["c", "d", "a"],
    ]);
    expect(fused.map((one) => one.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 63, 12);
    expect(fused[0]!.ranks).toEqual([1, 3]);
    expect(fused.find((one) => one.id === "d")!.ranks).toEqual([null, 2]);
    expect(HYBRID_DEFAULTS.fusionK).toBe(60);
  });

  it("breaks a tie by the best rank, then the earlier list, then the id", () => {
    // b and x: 1/62 each; the earlier list wins. y and z: 1/63 each, in the same list position
    const fused = fuseRanks([
      ["a", "b", "y"],
      ["c", "x", "z"],
    ]);
    expect(fused.map((one) => one.id)).toEqual(["a", "c", "b", "x", "y", "z"]);
    expect(fuseRanks([["q"], ["p"]]).map((one) => one.id)).toEqual(["q", "p"]);
    expect(fuseRanks([["p", "p"]]).map((one) => one.ranks)).toEqual([[1]]);
    expect(
      fuseRanks(
        [
          ["m", "n"],
          ["n", "m"],
        ],
        0,
      ).map((one) => one.id),
    ).toEqual(["m", "n"]);
  });

  it("gives more weight to the top of a list with a small k", () => {
    // a is first in one list; c is sixth in the two lists
    const lists = [
      ["a", "x1", "x2", "x3", "x4", "c"],
      ["y1", "y2", "y3", "y4", "y5", "c"],
    ];
    expect(fuseRanks(lists, 1)[0]!.id).toBe("a");
    expect(fuseRanks(lists, 1000)[0]!.id).toBe("c");
    expect(() => fuseRanks(lists, -1)).toThrow(RangeError);
    expect(() => fuseRanks(lists, Number.NaN)).toThrow(RangeError);
    expect(fuseRanks([])).toEqual([]);
  });
});
