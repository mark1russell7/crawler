import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { DiffLine, DiffResult } from "./diff.ts";
import { DIFF_LIMITS, diffDocument, diffTexts, editScript, formatDiff } from "./diff.ts";
import type { DocInput } from "./docs.ts";
import { DocIndex } from "./docs.ts";
import type { CrawlRuntime } from "./runtime.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** This function applies an edit script to `a`, and gives the result. It also checks that the script reads `a` and `b` in sequence. */
const apply = (
  a: readonly number[],
  b: readonly number[],
  runs: ReadonlyArray<{ op: 0 | 1 | 2; count: number }>,
): number[] => {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  for (const run of runs) {
    if (run.op === 0) {
      for (let at = 0; at < run.count; at += 1) {
        expect(a[i + at]).toBe(b[j + at]);
        out.push(a[i + at]!);
      }
      i += run.count;
      j += run.count;
    } else if (run.op === 1) i += run.count;
    else {
      out.push(...b.slice(j, j + run.count));
      j += run.count;
    }
  }
  expect(i).toBe(a.length);
  expect(j).toBe(b.length);
  return out;
};

/** The length of the longest common subsequence, by dynamic programming: the reference for a minimal script. */
const lcs = (a: readonly number[], b: readonly number[]): number => {
  const row: number[] = Array.from({ length: b.length + 1 }, () => 0);
  for (const x of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j]!, row[j - 1]!);
      diagonal = above;
    }
  }
  return row[b.length]!;
};

const kept = (runs: ReadonlyArray<{ op: 0 | 1 | 2; count: number }>): number =>
  runs.filter((run) => run.op === 0).reduce((sum, run) => sum + run.count, 0);

describe("the edit script", () => {
  it("turns the old sequence into the new one, and it is minimal", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 40 }),
        fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 40 }),
        (a, b) => {
          const script = editScript(a, b, { steps: 0, max: 1_000_000 });
          expect(script.exact).toBe(true);
          expect(apply(a, b, script.runs)).toEqual(b);
          expect(kept(script.runs)).toBe(lcs(a, b));
        },
      ),
      { numRuns: 400 },
    );
  });

  it("stays a correct script when its budget ends, and says that it is not minimal", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 60 }),
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 60 }),
        fc.integer({ min: 0, max: 40 }),
        (a, b, max) => {
          const budget = { steps: 0, max };
          const script = editScript(a, b, budget);
          expect(apply(a, b, script.runs)).toEqual(b);
          // a script that is not minimal comes only from a budget that ended
          expect(script.exact || budget.steps > max).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });
});

const lines = (count: number, tag: string): string =>
  Array.from({ length: count }, (_, at) => `${tag} line ${String(at)}`).join("\n");

describe("the diff of two texts", () => {
  it("gives the changed lines in hunks with context, and the changed words inside a line", () => {
    const before = [
      "Opening hours",
      "Monday to Friday: 9 to 17",
      "Saturday: 10 to 14",
      "Sunday: closed",
      "Call us at 555 0100",
      "We cater weddings.",
    ].join("\n");
    const after = [
      "Opening hours",
      "Monday to Friday: 10 to 18",
      "Saturday: 10 to 14",
      "Sunday: closed",
      "Call us at 555 0100",
      "New: a garden terrace.",
    ].join("\n");
    const diff = diffTexts({ text: before, fields: {} }, { text: after, fields: {} });
    expect(diff.summary).toEqual({
      lines_added: 2,
      lines_removed: 2,
      lines_changed: 2,
      // removed: 9, 17, We, cater, weddings; added: 10, 18, New, the colon, a, garden, terrace
      words_added: 7,
      words_removed: 5,
      meta_changes: 0,
    });
    expect(diff.same).toBe(false);
    expect(diff.exact).toBe(true);
    expect(diff.truncated).toBe(false);
    expect(diff.hunks).toHaveLength(1);
    const hunk = diff.hunks[0]!;
    expect(hunk).toMatchObject({ from_line: 1, from_count: 6, to_line: 1, to_count: 6 });
    const changed = hunk.lines.find(
      (line): line is Extract<DiffLine, { op: "changed" }> => line.op === "changed",
    )!;
    expect(changed.words).toEqual([
      { op: "same", text: "Monday to Friday: " },
      { op: "removed", text: "9" },
      { op: "added", text: "10" },
      { op: "same", text: " to " },
      { op: "removed", text: "17" },
      { op: "added", text: "18" },
    ]);
    expect(formatDiff(diff)).toContain("~ Monday to Friday: [-9-]{+10+} to [-17-]{+18+}");
  });

  it("keeps two changes far apart in two hunks, with the right line numbers", () => {
    const old = lines(40, "a").split("\n");
    const next = [...old];
    next[3] = "changed early";
    next.splice(30, 0, "added late");
    const diff = diffTexts(
      { text: old.join("\n"), fields: {} },
      { text: next.join("\n"), fields: {} },
    );
    expect(
      diff.hunks.map((hunk) => [hunk.from_line, hunk.from_count, hunk.to_line, hunk.to_count]),
    ).toEqual([
      [2, 5, 2, 5],
      [29, 4, 29, 5],
    ]);
    expect(diff.hunks[1]!.lines.map((line) => line.op)).toEqual([
      "same",
      "same",
      "added",
      "same",
      "same",
    ]);
    expect(diff.summary).toMatchObject({ lines_added: 2, lines_removed: 1, lines_changed: 1 });
  });

  it("gives the changes of the metadata at their paths, the JSON-LD too", () => {
    const diff = diffTexts(
      {
        text: "same",
        fields: {
          title: "Forno",
          meta: {
            description: "Bread",
            jsonld: [{ "@type": "Bakery", openingHours: "Mo-Fr 09:00-17:00", telephone: "1" }],
            links: [{ href: "/a" }, { href: "/b" }],
          },
        },
      },
      {
        text: "same",
        fields: {
          title: "Forno Rosso",
          meta: {
            jsonld: [
              { "@type": "Bakery", openingHours: "Mo-Fr 10:00-18:00", telephone: "1" },
              { "@type": "Offer" },
            ],
            links: [{ href: "/a" }, { href: "/new" }, { href: "/b" }],
            lang: "en",
          },
        },
      },
    );
    expect(diff.meta).toEqual([
      { path: "meta.description", change: "removed", before: '"Bread"', after: null },
      {
        path: "meta.jsonld[0].openingHours",
        change: "changed",
        before: '"Mo-Fr 09:00-17:00"',
        after: '"Mo-Fr 10:00-18:00"',
      },
      { path: "meta.jsonld[1]", change: "added", before: null, after: '{"@type":"Offer"}' },
      { path: "meta.lang", change: "added", before: null, after: '"en"' },
      { path: "meta.links[1]", change: "added", before: null, after: '{"href":"/new"}' },
      { path: "title", change: "changed", before: '"Forno"', after: '"Forno Rosso"' },
    ]);
    expect(diff.summary.meta_changes).toBe(6);
    expect(diff.hunks).toEqual([]);
    expect(diff.same).toBe(false);
    const quoted = diffTexts(
      { text: "", fields: { meta: { jsonld: [{ "@type": "A" }] } } },
      { text: "", fields: { meta: { jsonld: [{ "@type": "B" }] } } },
    );
    expect(quoted.meta.map((change) => change.path)).toEqual(['meta.jsonld[0]["@type"]']);
  });

  it("gives the same result for the same texts, with no hunk", () => {
    const text = lines(500, "x");
    const diff = diffTexts({ text, fields: { a: 1 } }, { text, fields: { a: 1 } });
    expect(diff).toMatchObject({ same: true, hunks: [], meta: [], exact: true });
    // equal texts cost one pass of the common start, not a search
    expect(diff.steps).toBeLessThanOrEqual(501);
  });

  it("stays linear for a small change in a huge text", () => {
    const old = lines(DIFF_LIMITS.maxLines, "huge").split("\n");
    const next = [...old];
    next[25_000] = "the one changed line";
    const diff = diffTexts(
      { text: old.join("\n"), fields: {} },
      { text: next.join("\n"), fields: {} },
    );
    expect(diff.exact).toBe(true);
    expect(diff.summary).toMatchObject({ lines_added: 1, lines_removed: 1, lines_changed: 1 });
    expect(diff.steps).toBeLessThan(2 * DIFF_LIMITS.maxLines);
  });

  it("stays bounded when each line changes, and says that the diff is not minimal", () => {
    const old = lines(20_000, "old");
    const next = lines(20_000, "new");
    const diff = diffTexts({ text: old, fields: {} }, { text: next, fields: {} });
    expect(diff.exact).toBe(false);
    // the line budget, one round of overshoot, and the word budget
    expect(diff.steps).toBeLessThanOrEqual(
      DIFF_LIMITS.maxSteps + 40_001 + DIFF_LIMITS.maxWordSteps + 5_000,
    );
    expect(diff.summary).toMatchObject({ lines_added: 20_000, lines_removed: 20_000 });
    expect(diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)).toBe(
      DIFF_LIMITS.maxHunkLines,
    );
    expect(diff.truncated).toBe(true);
    expect(diff.notes.join(" ")).toMatch(/too large for a minimal diff/);
    expect(diff.notes.join(" ")).toMatch(/the hunks show 2000 lines/);
  });

  it("cuts a text that is too long, and says so", () => {
    const diff = diffTexts(
      { text: "a".repeat(50), fields: {} },
      { text: `${"a".repeat(50)}\nmore`, fields: {} },
      { maxChars: 20, maxLines: 10 },
    );
    expect(diff.truncated).toBe(true);
    expect(diff.notes[0]).toMatch(/longer than 20 characters/);
    const many = diffTexts(
      { text: lines(30, "a"), fields: {} },
      { text: lines(30, "b"), fields: {} },
      { maxLines: 10, maxWordSteps: 0, maxMetaChanges: 1 },
    );
    expect(many.summary.lines_added).toBe(10);
    expect(many.notes.join(" ")).toMatch(/more than 10 lines/);
    expect(many.notes.join(" ")).toMatch(/no word diff/);
    expect(() =>
      diffTexts({ text: "", fields: {} }, { text: "", fields: {} }, { maxSteps: -1 }),
    ).toThrow(RangeError);
  });
});

describe("the limits of a diff", () => {
  it("compares deep metadata to its depth, and gives no word diff for a very long line", () => {
    const deep = (leaf: string): unknown => {
      let value: unknown = leaf;
      for (let at = 0; at < 30; at += 1) value = { next: value };
      return value;
    };
    const nested = diffTexts(
      { text: "", fields: { deep: deep("a") } },
      { text: "", fields: { deep: deep("b") } },
    );
    expect(nested.meta).toHaveLength(1);
    expect(nested.meta[0]!.path.split(".")).toHaveLength(DIFF_LIMITS.maxMetaDepth);
    expect(nested.meta[0]!.before!.endsWith("…")).toBe(false);
    const big = diffTexts(
      { text: "", fields: { value: "x".repeat(1000) } },
      { text: "", fields: { value: "y".repeat(1000) } },
    );
    expect(big.meta[0]!.before).toHaveLength(DIFF_LIMITS.maxValueChars + 1);
    const words = Array.from({ length: DIFF_LIMITS.maxLineWords + 1 }, (_, at) => `w${String(at)}`);
    const long = diffTexts(
      { text: words.join(" "), fields: {} },
      { text: [...words.slice(0, -1), "changed"].join(" "), fields: {} },
    );
    expect(long.hunks[0]!.lines[0]).toMatchObject({ op: "changed", words: null });
    expect(long.exact).toBe(false);
    expect(long.summary.words_added).toBe(DIFF_LIMITS.maxLineWords + 1);
    expect(formatDiff(long)).toContain("[-w0 w1");
  });
});

// ── the diff of a stored document ──

const DOC = "url:https://forno.example/";

const version = (
  capture: string,
  at: string,
  text: string,
  extra: Partial<DocInput> = {},
): DocInput => ({
  doc: DOC,
  kind: "page",
  title: "Forno",
  text,
  url: "https://forno.example/",
  meta: {},
  captures: [capture],
  capture,
  fetched_at: at,
  recipe: "page",
  ...extra,
});

const runtimeOf = (index: DocIndex): CrawlRuntime => ({ index }) as unknown as CrawlRuntime;

const indexWith = (...inputs: DocInput[]): DocIndex => {
  const index = new DocIndex(":memory:");
  cleanups.push(() => index.close());
  for (const input of inputs) index.upsert(input, input.fetched_at!);
  return index;
};

describe("the diff of a stored document", () => {
  it("compares the two newest versions by default, or the versions of captures and times", async () => {
    const index = indexWith(
      version("fetch.v1", "2026-10-01T00:00:00.000Z", "Hours\nTuesday to Sunday"),
      version("fetch.v2", "2026-10-02T00:00:00.000Z", "Hours\nWednesday to Sunday"),
      version("fetch.v3", "2026-10-03T00:00:00.000Z", "Hours\nClosed for good", {
        meta: { description: "closed" },
      }),
    );
    const runtime = runtimeOf(index);
    const newest = await diffDocument(runtime, DOC);
    expect(newest.from).toMatchObject({ capture: "fetch.v2", at: null, held_back: false });
    expect(newest.to).toMatchObject({
      capture: "fetch.v3",
      fetched_at: "2026-10-03T00:00:00.000Z",
    });
    expect(newest.summary).toMatchObject({ lines_changed: 1, meta_changes: 1 });
    const chosen = await diffDocument(runtime, DOC, {
      from: { at: "2026-10-01T12:00:00Z" },
      to: "fetch.v2",
    });
    expect(chosen.from).toMatchObject({ capture: "fetch.v1", at: "2026-10-01T12:00:00.000Z" });
    expect(chosen.to.capture).toBe("fetch.v2");
    expect(chosen.hunks[0]!.lines).toContainEqual({
      op: "changed",
      before: "Tuesday to Sunday",
      after: "Wednesday to Sunday",
      words: [
        { op: "removed", text: "Tuesday" },
        { op: "added", text: "Wednesday" },
        { op: "same", text: " to Sunday" },
      ],
    });
    // a time between two versions chooses the earlier one
    const between = await diffDocument(runtime, DOC, {
      from: "fetch.v1",
      to: { at: new Date("2026-10-02T23:00:00Z") },
    });
    expect(between.to.capture).toBe("fetch.v2");
    await expect(diffDocument(runtime, DOC, { from: { at: "2026-09-01" } })).rejects.toThrow(
      /no version at 2026-09-01T00:00:00.000Z or before: its first capture is from 2026-10-01/,
    );
    await expect(diffDocument(runtime, DOC, { from: "fetch.nope" })).rejects.toThrow(
      /no version from the capture fetch.nope/,
    );
    await expect(diffDocument(runtime, "url:https://other.example/")).rejects.toThrow(
      /no stored document/,
    );
    await expect(diffDocument(runtime, DOC, { to: { at: "soon" } })).rejects.toThrow(RangeError);
    await expect(diffDocument(runtime, DOC, { to: {} as unknown as string })).rejects.toThrow(
      /a version is a capture id, or an object with the time at/,
    );
  });

  it("says when a document has one version", async () => {
    const diff = await diffDocument(
      runtimeOf(indexWith(version("fetch.v1", "2026-10-01T00:00:00.000Z", "one"))),
      DOC,
    );
    expect(diff).toMatchObject({
      same: true,
      from: { capture: "fetch.v1" },
      to: { capture: "fetch.v1" },
    });
    expect(diff.note).toMatch(/no earlier version of the same kind/);
  });

  it("compares a render with the render before it, not with a plain body", async () => {
    const index = indexWith(
      version("fetch.p1", "2026-10-01T00:00:00.000Z", "shell", { blob: "b1" }),
      version("fetch.r1", "2026-10-01T00:01:00.000Z", "Menu one", { rendered: true }),
      version("fetch.p2", "2026-10-02T00:00:00.000Z", "shell", { blob: "b2" }),
      version("fetch.r2", "2026-10-02T00:01:00.000Z", "Menu two", { rendered: true }),
    );
    const diff = await diffDocument(runtimeOf(index), DOC);
    expect(diff.from).toMatchObject({ capture: "fetch.r1", rendered: true });
    expect(diff.to).toMatchObject({ capture: "fetch.r2", rendered: true });
  });

  it("holds back the text and the title of a held-back version, and shows only the structural metadata", async () => {
    const index = indexWith(
      version("fetch.v1", "2026-10-01T00:00:00.000Z", "SECRET-ONE the vault code", {
        title: "TITLE-ONE",
        meta: { description: "DESC-ONE", jsonld_types: ["Article"], visible_chars: 10 },
      }),
      version("fetch.v2", "2026-10-02T00:00:00.000Z", "SECRET-TWO the vault code", {
        title: "TITLE-TWO",
        ai_input: "no",
        meta: { description: "DESC-TWO", jsonld_types: ["Article", "Person"], visible_chars: 12 },
      }),
    );
    const diff: DiffResult = await diffDocument(runtimeOf(index), DOC);
    expect(diff).toMatchObject({ held_back: true, same: null, hunks: [] });
    expect(diff.to.held_back).toBe(true);
    expect(JSON.stringify(diff)).not.toMatch(/SECRET|TITLE-|DESC-/);
    expect(diff.meta.map((change) => change.path)).toEqual([
      "meta.jsonld_types[1]",
      "meta.visible_chars",
    ]);
    expect(diff.summary).toMatchObject({ lines_added: 0, lines_removed: 0, words_added: 0 });
    expect(diff.note).toMatch(/asked not to be used as AI input/);
    // the earlier version alone is not held back, but the document is: the rule applies to each version
    const pinned = await diffDocument(runtimeOf(index), DOC, { from: "fetch.v1", to: "fetch.v1" });
    expect(pinned.held_back).toBe(true);
    expect(JSON.stringify(pinned)).not.toMatch(/SECRET|TITLE-|DESC-/);
  });
});
