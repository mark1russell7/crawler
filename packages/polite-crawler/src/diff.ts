import type { CrawlRuntime } from "./runtime.ts";
import type { VersionText } from "./docs.ts";
import { HELD_BACK, heldBackMeta, isHeldBack, isoTime, versionAtTime } from "./runtime.ts";
import { stableStringify } from "./record.ts";

/**
 * A diff compares two versions of a stored document. It gives the changes of the text as a line
 * diff, with a word diff inside each changed line. It gives the changes of the title, the URL and
 * the metadata (the JSON-LD too) as changes at a path.
 *
 * The line diff is the algorithm of Myers (1986). Its time is linear in the length of the texts
 * when the change is small. A budget of steps (`DIFF_LIMITS`) bounds the time of a large change.
 * After the budget, the diff gives the rest of the change as one removal and one addition. Then
 * the result says that it is not minimal. A huge text gives its first part, and the result says so.
 *
 * A held-back version gives no text and no title to a diff, and only its structural metadata.
 */

/** These are the limits of a diff. Each limit bounds the time or the size of a result. */
export const DIFF_LIMITS = {
  /** The characters of each text that a diff compares. A longer text gives its first part. */
  maxChars: 1_000_000,
  /** The lines of each text that a diff compares. A longer text gives its first lines. */
  maxLines: 50_000,
  /** The steps of the line diff. After them, the rest of the change is one removal and one addition. */
  maxSteps: 1_000_000,
  /** The steps of the word diffs of all the changed lines together. */
  maxWordSteps: 1_000_000,
  /** The words of one line that a word diff compares. A longer line gets no word diff. */
  maxLineWords: 5_000,
  /** The lines of context before and after each change. */
  context: 2,
  /** The lines that the hunks of a result show. The summary counts each line. */
  maxHunkLines: 2_000,
  /** The changes of the metadata that a result shows. The summary counts each change. */
  maxMetaChanges: 200,
  /** The depth of the metadata that a diff compares. A deeper change is a change of the whole value. */
  maxMetaDepth: 16,
  /** The characters of the JSON of each value of a change of the metadata. */
  maxValueChars: 300,
} as const;

/** These are the limits of a diff, one by one. `DIFF_LIMITS` gives the defaults. */
export type DiffLimits = { readonly [K in keyof typeof DIFF_LIMITS]: number };

/** This is a part of a changed line: words that stay, words that the new text adds, or words that it removes. */
export interface WordPart {
  readonly op: "same" | "added" | "removed";
  readonly text: string;
}

/**
 * This is one line of a hunk. A `same` line is context. A `changed` line pairs a removed line with
 * an added line, and `words` gives the word diff, or null when the word budget ended.
 */
export type DiffLine =
  | { readonly op: "same" | "added" | "removed"; readonly text: string }
  | {
      readonly op: "changed";
      readonly before: string;
      readonly after: string;
      readonly words: readonly WordPart[] | null;
    };

/** This is a part of the diff of the text: the changed lines with some context, as in a unified diff. */
export interface DiffHunk {
  /** This value is the number (from 1) of the first line of the hunk in the old text. */
  readonly from_line: number;
  /** This value is the number of lines of the old text in the hunk. */
  readonly from_count: number;
  /** This value is the number (from 1) of the first line of the hunk in the new text. */
  readonly to_line: number;
  /** This value is the number of lines of the new text in the hunk. */
  readonly to_count: number;
  readonly lines: readonly DiffLine[];
}

/**
 * This is one change of the title, the URL or the metadata. The path names the value, for
 * example `meta.jsonld[0].openingHours`. `before` and `after` are the JSON of the values, cut to
 * `DIFF_LIMITS.maxValueChars`.
 */
export interface MetaChange {
  readonly path: string;
  readonly change: "added" | "removed" | "changed";
  /** This text is the JSON of the old value, or null when the new version adds the value. */
  readonly before: string | null;
  /** This text is the JSON of the new value, or null when the new version removes the value. */
  readonly after: string | null;
}

/** These are the counts of a diff. */
export interface DiffSummary {
  /** This value counts the lines that only the new text has. */
  readonly lines_added: number;
  /** This value counts the lines that only the old text has. */
  readonly lines_removed: number;
  /** This value counts the pairs of a removed line and an added line that the result shows as one changed line. */
  readonly lines_changed: number;
  /** This value counts the words that the new text adds, in the added lines and in the changed lines. */
  readonly words_added: number;
  /** This value counts the words that the new text removes, in the removed lines and in the changed lines. */
  readonly words_removed: number;
  /** This value counts the changes of the title, the URL and the metadata. */
  readonly meta_changes: number;
}

/** This is the input of `diffTexts`: the parts of a version that a diff compares. */
export interface DiffInput {
  readonly text: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** This is the result of `diffTexts`. */
export interface TextDiff {
  readonly summary: DiffSummary;
  readonly hunks: readonly DiffHunk[];
  readonly meta: readonly MetaChange[];
  /** This value is true when the text and the fields are the same. */
  readonly same: boolean;
  /** This value is true when the line diff is minimal and each changed line has its word diff. */
  readonly exact: boolean;
  /** This value is true when the result leaves out a part. It can leave out the end of a long text, lines of the hunks or changes of the metadata. */
  readonly truncated: boolean;
  /** This value counts the steps of the line diff and of the word diffs. A test reads it: a step count does not change with the computer. */
  readonly steps: number;
  readonly notes: readonly string[];
}

/** A run of the edit script. `0` keeps lines of the two texts. `1` removes lines of the old text, and `2` adds lines of the new text. */
interface Run {
  readonly op: 0 | 1 | 2;
  readonly count: number;
}

/** A budget of steps. The diffs add to `steps`, and stop when it passes `max`. */
interface Budget {
  steps: number;
  max: number;
}

/**
 * This function gives an edit script from `a` to `b`, with the algorithm of Myers. It first
 * removes the common start and the common end. When the budget ends, it keeps the furthest path
 * that it found, and the rest is one removal and one addition. `exact` is then false.
 */
export const editScript = (
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  budget: Budget,
): { readonly runs: Run[]; readonly exact: boolean } => {
  const n = a.length;
  const m = b.length;
  let head = 0;
  while (head < n && head < m && a[head] === b[head]) head += 1;
  let endA = n;
  let endB = m;
  while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  budget.steps += head + (n - endA) + 1;
  const reversed: Array<[0 | 1 | 2, number]> = [];
  const width = endA - head;
  const height = endB - head;
  let exact = true;
  reversed.push([0, n - endA]);
  if (width === 0 || height === 0) {
    reversed.push([2, height], [1, width]);
  } else {
    const at = (x: number): number => a[head + x]!;
    const bt = (y: number): number => b[head + y]!;
    const max = width + height;
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    // trace[d] is the band of v after the round d: the index k + d holds the furthest x on the diagonal k
    const trace: Int32Array[] = [];
    let end: { readonly x: number; readonly y: number; readonly d: number } | undefined;
    rounds: for (let d = 0; d <= max; d += 1) {
      for (let k = -d; k <= d; k += 2) {
        budget.steps += 1;
        if (budget.steps > budget.max) break rounds;
        let x =
          k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
            ? v[offset + k + 1]!
            : v[offset + k - 1]! + 1;
        let y = x - k;
        while (x < width && y < height && at(x) === bt(y)) {
          x += 1;
          y += 1;
          budget.steps += 1;
        }
        v[offset + k] = x;
        if (x >= width && y >= height) {
          end = { x, y, d };
          break rounds;
        }
      }
      trace.push(v.slice(offset - d, offset + d + 1));
    }
    if (end === undefined) {
      // the budget ended: the furthest point of the last full round, and the rest as one change
      exact = false;
      const d = trace.length - 1;
      let x = 0;
      let y = 0;
      if (d >= 0) {
        const band = trace[d]!;
        for (let k = -d; k <= d; k += 2) {
          const fx = band[k + d]!;
          const fy = fx - k;
          if (fx <= width && fy >= 0 && fy <= height && fx + fy > x + y) {
            x = fx;
            y = fy;
          }
        }
      }
      reversed.push([2, height - y], [1, width - x]);
      end = { x, y, d: Math.max(0, d) };
    }
    let { x, y } = end;
    for (let d = end.d; d > 0; d -= 1) {
      const band = trace[d - 1]!;
      const k = x - y;
      const before = (kk: number): number => band[kk + d - 1]!;
      const down = k === -d || (k !== d && before(k - 1) < before(k + 1));
      const fromK = down ? k + 1 : k - 1;
      const fromX = before(fromK);
      const fromY = fromX - fromK;
      const moved = down ? fromX : fromX + 1;
      reversed.push([0, x - moved], down ? [2, 1] : [1, 1]);
      x = fromX;
      y = fromY;
    }
    reversed.push([0, x]);
  }
  reversed.push([0, head]);
  const runs: Run[] = [];
  for (let at = reversed.length - 1; at >= 0; at -= 1) {
    const [op, count] = reversed[at]!;
    if (count <= 0) continue;
    const last = runs.at(-1);
    if (last !== undefined && last.op === op)
      runs[runs.length - 1] = { op, count: last.count + count };
    else runs.push({ op, count });
  }
  return { runs, exact };
};

/** This function gives a number for each value, equal numbers for equal values. */
const numberer = (): ((value: string) => number) => {
  const ids = new Map<string, number>();
  return (value) => {
    let id = ids.get(value);
    if (id === undefined) {
      id = ids.size;
      ids.set(value, id);
    }
    return id;
  };
};

/** A token is a word, a run of spaces, or one sign. */
const TOKEN = /\s+|[\p{L}\p{N}\p{M}_]+|[^\s\p{L}\p{N}\p{M}_]/gu;

const tokensOf = (line: string): string[] => line.match(TOKEN) ?? [];

/** This function counts the words of a text: each token that is not a space. */
const wordsOf = (text: string): number => {
  let count = 0;
  for (const token of tokensOf(text)) if (!/^\s+$/.test(token)) count += 1;
  return count;
};

/** This function gives the word diff of a changed line, or null when the line is too long or the budget ended. */
const wordDiff = (
  before: string,
  after: string,
  budget: Budget,
  limits: DiffLimits,
): { readonly parts: WordPart[]; readonly exact: boolean } | null => {
  if (budget.steps >= budget.max) return null;
  const a = tokensOf(before);
  const b = tokensOf(after);
  if (a.length > limits.maxLineWords || b.length > limits.maxLineWords) return null;
  const id = numberer();
  const script = editScript(
    a.map((token) => id(token)),
    b.map((token) => id(token)),
    budget,
  );
  const parts: WordPart[] = [];
  const push = (op: WordPart["op"], text: string): void => {
    const last = parts.at(-1);
    if (last !== undefined && last.op === op)
      parts[parts.length - 1] = { op, text: last.text + text };
    else parts.push({ op, text });
  };
  let i = 0;
  let j = 0;
  for (const run of script.runs) {
    if (run.op === 0) {
      push("same", a.slice(i, i + run.count).join(""));
      i += run.count;
      j += run.count;
    } else if (run.op === 1) {
      push("removed", a.slice(i, i + run.count).join(""));
      i += run.count;
    } else {
      push("added", b.slice(j, j + run.count).join(""));
      j += run.count;
    }
  }
  return { parts, exact: script.exact };
};

/** One line of the full diff, before the hunks: its kind and its positions in the old and the new text. */
type Entry =
  | { readonly op: "same"; readonly a: number; readonly b: number }
  | { readonly op: "removed"; readonly a: number }
  | { readonly op: "added"; readonly b: number }
  | {
      readonly op: "changed";
      readonly a: number;
      readonly b: number;
      readonly words: readonly WordPart[] | null;
    };

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const keyPath = (path: string, key: string): string =>
  IDENTIFIER.test(key) ? (path === "" ? key : `${path}.${key}`) : `${path}[${JSON.stringify(key)}]`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** This function gives the changes at paths between two values, to the limits. */
const metaChanges = (
  before: unknown,
  after: unknown,
  limits: DiffLimits,
): { readonly changes: MetaChange[]; readonly count: number } => {
  const changes: MetaChange[] = [];
  let count = 0;
  const show = (value: unknown): string => {
    const text = stableStringify(value);
    return text.length > limits.maxValueChars ? `${text.slice(0, limits.maxValueChars)}…` : text;
  };
  const note = (path: string, change: MetaChange["change"], a: unknown, b: unknown): void => {
    count += 1;
    if (changes.length < limits.maxMetaChanges) {
      changes.push({
        path,
        change,
        before: change === "added" ? null : show(a),
        after: change === "removed" ? null : show(b),
      });
    }
  };
  // each array diff has a small budget of its own, so the metadata stays bounded too
  const walk = (a: unknown, b: unknown, path: string, depth: number): void => {
    if (a === b) return;
    if (depth >= limits.maxMetaDepth) {
      if (stableStringify(a) !== stableStringify(b)) note(path, "changed", a, b);
      return;
    }
    if (isRecord(a) && isRecord(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) {
        const inA = Object.hasOwn(a, key) && a[key] !== undefined;
        const inB = Object.hasOwn(b, key) && b[key] !== undefined;
        const at = keyPath(path, key);
        if (inA && !inB) note(at, "removed", a[key], undefined);
        else if (!inA && inB) note(at, "added", undefined, b[key]);
        else if (inA && inB) walk(a[key], b[key], at, depth + 1);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const id = numberer();
      const script = editScript(
        a.map((item) => id(stableStringify(item))),
        b.map((item) => id(stableStringify(item))),
        { steps: 0, max: 100_000 },
      );
      let i = 0;
      let j = 0;
      const removed: number[] = [];
      const added: number[] = [];
      const flush = (): void => {
        const pairs = Math.min(removed.length, added.length);
        for (let at = 0; at < pairs; at += 1) {
          walk(a[removed[at]!], b[added[at]!], `${path}[${String(added[at])}]`, depth + 1);
        }
        for (const at of removed.slice(pairs))
          note(`${path}[${String(at)}]`, "removed", a[at], undefined);
        for (const at of added.slice(pairs))
          note(`${path}[${String(at)}]`, "added", undefined, b[at]);
        removed.length = 0;
        added.length = 0;
      };
      for (const run of script.runs) {
        if (run.op === 0) {
          flush();
          i += run.count;
          j += run.count;
        } else if (run.op === 1) {
          for (let at = 0; at < run.count; at += 1) removed.push(i + at);
          i += run.count;
        } else {
          for (let at = 0; at < run.count; at += 1) added.push(j + at);
          j += run.count;
        }
      }
      flush();
      return;
    }
    if (stableStringify(a) !== stableStringify(b)) note(path, "changed", a, b);
  };
  walk(before, after, "", 0);
  return { changes, count };
};

/** This function gives the limits of a diff, with the defaults of `DIFF_LIMITS` for the limits that it does not get. */
const limitsOf = (given: Partial<DiffLimits>): DiffLimits => {
  const limits: Record<string, number> = { ...DIFF_LIMITS };
  for (const [name, value] of Object.entries(given)) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0)
      throw new RangeError(`the diff limit ${name} must be an integer of 0 or more`);
    limits[name] = value;
  }
  return limits as DiffLimits;
};

/**
 * This function compares two versions: the lines of the text, the words of each changed line, and
 * the fields (the title, the URL and the metadata) at their paths. It writes nothing, and its time
 * and its result stay inside the limits.
 */
export const diffTexts = (
  before: DiffInput,
  after: DiffInput,
  given: Partial<DiffLimits> = {},
): TextDiff => {
  const limits = limitsOf(given);
  const notes: string[] = [];
  let truncated = false;
  const cut = (text: string, side: string): string[] => {
    let kept = text;
    if (kept.length > limits.maxChars) {
      kept = kept.slice(0, limits.maxChars);
      truncated = true;
      notes.push(
        `the ${side} text is longer than ${String(limits.maxChars)} characters, so the diff compares its first part`,
      );
    }
    const lines = kept.length === 0 ? [] : kept.split("\n");
    if (lines.length > limits.maxLines) {
      truncated = true;
      notes.push(
        `the ${side} text has more than ${String(limits.maxLines)} lines, so the diff compares its first lines`,
      );
      return lines.slice(0, limits.maxLines);
    }
    return lines;
  };
  const a = cut(before.text, "old");
  const b = cut(after.text, "new");
  const id = numberer();
  const lineBudget: Budget = { steps: 0, max: limits.maxSteps };
  const script = editScript(
    a.map((line) => id(line)),
    b.map((line) => id(line)),
    lineBudget,
  );
  let exact = script.exact;
  if (!script.exact) {
    notes.push(
      `the change is too large for a minimal diff in ${String(limits.maxSteps)} steps, so the diff shows its last part as one removal and one addition`,
    );
  }
  const wordBudget: Budget = { steps: 0, max: limits.maxWordSteps };
  const entries: Entry[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  let linesChanged = 0;
  let wordsAdded = 0;
  let wordsRemoved = 0;
  let wordsCut = false;
  let i = 0;
  let j = 0;
  const removed: number[] = [];
  const added: number[] = [];
  const flush = (): void => {
    const pairs = Math.min(removed.length, added.length);
    for (let at = 0; at < pairs; at += 1) {
      const from = removed[at]!;
      const to = added[at]!;
      const words = wordDiff(a[from]!, b[to]!, wordBudget, limits);
      if (words === null) {
        wordsCut = true;
        wordsRemoved += wordsOf(a[from]!);
        wordsAdded += wordsOf(b[to]!);
      } else {
        if (!words.exact) exact = false;
        for (const part of words.parts) {
          if (part.op === "added") wordsAdded += wordsOf(part.text);
          else if (part.op === "removed") wordsRemoved += wordsOf(part.text);
        }
      }
      entries.push({ op: "changed", a: from, b: to, words: words?.parts ?? null });
    }
    for (const from of removed.slice(pairs)) {
      wordsRemoved += wordsOf(a[from]!);
      entries.push({ op: "removed", a: from });
    }
    for (const to of added.slice(pairs)) {
      wordsAdded += wordsOf(b[to]!);
      entries.push({ op: "added", b: to });
    }
    linesChanged += pairs;
    removed.length = 0;
    added.length = 0;
  };
  for (const run of script.runs) {
    if (run.op === 0) {
      flush();
      for (let at = 0; at < run.count; at += 1) entries.push({ op: "same", a: i + at, b: j + at });
      i += run.count;
      j += run.count;
    } else if (run.op === 1) {
      for (let at = 0; at < run.count; at += 1) removed.push(i + at);
      linesRemoved += run.count;
      i += run.count;
    } else {
      for (let at = 0; at < run.count; at += 1) added.push(j + at);
      linesAdded += run.count;
      j += run.count;
    }
  }
  flush();
  if (wordsCut) {
    exact = false;
    notes.push("some changed lines have no word diff: they are too long, or the word budget ended");
  }

  // the hunks: each change with its context, and the hunks that touch become one
  const hunks: DiffHunk[] = [];
  let shown = 0;
  let current:
    { lines: DiffLine[]; from: number; to: number; a: number; b: number; end: number } | undefined;
  const lineOf = (entry: Entry): DiffLine => {
    switch (entry.op) {
      case "same":
        return { op: "same", text: a[entry.a]! };
      case "removed":
        return { op: "removed", text: a[entry.a]! };
      case "added":
        return { op: "added", text: b[entry.b]! };
      default:
        return { op: "changed", before: a[entry.a]!, after: b[entry.b]!, words: entry.words };
    }
  };
  const close = (): void => {
    if (current === undefined) return;
    hunks.push({
      from_line: current.from + 1,
      from_count: current.a,
      to_line: current.to + 1,
      to_count: current.b,
      lines: current.lines,
    });
    current = undefined;
  };
  // the position in the old and the new text of each entry
  let posA = 0;
  let posB = 0;
  const positions: Array<readonly [number, number]> = [];
  for (const entry of entries) {
    positions.push([posA, posB]);
    if (entry.op !== "added") posA += 1;
    if (entry.op !== "removed") posB += 1;
  }
  const changeAt: number[] = [];
  for (const [at, entry] of entries.entries()) if (entry.op !== "same") changeAt.push(at);
  let hunkCut = false;
  for (const at of changeAt) {
    if (shown >= limits.maxHunkLines) {
      hunkCut = true;
      break;
    }
    const start = Math.max(0, at - limits.context);
    const stop = Math.min(entries.length - 1, at + limits.context);
    if (current !== undefined && start > current.end + 1) close();
    if (current === undefined) {
      const [fromA, fromB] = positions[start]!;
      current = { lines: [], from: fromA, to: fromB, a: 0, b: 0, end: start - 1 };
    }
    for (let line = current.end + 1; line <= stop; line += 1) {
      if (shown >= limits.maxHunkLines) {
        hunkCut = true;
        break;
      }
      const entry = entries[line]!;
      current.lines.push(lineOf(entry));
      if (entry.op !== "added") current.a += 1;
      if (entry.op !== "removed") current.b += 1;
      current.end = line;
      shown += 1;
    }
  }
  close();
  if (hunkCut) {
    truncated = true;
    notes.push(
      `the hunks show ${String(limits.maxHunkLines)} lines, and the summary counts each line`,
    );
  }

  const fields = metaChanges(before.fields, after.fields, limits);
  if (fields.count > fields.changes.length) {
    truncated = true;
    notes.push(
      `the result shows ${String(fields.changes.length)} of ${String(fields.count)} changes of the metadata`,
    );
  }
  return {
    summary: {
      lines_added: linesAdded,
      lines_removed: linesRemoved,
      lines_changed: linesChanged,
      words_added: wordsAdded,
      words_removed: wordsRemoved,
      meta_changes: fields.count,
    },
    hunks,
    meta: fields.changes,
    same:
      linesAdded === 0 && linesRemoved === 0 && fields.count === 0 && before.text === after.text,
    exact,
    truncated,
    steps: lineBudget.steps + wordBudget.steps,
    notes,
  };
};

// ── the diff of a stored document ───────────────────────────────────────────

/** A version of a document for a diff: a capture id, or the version that was current at a time. */
export type VersionChoice = string | { readonly at: string | Date };

/** These options choose the two versions of a diff. */
export interface DiffOptions {
  /**
   * This version is the old side: a capture id, or `{ at }`. The default is the version before
   * `to` with the same recipe and the same kind of capture (plain or rendered).
   */
  readonly from?: VersionChoice | undefined;
  /** This version is the new side: a capture id, or `{ at }`. The default is the newest version. */
  readonly to?: VersionChoice | undefined;
  /** These values change the limits of the diff (`DIFF_LIMITS`). */
  readonly limits?: Partial<DiffLimits> | undefined;
}

/** This is one side of a diff: the version that it compares. */
export interface DiffSide {
  /** This id is the capture of the version. A citation names it. */
  readonly capture: string;
  /** This time (ISO 8601) is the fetch time of the version. */
  readonly fetched_at: string;
  /** This value is the length of the text of the version. */
  readonly chars: number;
  readonly rendered: boolean;
  /** This value is true when the version is held back, so the diff does not show its text. */
  readonly held_back: boolean;
  /** This time (ISO 8601) is the `at` that chose the version, or null for a capture id or a default. */
  readonly at: string | null;
}

/** The result of a diff of two versions of a stored document. */
export interface DiffResult {
  readonly doc: string;
  readonly url: string | null;
  readonly from: DiffSide;
  readonly to: DiffSide;
  /**
   * This value is true when the two versions have the same text, title, URL and metadata. It is
   * null when a side is held back, because then the diff does not compare the texts.
   */
  readonly same: boolean | null;
  readonly summary: DiffSummary;
  readonly hunks: readonly DiffHunk[];
  readonly meta: readonly MetaChange[];
  /** This value is true when a side is held back. Then the result has no text and no title, and only the structural metadata. */
  readonly held_back: boolean;
  /** This value is true when the line diff is minimal and each changed line has its word diff. */
  readonly exact: boolean;
  /** This value is true when the result leaves out a part. The note tells which part. */
  readonly truncated: boolean;
  /** This value counts the steps of the diff. */
  readonly steps: number;
  readonly note: string | null;
}

/** This function gives the version of a choice, or throws an error that names the problem. */
const chosen = (
  runtime: CrawlRuntime,
  id: string,
  choice: VersionChoice,
): { readonly version: VersionText; readonly at: string | null } => {
  if (typeof choice === "string") {
    const version = runtime.index.versionText(id, choice);
    if (version === undefined)
      throw new Error(`the document ${id} has no version from the capture ${choice}`);
    return { version, at: null };
  }
  if (!isRecord(choice) || choice.at === undefined)
    throw new RangeError("a version is a capture id, or an object with the time at");
  const at = isoTime("at", choice.at);
  const found = versionAtTime(runtime, id, at);
  if (found.version === undefined) {
    throw new Error(
      `the document ${id} has no version at ${at} or before${found.first === undefined ? "" : `: its first capture is from ${found.first}`}`,
    );
  }
  return { version: found.version, at };
};

const sideOf = (version: VersionText, at: string | null, held: boolean): DiffSide => ({
  capture: version.capture,
  fetched_at: version.fetched_at,
  chars: version.chars,
  rendered: version.rendered,
  held_back: held,
  at,
});

/**
 * This function compares two versions of a stored document, and writes nothing. It applies the
 * rule for a held-back document. When the document or a version is held back, the diff compares
 * only the structural metadata, and it shows no text and no title.
 */
export const diffDocument = async (
  runtime: CrawlRuntime,
  id: string,
  options: DiffOptions = {},
): Promise<DiffResult> => {
  await Promise.resolve();
  const doc = runtime.index.get(id);
  if (doc === undefined)
    throw new Error(`no stored document ${id}: find one with find(), or fetch its page`);
  let to: { readonly version: VersionText; readonly at: string | null };
  if (options.to === undefined) {
    const newest = runtime.index.versions(id, { limit: 1 })[0];
    const version =
      newest === undefined ? undefined : runtime.index.versionText(id, newest.capture);
    if (version === undefined) throw new Error(`the document ${id} has no version`);
    to = { version, at: null };
  } else to = chosen(runtime, id, options.to);
  let from: { readonly version: VersionText; readonly at: string | null } | undefined;
  if (options.from === undefined) {
    // the version before, of the same recipe and kind: a render and a plain body are not a change
    const earlier = runtime.index
      .versions(id, { limit: 1000 })
      .find(
        (version) =>
          version.capture !== to.version.capture &&
          version.recipe === to.version.recipe &&
          version.rendered === to.version.rendered &&
          version.fetched_at <= to.version.fetched_at,
      );
    const version =
      earlier === undefined ? undefined : runtime.index.versionText(id, earlier.capture);
    if (version !== undefined) from = { version, at: null };
  } else from = chosen(runtime, id, options.from);
  const notes: string[] = [];
  if (from === undefined) {
    from = to;
    notes.push(`the document ${id} has no earlier version of the same kind to compare`);
  }
  const docHeld = isHeldBack(doc);
  const fromHeld = docHeld || isHeldBack(from.version);
  const toHeld = docHeld || isHeldBack(to.version);
  const held = fromHeld || toHeld;
  const fields = (version: VersionText): Record<string, unknown> =>
    held
      ? { kind: version.kind, url: version.url, meta: heldBackMeta(version.meta) }
      : { title: version.title, kind: version.kind, url: version.url, meta: version.meta };
  const diff = diffTexts(
    { text: held ? "" : from.version.text, fields: fields(from.version) },
    { text: held ? "" : to.version.text, fields: fields(to.version) },
    options.limits ?? {},
  );
  if (held) notes.unshift(HELD_BACK);
  notes.push(...diff.notes);
  return {
    doc: doc.doc,
    url: to.version.url ?? doc.url,
    from: sideOf(from.version, from.at, fromHeld),
    to: sideOf(to.version, to.at, toHeld),
    same: held ? null : diff.same,
    summary: diff.summary,
    hunks: diff.hunks,
    meta: diff.meta,
    held_back: held,
    exact: diff.exact,
    truncated: diff.truncated,
    steps: diff.steps,
    note: notes.length > 0 ? notes.join("; ") : null,
  };
};

/** This function gives the text of the word diff of a changed line: `[-removed-]` and `{+added+}` mark the words. */
const wordsText = (line: Extract<DiffLine, { op: "changed" }>): string =>
  line.words === null
    ? `[-${line.before}-]{+${line.after}+}`
    : line.words
        .map((part) =>
          part.op === "same"
            ? part.text
            : part.op === "added"
              ? `{+${part.text}+}`
              : `[-${part.text}-]`,
        )
        .join("");

/**
 * This function gives the text of a diff for a person or an assistant. The text has the counts, the
 * hunks as a unified diff, and the changes of the metadata. A changed line marks its words with `[-removed-]`
 * and `{+added+}`. The text holds the text of the pages, so the MCP server puts it in an envelope.
 */
export const formatDiff = (diff: Pick<DiffResult, "summary" | "hunks" | "meta">): string => {
  const { summary } = diff;
  const lines: string[] = [
    `the text: ${String(summary.lines_added)} lines added, ${String(summary.lines_removed)} removed (${String(summary.lines_changed)} changed), ${String(summary.words_added)} words added, ${String(summary.words_removed)} removed`,
  ];
  for (const hunk of diff.hunks) {
    lines.push(
      `@@ -${String(hunk.from_line)},${String(hunk.from_count)} +${String(hunk.to_line)},${String(hunk.to_count)} @@`,
    );
    for (const line of hunk.lines) {
      if (line.op === "changed") lines.push(`~ ${wordsText(line)}`);
      else lines.push(`${line.op === "same" ? " " : line.op === "added" ? "+" : "-"} ${line.text}`);
    }
  }
  lines.push(`the metadata: ${String(summary.meta_changes)} changes`);
  for (const change of diff.meta) {
    if (change.change === "added") lines.push(`+ ${change.path}: ${change.after ?? ""}`);
    else if (change.change === "removed") lines.push(`- ${change.path}: ${change.before ?? ""}`);
    else lines.push(`~ ${change.path}: ${change.before ?? ""} -> ${change.after ?? ""}`);
  }
  return lines.join("\n");
};
