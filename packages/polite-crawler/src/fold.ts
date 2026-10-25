/**
 * This module makes two forms of a text equal when a reader thinks that they are equal. It has two
 * modes:
 *
 * - `quote`: for the verification of a quote. It applies NFKC (a ligature `ﬁ` is `fi`, a
 *   fullwidth `Ａ` is `A`, an ellipsis `…` is `...`) to each character and its combining marks,
 *   thus NFC and NFD are equal. It removes soft hyphens and zero-width characters. It makes
 *   typographic quotes, dashes and the minus sign ASCII, makes each run of spaces one space, and
 *   makes the letters lowercase. Accents stay, so "résumé" is not "resume".
 * - `search`: for the search index. It also removes the accents and the other nonspacing marks,
 *   and it folds the case fully (`ß` is `ss`). It puts a space around each Chinese, Japanese and
 *   Thai character, because these scripts write no space between words.
 *
 * Each character of the folded text knows the start and the end of its source in the original
 * text. Thus a match in the folded text gives exact positions in the original text.
 */

export type FoldMode = "quote" | "search";

/** A folded text, with the position in the original text of each UTF-16 unit. */
export interface Folded {
  readonly text: string;
  /** This value is the start, in the original text, of the source of each unit. */
  readonly start: Int32Array;
  /** This value is the end, in the original text, of the source of each unit. */
  readonly end: Int32Array;
}

const MARK = /\p{M}/u;
const NONSPACING = /[\p{Mn}\p{Me}]/gu;
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const SPACE = /^\s$/u;
const SEGMENTED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** These characters become ASCII: typographic quotes, dashes and the minus sign. */
const TYPOGRAPHIC: ReadonlyMap<number, number> = new Map([
  [0x2018, 0x27],
  [0x2019, 0x27],
  [0x201a, 0x27],
  [0x201b, 0x27],
  [0x2032, 0x27],
  [0x201c, 0x22],
  [0x201d, 0x22],
  [0x201e, 0x22],
  [0x201f, 0x22],
  [0x2033, 0x22],
  [0x2010, 0x2d],
  [0x2011, 0x2d],
  [0x2012, 0x2d],
  [0x2013, 0x2d],
  [0x2014, 0x2d],
  [0x2015, 0x2d],
  [0x2212, 0x2d],
  [0xfe58, 0x2d],
  [0xfe63, 0x2d],
]);

const isAsciiSpace = (code: number): boolean => code === 0x20 || (code >= 0x09 && code <= 0x0d);

/**
 * This function folds a text, and it keeps the position in the original text of each unit of the
 * result. Its time is linear. An ASCII character with no combining mark after it takes a short path.
 */
export const foldText = (text: string, mode: FoldMode): Folded => {
  let codes = new Uint16Array(Math.max(16, text.length + 16));
  let starts = new Int32Array(codes.length);
  let ends = new Int32Array(codes.length);
  let size = 0;
  let space = true;
  const grow = (need: number): void => {
    if (size + need <= codes.length) return;
    const length = Math.max(codes.length * 2, size + need);
    const nextCodes = new Uint16Array(length);
    nextCodes.set(codes.subarray(0, size));
    const nextStarts = new Int32Array(length);
    nextStarts.set(starts.subarray(0, size));
    const nextEnds = new Int32Array(length);
    nextEnds.set(ends.subarray(0, size));
    codes = nextCodes;
    starts = nextStarts;
    ends = nextEnds;
  };
  const push = (code: number, from: number, to: number): void => {
    grow(1);
    codes[size] = code;
    starts[size] = from;
    ends[size] = to;
    size += 1;
  };
  const pushSpace = (from: number, to: number): void => {
    if (space) return;
    push(0x20, from, to);
    space = true;
  };
  const length = text.length;
  let index = 0;
  while (index < length) {
    const code = text.charCodeAt(index);
    const next = index + 1 < length ? text.charCodeAt(index + 1) : 0;
    // the short path: an ASCII character that no combining mark follows
    if (code < 0x80 && next < 0x300) {
      if (isAsciiSpace(code)) pushSpace(index, index + 1);
      else {
        push(code >= 0x41 && code <= 0x5a ? code + 32 : code, index, index + 1);
        space = false;
      }
      index += 1;
      continue;
    }
    // a cluster: one code point and the combining marks after it
    const point = text.codePointAt(index)!;
    let end = index + (point > 0xffff ? 2 : 1);
    while (end < length) {
      const mark = text.codePointAt(end)!;
      if (!MARK.test(String.fromCodePoint(mark))) break;
      end += mark > 0xffff ? 2 : 1;
    }
    const cluster = text.slice(index, end);
    const first = String.fromCodePoint(point);
    if (IGNORABLE.test(first) && end === index + first.length) {
      index = end;
      continue;
    }
    if (SPACE.test(first)) {
      pushSpace(index, end);
      index = end;
      continue;
    }
    let folded =
      mode === "quote"
        ? cluster.normalize("NFKC").toLowerCase()
        : cluster
            .normalize("NFKD")
            .replace(NONSPACING, "")
            .normalize("NFC")
            .toUpperCase()
            .toLowerCase();
    if (mode === "search" && SEGMENTED.test(first)) folded = ` ${folded} `;
    for (let at = 0; at < folded.length; at += 1) {
      let unit = folded.charCodeAt(at);
      unit = TYPOGRAPHIC.get(unit) ?? unit;
      if (unit === 0x20 || (unit < 0x80 && isAsciiSpace(unit)) || unit === 0xa0) {
        pushSpace(index, end);
        continue;
      }
      push(unit, index, end);
      space = false;
    }
    index = end;
  }
  if (size > 0 && codes[size - 1] === 0x20) size -= 1;
  let result = "";
  for (let at = 0; at < size; at += 8192) {
    result += String.fromCharCode(...codes.subarray(at, Math.min(size, at + 8192)));
  }
  return { text: result, start: starts.subarray(0, size), end: ends.subarray(0, size) };
};

/** This function gives the folded text alone, for a text with no need of positions. */
export const fold = (text: string, mode: FoldMode): string => foldText(text, mode).text;

/** @beta */
export interface Verified {
  readonly found: boolean;
  /** These values are the character positions in the text of the document, when the quote is there. */
  readonly start: number | null;
  readonly end: number | null;
  /** This text is the exact quote as stored, with some text before and after it. */
  readonly excerpt: string | null;
  /** This value is the number of places where the quote is, with no overlap. */
  readonly count: number;
}

const NOT_FOUND: Verified = { found: false, start: null, end: null, excerpt: null, count: 0 };

/** This function moves a position off the second half of a surrogate pair, so a slice does not cut a character. */
const atBoundary = (text: string, position: number, forward: boolean): number => {
  const code = text.charCodeAt(position);
  if (position > 0 && position < text.length && code >= 0xdc00 && code <= 0xdfff) {
    return forward ? position + 1 : position - 1;
  }
  return position;
};

/**
 * This function finds a quote in a text, in the `quote` mode of `foldText`. It ignores case, runs
 * of spaces, typographic punctuation, soft hyphens, zero-width characters and the differences of
 * NFKC, NFC and NFD. The positions are in the original text.
 *
 * @beta
 */
export const locate = (text: string, quote: string): Verified => {
  const needle = fold(quote, "quote");
  if (needle.length === 0) return NOT_FOUND;
  const haystack = foldText(text, "quote");
  const hit = haystack.text.indexOf(needle);
  if (hit === -1) return NOT_FOUND;
  let count = 0;
  for (let at = hit; at !== -1; at = haystack.text.indexOf(needle, at + needle.length)) count += 1;
  const start = haystack.start[hit]!;
  const end = haystack.end[hit + needle.length - 1]!;
  const from = atBoundary(text, Math.max(0, start - 80), false);
  const to = atBoundary(text, Math.min(text.length, end + 80), true);
  return {
    found: true,
    start,
    end,
    excerpt: `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`,
    count,
  };
};

/** A token character of the search index: a letter, a digit, a private-use character or a spacing mark. */
const TOKEN_SPLIT = /[^\p{L}\p{N}\p{Co}\p{Mc}]+/u;

/** This function gives the tokens of a text, as the search index reads them. */
export const tokensOf = (text: string): string[] =>
  fold(text, "search")
    .split(TOKEN_SPLIT)
    .filter((token) => token.length > 0);

/** A query for the search index, in the two forms that `DocIndex.find` uses. */
export interface FtsQuery {
  /** Each part must match: the parts joined with AND. */
  readonly all: string;
  /** One part is enough: the parts joined with OR. */
  readonly any: string;
  /** These are the parts of `any`, each as FTS5 syntax. */
  readonly anyParts: readonly string[];
  /** These are the first tokens of the parts. A snippet marks them. */
  readonly terms: readonly string[];
  /** This value is the number of parts. */
  readonly parts: number;
}

const MAX_PARTS = 16;

/** This function removes the stars at the end of a word. It uses no regular expression, so its time is linear. */
const withoutStars = (word: string): string => {
  let end = word.length;
  while (end > 0 && word.charCodeAt(end - 1) === 0x2a) end -= 1;
  return word.slice(0, end);
};

/**
 * These English words are in almost every document. In the form that needs one part, they match
 * each document and cost the most time. Thus that form leaves them out when other words remain.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
]);

/**
 * This function reads a search query. The syntax:
 *
 * - A word is a term. The index folds case, accents and Unicode forms, so `cafe` finds `Café`. It
 *   reduces English words to their stems, so `baking` finds `bake`.
 * - Text in double quotes is a phrase: its words must be next to each other.
 * - A `*` at the end of a word asks for a prefix: `bake*` finds `bakery`.
 * - A word of Chinese, Japanese or Thai is a phrase of its characters, so it matches in the text.
 * - Other punctuation is not syntax. The words `AND`, `OR`, `NOT` and `NEAR` are words.
 *
 * The function gives no query for a text with no word. It reads 16 parts or fewer. Each part is
 * quoted, so the text of a user cannot become FTS5 syntax. The form that needs one part (`any`)
 * leaves out the common English words (`STOP_WORDS`) when other words remain.
 */
export const parseQuery = (q: string): FtsQuery | undefined => {
  const parts: Array<{ readonly text: string; readonly term: string; readonly stop: boolean }> = [];
  for (const match of q.matchAll(/"([^"]*)"(\*?)|([^\s"]+)/g)) {
    if (parts.length >= MAX_PARTS) break;
    const phrase = match[1] !== undefined;
    const raw = phrase ? match[1]! : match[3]!;
    const prefix = phrase ? match[2] === "*" : raw.endsWith("*");
    const tokens = tokensOf(phrase ? raw : withoutStars(raw));
    if (tokens.length === 0) continue;
    parts.push({
      text: `"${tokens.join(" ")}"${prefix ? " *" : ""}`,
      term: tokens[0]!,
      stop: !phrase && !prefix && tokens.length === 1 && STOP_WORDS.has(tokens[0]!),
    });
  }
  if (parts.length === 0) return undefined;
  const words = parts.filter((part) => !part.stop);
  const any = words.length > 0 ? words : parts;
  return {
    all: parts.map((part) => part.text).join(" AND "),
    any: any.map((part) => part.text).join(" OR "),
    anyParts: any.map((part) => part.text),
    terms: any.map((part) => part.term),
    parts: parts.length,
  };
};

/** This function gives the FTS5 query that matches one part or more of a query. It is the form of version 0.1. */
export const ftsQuery = (q: string): string | undefined => parseQuery(q)?.any;

/**
 * This function gives a short part of a text around the first match of a term, with the match in
 * square brackets. With no match, it gives the start of the text.
 */
export const snippetOf = (text: string, terms: readonly string[], width = 160): string => {
  if (text.length === 0) return "";
  let start = -1;
  let end = -1;
  const lower = text.toLowerCase();
  if (lower.length === text.length) {
    for (const term of terms) {
      const at = lower.indexOf(term);
      if (at !== -1 && (start === -1 || at < start)) {
        start = at;
        end = at + term.length;
      }
    }
  }
  if (start === -1) {
    const folded = foldText(text, "search");
    for (const term of terms) {
      const at = folded.text.indexOf(term);
      if (at !== -1) {
        const from = folded.start[at]!;
        if (start === -1 || from < start) {
          start = from;
          end = folded.end[at + term.length - 1]!;
        }
      }
    }
  }
  if (start === -1) {
    const cut = atBoundary(text, Math.min(text.length, width), false);
    return `${text.slice(0, cut)}${cut < text.length ? "…" : ""}`;
  }
  const from = atBoundary(text, Math.max(0, start - Math.floor(width / 3)), false);
  const to = atBoundary(text, Math.min(text.length, end + Math.ceil((width * 2) / 3)), true);
  const clean = (part: string): string => part.replace(/\s+/g, " ");
  return `${from > 0 ? "…" : ""}${clean(text.slice(from, start))}[${clean(text.slice(start, end))}]${clean(text.slice(end, to))}${to < text.length ? "…" : ""}`;
};
