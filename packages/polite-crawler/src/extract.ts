import type { VersionText } from "./docs.ts";
import type { Archived } from "./fallback.ts";
import { archivedNote, archivedOf } from "./fallback.ts";
import type { Folded } from "./fold.ts";
import { fold, foldText } from "./fold.ts";
import { typesOf } from "./html.ts";
import type { CrawlRuntime } from "./runtime.ts";
// the time travel of `read` and `verify` chooses the version, so the three agree
import { HELD_BACK, isHeldBack, isoTime, recordOverride, versionAtTime } from "./runtime.ts";
import type { AiInput } from "./signals.ts";
import { canonicalUrl } from "./urls.ts";

/**
 * The field check takes the values that a caller proposes for the fields of a stored page. It finds
 * each value in the stored text or in the JSON-LD. A model or a person gives the values. The check
 * does not make values: it only checks and locates the values that it gets.
 *
 * Each field gets one status:
 *
 * - `verified`: the stored text holds the exact value. The result gives the span (or the JSON-LD
 *   path) and the capture.
 * - `normalized`: the stored text holds the value under a stated normalization, for example a
 *   different number format. The result names the normalization and gives the span of the stored text.
 * - `ambiguous`: the value matches, but the stored text does not give one meaning. The result gives
 *   each span, and it does not choose one.
 * - `not-found`: the stored text does not hold the value.
 * - `held-back`: the page asked not to be AI input. The result tells nothing about the value.
 * - `invalid`: the value is not a value of its kind, so the check did not search for it.
 *
 * The time of the check is linear in the length of the text, for a fixed set of fields.
 */

// ── the public types ────────────────────────────────────────────────────────

/** The kinds of field that the check reads. `json-ld:<path>` reads a value at a path of the JSON-LD, for example `json-ld:Product.offers.price`. */
export type FieldKind =
  "text" | "number" | "money" | "date" | "url" | "email" | "phone" | `json-ld:${string}`;

/**
 * These kinds read the text of the page. The kind `json-ld:<path>` reads the JSON-LD.
 *
 * @beta
 */
export const FIELD_KINDS: readonly string[] = [
  "text",
  "number",
  "money",
  "date",
  "url",
  "email",
  "phone",
];

/** This is the value that a caller proposes for one field. */
export interface FieldClaim {
  /** This value is the proposal. The check removes the spaces at its start and at its end. */
  readonly value: string | number;
  /** This value is the kind of the field. The default is `number` for a number and `text` for a text. */
  readonly kind?: FieldKind | undefined;
}

/** The status of one field. The module comment of `extract.ts` and the README tell what each status means. */
export type FieldStatus =
  "verified" | "normalized" | "ambiguous" | "not-found" | "held-back" | "invalid";

/** These positions locate a value in the text of a version. The end is not part of the value. */
export interface FieldSpan {
  readonly start: number;
  readonly end: number;
  /** This value is `full_text` when the value is only in the whole text of a page that the reader cut. */
  readonly in: "text" | "full_text";
}

/** This is one place that an ambiguous field matches. */
export interface FieldCandidate {
  readonly span: FieldSpan | null;
  /** This path locates a value of the JSON-LD (`jsonld[0].offers[1].price`) or a stored link (`links[3]`). */
  readonly path: string | null;
  /** This value is the exact stored text, or the stored value of the JSON-LD. */
  readonly raw: string | number | boolean;
  readonly excerpt: string;
  /** These are the meanings that the stored text can have, for example two dates for `03/04/2026`. */
  readonly readings: readonly string[];
}

/** This is the check of one field, before the runtime adds the capture. */
export interface FieldCheck {
  readonly status: FieldStatus;
  /** This value is the kind that the check used. */
  readonly kind: string;
  readonly span: FieldSpan | null;
  readonly path: string | null;
  /** This value is the exact stored text of the match, or the stored value of the JSON-LD. */
  readonly raw: string | number | boolean | null;
  /** This text is the stored text around the match. */
  readonly excerpt: string | null;
  /** This value names the normalization of a `normalized` match, for example `thousands-separator`. Two or more names are joined with `+`. */
  readonly normalization: string | null;
  /** This value is the meaning of the stored text that matched, for example `1234.5` or `2026-03-04`. */
  readonly reading: string | null;
  /** This value is the number of places that match. */
  readonly count: number;
  /** These are the places of an ambiguous field, one for each meaning, 5 or fewer. */
  readonly candidates: readonly FieldCandidate[];
  readonly note: string | null;
}

/** This is the result of one field: the check, and the capture of the text that the check read. */
export interface FieldResult extends FieldCheck {
  readonly capture: string | null;
  /** This time (ISO 8601) is the fetch time of that capture. */
  readonly fetched_at: string | null;
}

/** These are the counts of the statuses of the fields. */
export interface ExtractSummary {
  readonly fields: number;
  readonly verified: number;
  readonly normalized: number;
  readonly ambiguous: number;
  readonly not_found: number;
  readonly held_back: number;
  readonly invalid: number;
}

/**
 * This is the text of a document that `checkFields` reads, with its metadata.
 *
 * @beta
 */
export interface ExtractSource {
  readonly text: string;
  /** This text is the whole text of a page that the reader cut. The check reads it when the value is not in `text`. */
  readonly full_text?: string | undefined;
  /** This URL is the address of the page. The check resolves a relative URL against it. */
  readonly url?: string | null | undefined;
  /** The check reads `jsonld`, `jsonld_dropped`, `links` and `truncated` of this metadata. */
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * This is the result of `checkFields`.
 *
 * @beta
 */
export interface FieldsChecked {
  readonly fields: Readonly<Record<string, FieldCheck>>;
  readonly summary: ExtractSummary;
  /** This value counts the units of work of the check. It grows in proportion to the length of the text. */
  readonly steps: number;
}

/** These options control a check of fields against a stored document. */
export interface ExtractOptions {
  /** This id checks the version of one capture, not the current version. */
  readonly capture?: string | undefined;
  /**
   * This time checks the version that was current at that time: an ISO 8601 text or a `Date`. A date
   * with no time is the start of that day in UTC. Give `capture` or `at`, not the two.
   */
  readonly at?: string | Date | undefined;
  /** This value is true when a person gave this URL directly. It is the only way to check a held-back document. The crawler logs it. */
  readonly userProvided?: boolean | undefined;
}

/** This is the result of a check of fields against a stored document. */
export interface ExtractResult {
  readonly doc: string;
  readonly url: string | null;
  readonly captures: readonly string[];
  /** This id is the capture of the text that the check read. A held-back document gives null. */
  readonly capture: string | null;
  /** This hash is the blob of that capture. */
  readonly blob: string | null;
  /** This time (ISO 8601) is the fetch time of that capture. */
  readonly fetched_at: string | null;
  readonly held_back: boolean;
  /** These are the results of the fields, with the names that the caller gave. */
  readonly fields: Readonly<Record<string, FieldResult>>;
  readonly summary: ExtractSummary;
  readonly note: string | null;
  /** This time (ISO 8601) is the `at` of the check. The result has it only when the check gave `at`. */
  readonly at?: string | undefined;
  /** This value is true when `at` is before the first capture of the document. Then no field is found. */
  readonly before_first?: boolean | undefined;
  /**
   * This value tells that the checked text is an archived copy, with the archive and the date of the
   * copy. The note says so too. A citation of a value names the archive and that date.
   */
  readonly archived?: Archived | undefined;
}

// ── the work counter and the stored text ────────────────────────────────────

interface Work {
  steps: number;
}

/** A text of the document, folded one time for each check, with the tokens of each kind. */
interface Doc {
  readonly name: "text" | "full_text";
  readonly text: string;
  readonly folded: Folded;
  readonly cache: Map<string, unknown>;
}

const prepare = (name: "text" | "full_text", text: string, work: Work): Doc => {
  // foldText is linear: each unit of the text gives a constant number of units of work
  work.steps += text.length;
  return { name, text, folded: foldText(text, "quote"), cache: new Map() };
};

const cached = <T>(doc: Doc, key: string, make: () => T): T => {
  if (doc.cache.has(key)) return doc.cache.get(key) as T;
  const value = make();
  doc.cache.set(key, value);
  return value;
};

/** This function gives the original span of the folded units from `i` to `j`. */
const spanOf = (doc: Doc, i: number, j: number): FieldSpan => ({
  start: doc.folded.start[i]!,
  end: doc.folded.end[j - 1]!,
  in: doc.name,
});

const EXCERPT = 60;

/** This function moves a position off the second half of a surrogate pair. */
const onBoundary = (text: string, position: number, forward: boolean): number => {
  const code = text.charCodeAt(position);
  if (position > 0 && position < text.length && code >= 0xdc00 && code <= 0xdfff) {
    return forward ? position + 1 : position - 1;
  }
  return position;
};

const excerptOf = (text: string, start: number, end: number): string => {
  const from = onBoundary(text, Math.max(0, start - EXCERPT), false);
  const to = onBoundary(text, Math.min(text.length, end + EXCERPT), true);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
};

const isDigitCode = (code: number): boolean => code >= 48 && code <= 57;
const isDigitAt = (text: string, at: number): boolean =>
  at >= 0 && at < text.length && isDigitCode(text.charCodeAt(at));
const WORD = /^[\p{L}\p{N}]$/u;
/** This function tells if the unit at a position is a letter or a digit. */
const isWordAt = (text: string, at: number): boolean => {
  if (at < 0 || at >= text.length) return false;
  const code = text.charCodeAt(at);
  if (code < 0x80) {
    return isDigitCode(code) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
  }
  return WORD.test(text[at]!);
};
const isLetterAt = (text: string, at: number): boolean =>
  isWordAt(text, at) && !isDigitAt(text, at);

// ── the decision ────────────────────────────────────────────────────────────

interface Where {
  readonly span: FieldSpan | null;
  readonly path: string | null;
}

/** A place of the stored data that can hold a value of a kind, with its meanings. */
interface Cand<R> {
  readonly where: Where;
  readonly raw: string | number | boolean;
  /** This text is the exact stored text, for the exact comparison. */
  readonly exact: string;
  readonly excerpt: () => string;
  readonly readings: readonly R[];
  /** This part of the place also matches exactly, for example the amount of a money value. */
  readonly alt?: { readonly where: Where; readonly exact: string } | undefined;
}

/** The comparison of one meaning of the value with one meaning of the stored text. */
interface Compared {
  /** This value is false when the stored text says less than the value, for example a date with no year. */
  readonly clean: boolean;
  readonly key: string;
  readonly reading: string;
  readonly labels: readonly string[];
}

interface Comparator<C, R> {
  readonly compare: (claim: C, reading: R) => Compared | undefined;
  readonly display: (reading: R) => string;
  /** This function tells if two matches have one meaning. The default compares the keys. */
  readonly same?: (a: Compared, b: Compared) => boolean;
}

const MAX_CANDIDATES = 5;

const LABEL_ORDER = [
  "unicode",
  "whitespace",
  "case",
  "thousands-separator",
  "decimal-comma",
  "number-form",
  "currency-symbol",
  "currency-position",
  "amount-only",
  "date-iso",
  "date-ymd",
  "date-dmy",
  "date-mdy",
  "date-numeric",
  "date-written",
  "date-form",
  "date-partial",
  "url-resolved",
  "url-scheme",
  "url-form",
  "email-case",
  "phone-digits",
  "phone-suffix",
];

const labelText = (labels: Iterable<string>): string => {
  const set = new Set(labels);
  return LABEL_ORDER.filter((label) => set.has(label)).join("+");
};

const empty = (status: FieldStatus, kind: string, note: string | null = null): FieldCheck => ({
  status,
  kind,
  span: null,
  path: null,
  raw: null,
  excerpt: null,
  normalization: null,
  reading: null,
  count: 0,
  candidates: [],
  note,
});

interface Matched<R> {
  readonly cand: Cand<R>;
  readonly compared: Compared;
  readonly clean: boolean;
}

/**
 * This function decides the status of a field from its places. An exact match wins. A normalized
 * match needs one meaning: two meanings, or a place that the text does not make clear, give
 * `ambiguous`. The cost is linear in the number of places.
 */
const decide = <C, R>(
  kind: string,
  claimText: string,
  claims: readonly C[],
  cands: readonly Cand<R>[],
  comparator: Comparator<C, R>,
  work: Work,
): FieldCheck => {
  let exactCount = 0;
  let exactFirst:
    { readonly where: Where; readonly cand: Cand<R>; readonly raw: string } | undefined;
  for (const cand of cands) {
    work.steps += 1;
    if (cand.exact === claimText) {
      exactCount += 1;
      exactFirst ??= { where: cand.where, cand, raw: cand.exact };
    } else if (cand.alt !== undefined && cand.alt.exact === claimText) {
      exactCount += 1;
      exactFirst ??= { where: cand.alt.where, cand, raw: cand.alt.exact };
    }
  }
  if (exactFirst !== undefined) {
    const reading = exactFirst.cand.readings[0];
    return {
      ...empty("verified", kind),
      span: exactFirst.where.span,
      path: exactFirst.where.path,
      raw: exactFirst.where === exactFirst.cand.where ? exactFirst.cand.raw : exactFirst.raw,
      excerpt: exactFirst.cand.excerpt(),
      reading:
        exactFirst.cand.readings.length === 1 && reading !== undefined
          ? comparator.display(reading)
          : null,
      count: exactCount,
    };
  }
  const matches: Matched<R>[] = [];
  for (const cand of cands) {
    let best: Compared | undefined;
    for (const reading of cand.readings) {
      for (const claim of claims) {
        work.steps += 1;
        const compared = comparator.compare(claim, reading);
        if (compared !== undefined && (best === undefined || (compared.clean && !best.clean)))
          best = compared;
      }
    }
    if (best === undefined) continue;
    matches.push({
      cand,
      compared: best,
      clean: best.clean && cand.readings.length === 1 && claims.length === 1,
    });
  }
  if (matches.length === 0) return empty("not-found", kind);
  const same = comparator.same ?? ((a: Compared, b: Compared): boolean => a.key === b.key);
  const candidateOf = (match: Matched<R>): FieldCandidate => ({
    span: match.cand.where.span,
    path: match.cand.where.path,
    raw: match.cand.raw,
    excerpt: match.cand.excerpt(),
    readings: match.cand.readings.map(comparator.display),
  });
  const clean = matches.filter((match) => match.clean);
  if (clean.length > 0) {
    // one representative of each meaning; two are enough to know that the field is ambiguous
    const meanings: Matched<R>[] = [];
    for (const match of clean) {
      work.steps += 1;
      if (meanings.some((known) => same(known.compared, match.compared))) continue;
      if (meanings.length < MAX_CANDIDATES) meanings.push(match);
      else break;
    }
    const first = clean[0]!;
    if (meanings.length === 1) {
      return {
        ...empty("normalized", kind),
        span: first.cand.where.span,
        path: first.cand.where.path,
        raw: first.cand.raw,
        excerpt: first.cand.excerpt(),
        normalization: labelText(first.compared.labels),
        reading: first.compared.reading,
        count: clean.length,
      };
    }
    return {
      ...empty(
        "ambiguous",
        kind,
        "the value matches places with different meanings, so the check does not choose one",
      ),
      count: clean.length,
      candidates: meanings.map(candidateOf),
    };
  }
  const note =
    claims.length > 1
      ? "the value itself has more than one meaning: give it in a form with one meaning"
      : "the stored text matches, but it does not give one meaning, so the check does not choose one";
  return {
    ...empty("ambiguous", kind, note),
    count: matches.length,
    candidates: matches.slice(0, MAX_CANDIDATES).map(candidateOf),
  };
};

// ── text ────────────────────────────────────────────────────────────────────

/** This function gives each start of a needle in a text, in linear time (Knuth, Morris and Pratt). */
const occurrences = (hay: string, needle: string, work: Work): number[] => {
  const m = needle.length;
  const fail = new Int32Array(m);
  for (let q = 0, i = 1; i < m; i += 1) {
    while (q > 0 && needle.charCodeAt(i) !== needle.charCodeAt(q)) {
      q = fail[q - 1]!;
      work.steps += 1;
    }
    if (needle.charCodeAt(i) === needle.charCodeAt(q)) q += 1;
    fail[i] = q;
    work.steps += 1;
  }
  const hits: number[] = [];
  for (let q = 0, i = 0; i < hay.length; i += 1) {
    while (q > 0 && hay.charCodeAt(i) !== needle.charCodeAt(q)) {
      q = fail[q - 1]!;
      work.steps += 1;
    }
    if (hay.charCodeAt(i) === needle.charCodeAt(q)) q += 1;
    work.steps += 1;
    if (q === m) {
      hits.push(i - m + 1);
      q = fail[q - 1]!;
    }
  }
  return hits;
};

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const QUOTES = /[‘’‚‛′]/g;
const DOUBLE_QUOTES = /[“”„‟″]/g;
const DASHES = /[‐‑‒–—―−﹘﹣]/g;

/** This function applies the Unicode part of the fold: NFKC, no ignorable characters, and ASCII quotes and dashes. */
const unicodeForm = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(IGNORABLE, "")
    .replace(QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-");
const spaceForm = (text: string): string => text.replace(/\s+/gu, " ").trim();

const LAYER_SETS: ReadonlyArray<readonly ("unicode" | "whitespace" | "case")[]> = [
  ["unicode"],
  ["whitespace"],
  ["case"],
  ["unicode", "whitespace"],
  ["unicode", "case"],
  ["whitespace", "case"],
];

/** This function names the parts of the fold that make the stored text equal to the value. */
const textLabels = (stored: string, value: string): string[] => {
  const apply = (text: string, layers: readonly string[]): string => {
    let out = text;
    if (layers.includes("unicode")) out = unicodeForm(out);
    if (layers.includes("whitespace")) out = spaceForm(out);
    if (layers.includes("case")) out = out.toLowerCase();
    return out;
  };
  for (const layers of LAYER_SETS) {
    if (apply(stored, layers) === apply(value, layers)) return [...layers];
  }
  return ["unicode", "whitespace", "case"];
};

/**
 * This function finds a text value in a text, with the fold of `verify`. A match must start and
 * end at the edge of a word. The positions are in the original text.
 */
const checkText = (doc: Doc, claim: string, work: Work): FieldCheck => {
  const needle = fold(claim, "quote");
  if (needle.length === 0) return empty("invalid", "text", "the value has no text");
  const hay = doc.folded.text;
  const hits = occurrences(hay, needle, work);
  const wordStart = isWordAt(needle, 0);
  const wordEnd = isWordAt(needle, needle.length - 1);
  let count = 0;
  let next = 0;
  let firstExact: FieldSpan | undefined;
  let first: FieldSpan | undefined;
  for (const at of hits) {
    work.steps += 1;
    if (at < next) continue;
    const end = at + needle.length;
    if (wordStart && isWordAt(hay, at - 1)) continue;
    if (wordEnd && isWordAt(hay, end)) continue;
    next = end;
    count += 1;
    const span = spanOf(doc, at, end);
    first ??= span;
    if (firstExact === undefined && doc.text.slice(span.start, span.end) === claim)
      firstExact = span;
  }
  if (first === undefined) return empty("not-found", "text");
  const span = firstExact ?? first;
  const stored = doc.text.slice(span.start, span.end);
  return {
    ...empty(firstExact !== undefined ? "verified" : "normalized", "text"),
    span,
    raw: stored,
    excerpt: excerptOf(doc.text, span.start, span.end),
    normalization: firstExact !== undefined ? null : labelText(textLabels(stored, claim)),
    count,
  };
};

// ── numbers ─────────────────────────────────────────────────────────────────

/** One meaning of a number: its canonical value, and the form that the text gives it. */
interface NumReading {
  /** This text is the canonical decimal value, for example `1234.5`. */
  readonly value: string;
  /** This text is the value with its digits as written, for example `+01234.50`. */
  readonly plain: string;
  /** This character separates the thousands, or it is null. */
  readonly group: string | null;
  /** This character is the decimal point or the decimal comma, or it is null. */
  readonly point: string | null;
}

const THOUSANDS: ReadonlySet<string> = new Set([",", ".", "'", " "]);
const DECIMALS: ReadonlySet<string> = new Set([".", ","]);
/** The no-break and thin spaces that separate the thousands in some languages. */
const GROUP_SPACES: ReadonlySet<number> = new Set([0xa0, 0x202f, 0x2009, 0x2007]);

const makeReading = (
  sign: string,
  int: string,
  frac: string,
  group: string | null,
  point: string | null,
): NumReading => {
  const intPart = int.replace(/^0+(?=\d)/, "");
  const fracPart = frac.replace(/0+$/, "");
  const zero = /^0+$/.test(intPart) && fracPart === "";
  return {
    value: `${sign === "-" && !zero ? "-" : ""}${intPart}${fracPart === "" ? "" : `.${fracPart}`}`,
    plain: `${sign}${int}${frac === "" ? "" : `.${frac}`}`,
    group,
    point,
  };
};

/**
 * This function gives each meaning of a number as written. A group of exactly three digits after
 * one separator gives two meanings (`1,234` is 1234 or 1.234), and the function gives the two.
 */
const numberReadings = (written: string): NumReading[] => {
  let sign = "";
  let rest = written;
  if (rest.startsWith("-") || rest.startsWith("+")) {
    sign = rest[0]!;
    rest = rest.slice(1);
  }
  const groups: string[] = [];
  const seps: string[] = [];
  let from = 0;
  for (let at = 0; at < rest.length; at += 1) {
    if (isDigitCode(rest.charCodeAt(at))) continue;
    groups.push(rest.slice(from, at));
    seps.push(rest[at]!);
    from = at + 1;
  }
  groups.push(rest.slice(from));
  if (groups.some((group) => group.length === 0)) return [];
  const found = new Map<string, NumReading>();
  const add = (int: string, frac: string, group: string | null, point: string | null): void => {
    const reading = makeReading(sign, int, frac, group, point);
    if (!found.has(reading.value)) found.set(reading.value, reading);
  };
  if (seps.length === 0) {
    add(groups[0]!, "", null, null);
    return [...found.values()];
  }
  const t = seps[0]!;
  const grouped = (count: number): boolean => {
    const head = groups[0]!;
    if (head.length > 3 || head.startsWith("0")) return false;
    for (let k = 1; k <= count; k += 1) {
      if (groups[k]!.length !== 3 || seps[k - 1] !== t) return false;
    }
    return true;
  };
  if (THOUSANDS.has(t) && grouped(seps.length)) add(groups.join(""), "", t, null);
  const d = seps[seps.length - 1]!;
  if (
    seps.length >= 2 &&
    DECIMALS.has(d) &&
    d !== t &&
    THOUSANDS.has(t) &&
    grouped(seps.length - 1)
  ) {
    add(groups.slice(0, -1).join(""), groups[groups.length - 1]!, t, d);
  }
  if (seps.length === 1 && DECIMALS.has(d)) add(groups[0]!, groups[1]!, null, d);
  return [...found.values()];
};

/** This function writes a JavaScript `number` in decimal digits, with no exponent. */
const decimalOf = (value: number): string | undefined => {
  if (!Number.isFinite(value)) return undefined;
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (match === null) return text;
  const digits = `${match[2]!}${match[3] ?? ""}`;
  const point = match[2]!.length + Number(match[4]);
  const body =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${match[1]!}${body}`;
};

/** This function reads a proposed number. A JavaScript `number` has one meaning: its point is a decimal point. */
const claimNumber = (value: string | number): NumReading[] => {
  if (typeof value === "number") {
    const text = decimalOf(value);
    if (text === undefined) return [];
    const sign = text.startsWith("-") ? "-" : "";
    const [int = "", frac = ""] = text.replace(/^-/, "").split(".");
    return [makeReading(sign, int, frac, null, frac === "" ? null : ".")];
  }
  const text = fold(value, "quote").trim();
  if (!/^[+-]?\d[\d.,' ]*$/.test(text) || !/\d$/.test(text)) return [];
  return numberReadings(text);
};

interface NumToken {
  readonly i: number;
  readonly j: number;
  readonly readings: readonly NumReading[];
}

/**
 * This function finds the numbers of a folded text. A number is digits with separators. A letter
 * before it makes a name (`A320`), so it is not a number. Each unit is read a constant number of times.
 */
const numberTokens = (doc: Doc, work: Work): readonly NumToken[] =>
  cached(doc, "number", () => {
    const f = doc.folded.text;
    const n = f.length;
    const out: NumToken[] = [];
    const isSep = (at: number): boolean => {
      const char = f[at];
      if (char === "," || char === "." || char === "'") return true;
      if (char !== " ") return false;
      const from = doc.folded.start[at]!;
      return (
        doc.folded.end[at]! - from === 1 &&
        GROUP_SPACES.has(doc.text.charCodeAt(from)) &&
        (at + 1 >= n || doc.folded.start[at + 1] === from + 1)
      );
    };
    let i = 0;
    while (i < n) {
      work.steps += 1;
      if (!isDigitAt(f, i)) {
        i += 1;
        continue;
      }
      const start = i;
      let j = i;
      while (j < n && isDigitAt(f, j)) {
        j += 1;
        work.steps += 1;
      }
      while (j + 1 < n && isSep(j) && isDigitAt(f, j + 1)) {
        j += 1;
        while (j < n && isDigitAt(f, j)) {
          j += 1;
          work.steps += 1;
        }
      }
      i = j;
      const before = start > 0 ? f[start - 1]! : "";
      // a name (A320), a fraction with no integer part (.5) or a piece of a longer number
      if (isLetterAt(f, start - 1) || before === "." || (before === "," && isDigitAt(f, start - 2)))
        continue;
      const signed = (before === "-" || before === "+") && !isWordAt(f, start - 2);
      const from = signed ? start - 1 : start;
      const readings = numberReadings(f.slice(from, j));
      if (readings.length > 0) {
        out.push({ i: from, j, readings });
        continue;
      }
      // the separators make no number (1.2.3, 12,34,5): each run of digits is a number
      let a = start;
      while (a < j) {
        let b = a;
        while (b < j && isDigitAt(f, b)) b += 1;
        out.push({ i: a, j: b, readings: [makeReading("", f.slice(a, b), "", null, null)] });
        a = b + 1;
      }
    }
    return out;
  });

const numberLabels = (claim: NumReading, reading: NumReading): string[] => {
  const labels = new Set<string>();
  if (claim.group !== reading.group) labels.add("thousands-separator");
  if (claim.point !== reading.point && (claim.point === "," || reading.point === ","))
    labels.add("decimal-comma");
  // the same value with other digits: zeros at the start or the end, or a plus sign
  if (claim.plain !== reading.plain) labels.add("number-form");
  return [...labels];
};

const NUMBER: Comparator<NumReading, NumReading> = {
  compare: (claim, reading) => {
    if (claim.value !== reading.value) return undefined;
    const labels = numberLabels(claim, reading);
    // the same digits as written: only the characters differ (fullwidth digits, a minus sign)
    return {
      clean: true,
      key: reading.value,
      reading: reading.value,
      labels: labels.length === 0 ? ["unicode"] : labels,
    };
  },
  display: (reading) => reading.value,
};

const numberCands = (doc: Doc, work: Work): Cand<NumReading>[] =>
  numberTokens(doc, work).map((token) => {
    const span = spanOf(doc, token.i, token.j);
    const exact = doc.text.slice(span.start, span.end);
    return {
      where: { span, path: null },
      raw: exact,
      exact,
      excerpt: () => excerptOf(doc.text, span.start, span.end),
      readings: token.readings,
    };
  });

// ── money ───────────────────────────────────────────────────────────────────

/** The codes of ISO 4217 that the check knows, for the common currencies. */
const CODES: readonly string[] = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CNY",
  "CAD",
  "AUD",
  "NZD",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "ISK",
  "PLN",
  "CZK",
  "HUF",
  "RON",
  "BGN",
  "TRY",
  "ILS",
  "INR",
  "PKR",
  "BDT",
  "LKR",
  "KRW",
  "SGD",
  "HKD",
  "TWD",
  "THB",
  "MYR",
  "IDR",
  "PHP",
  "VND",
  "BRL",
  "MXN",
  "ARS",
  "CLP",
  "COP",
  "PEN",
  "UYU",
  "ZAR",
  "NGN",
  "EGP",
  "KES",
  "MAD",
  "AED",
  "SAR",
  "QAR",
  "KWD",
  "BHD",
  "OMR",
  "JOD",
  "RUB",
  "UAH",
  "KZT",
  "GEL",
];

/** The currency symbols, folded, with the currencies of each. A symbol of more than one currency does not say which. */
const SYMBOLS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["us$", ["USD"]],
  ["ca$", ["CAD"]],
  ["c$", ["CAD"]],
  ["au$", ["AUD"]],
  ["a$", ["AUD"]],
  ["nz$", ["NZD"]],
  ["hk$", ["HKD"]],
  ["s$", ["SGD"]],
  ["r$", ["BRL"]],
  ["mx$", ["MXN"]],
  ["nt$", ["TWD"]],
  ["$", ["USD", "CAD", "AUD", "NZD", "MXN", "SGD", "HKD", "TWD", "ARS", "CLP", "COP"]],
  ["€", ["EUR"]],
  ["£", ["GBP"]],
  ["cn¥", ["CNY"]],
  ["jp¥", ["JPY"]],
  ["¥", ["JPY", "CNY"]],
  ["₹", ["INR"]],
  ["₩", ["KRW"]],
  ["₽", ["RUB"]],
  ["₺", ["TRY"]],
  ["₪", ["ILS"]],
  ["₫", ["VND"]],
  ["฿", ["THB"]],
  ["₱", ["PHP"]],
  ["₦", ["NGN"]],
  ["₴", ["UAH"]],
  ["₸", ["KZT"]],
  ["₾", ["GEL"]],
  ["zł", ["PLN"]],
  ["kč", ["CZK"]],
  ["kr", ["SEK", "NOK", "DKK", "ISK"]],
];

interface Marker {
  /** This text is the marker as the folded text writes it. */
  readonly text: string;
  readonly codes: readonly string[];
  /** This label names the currency: its code, or the symbol when the symbol has more than one currency. */
  readonly label: string;
  readonly alpha: boolean;
  /** This value is true for a code of ISO 4217. A page writes a code in capitals, so `15 try` is not an amount. */
  readonly code: boolean;
}

const MARKERS: readonly Marker[] = [
  ...SYMBOLS.map(([text, codes]) => ({
    text,
    codes,
    label: codes.length === 1 ? codes[0]! : text,
    alpha: /^[a-z]/.test(text),
    code: false,
  })),
  ...CODES.map((code) => ({
    text: code.toLowerCase(),
    codes: [code],
    label: code,
    alpha: true,
    code: true,
  })),
].sort((a, b) => b.text.length - a.text.length);

/** This function finds a currency marker that ends at a position (exclusive), or undefined. */
const markerEndingAt = (f: string, end: number): Marker | undefined => {
  for (const marker of MARKERS) {
    const from = end - marker.text.length;
    if (from < 0 || !f.startsWith(marker.text, from)) continue;
    if (marker.alpha && isLetterAt(f, from - 1)) continue;
    return marker;
  }
  return undefined;
};

/** This function finds a currency marker that starts at a position, or undefined. */
const markerStartingAt = (f: string, from: number): Marker | undefined => {
  for (const marker of MARKERS) {
    if (!f.startsWith(marker.text, from)) continue;
    if (marker.alpha && isLetterAt(f, from + marker.text.length)) continue;
    return marker;
  }
  return undefined;
};

interface MoneyReading {
  readonly amount: NumReading;
  readonly marker: Marker | null;
  readonly before: boolean;
}

const moneyText = (reading: MoneyReading): string =>
  reading.marker === null
    ? reading.amount.value
    : `${reading.marker.label} ${reading.amount.value}`;

const MONEY: Comparator<MoneyReading, MoneyReading> = {
  compare: (claim, reading) => {
    if (claim.amount.value !== reading.amount.value || reading.marker === null) return undefined;
    const labels = new Set(numberLabels(claim.amount, reading.amount));
    let clean = true;
    if (claim.marker === null) labels.add("amount-only");
    else {
      if (claim.marker.label !== reading.marker.label) {
        if (!claim.marker.codes.some((code) => reading.marker!.codes.includes(code)))
          return undefined;
        // "$" can be one of several currencies, so it does not say which one the value names
        clean = false;
      }
      if (claim.marker.text !== reading.marker.text) labels.add("currency-symbol");
      if (claim.before !== reading.before) labels.add("currency-position");
    }
    if (labels.size === 0) labels.add("whitespace");
    return { clean, key: moneyText(reading), reading: moneyText(reading), labels: [...labels] };
  },
  display: moneyText,
};

/** This function reads a proposed amount of money: an amount, with a currency symbol or code before or after it. */
const claimMoney = (value: string | number): MoneyReading[] => {
  if (typeof value === "number")
    return claimNumber(value).map((amount) => ({ amount, marker: null, before: false }));
  const text = fold(value, "quote").trim();
  const head = markerStartingAt(text, 0);
  if (head !== undefined) {
    return claimNumber(text.slice(head.text.length).trim()).map((amount) => ({
      amount,
      marker: head,
      before: true,
    }));
  }
  const tail = markerEndingAt(text, text.length);
  if (tail !== undefined) {
    return claimNumber(text.slice(0, text.length - tail.text.length).trim()).map((amount) => ({
      amount,
      marker: tail,
      before: false,
    }));
  }
  return claimNumber(text).map((amount) => ({ amount, marker: null, before: false }));
};

/** This function finds the amounts of money of a text. An amount is a number with a currency marker before or after it, with one space or none. */
const moneyCands = (doc: Doc, work: Work): Cand<MoneyReading>[] =>
  cached(doc, "money", () => {
    const f = doc.folded.text;
    const out: Cand<MoneyReading>[] = [];
    // a code of ISO 4217 counts only in capitals in the original text
    const written = (marker: Marker | undefined, from: number): Marker | undefined => {
      if (marker === undefined || !marker.code) return marker;
      const original = doc.text.slice(
        doc.folded.start[from]!,
        doc.folded.end[from + marker.text.length - 1]!,
      );
      return original === marker.label ? marker : undefined;
    };
    for (const token of numberTokens(doc, work)) {
      work.steps += MARKERS.length;
      const gapBefore = f[token.i - 1] === " " ? 1 : 0;
      const found = markerEndingAt(f, token.i - gapBefore);
      const before = written(
        found,
        token.i - gapBefore - (found === undefined ? 0 : found.text.length),
      );
      let marker = before;
      let i = token.i;
      let j = token.j;
      if (before !== undefined) i = token.i - gapBefore - before.text.length;
      else {
        const gapAfter = f[token.j] === " " ? 1 : 0;
        const after = written(markerStartingAt(f, token.j + gapAfter), token.j + gapAfter);
        if (after === undefined) continue;
        marker = after;
        j = token.j + gapAfter + after.text.length;
      }
      const span = spanOf(doc, i, j);
      const amount = spanOf(doc, token.i, token.j);
      const exact = doc.text.slice(span.start, span.end);
      out.push({
        where: { span, path: null },
        raw: exact,
        exact,
        excerpt: () => excerptOf(doc.text, span.start, span.end),
        readings: token.readings.map((reading) => ({
          amount: reading,
          marker: marker ?? null,
          before: before !== undefined,
        })),
        alt: {
          where: { span: amount, path: null },
          exact: doc.text.slice(amount.start, amount.end),
        },
      });
    }
    return out;
  });

// ── dates ───────────────────────────────────────────────────────────────────

type DateForm = "iso" | "ymd" | "dmy" | "mdy" | "numeric" | "written";

interface DateReading {
  readonly y: number | null;
  readonly m: number;
  readonly d: number | null;
  readonly form: DateForm;
}

const MONTHS: ReadonlyMap<string, number> = new Map([
  ["january", 1],
  ["jan", 1],
  ["february", 2],
  ["feb", 2],
  ["march", 3],
  ["mar", 3],
  ["april", 4],
  ["apr", 4],
  ["may", 5],
  ["june", 6],
  ["jun", 6],
  ["july", 7],
  ["jul", 7],
  ["august", 8],
  ["aug", 8],
  ["september", 9],
  ["sept", 9],
  ["sep", 9],
  ["october", 10],
  ["oct", 10],
  ["november", 11],
  ["nov", 11],
  ["december", 12],
  ["dec", 12],
]);
const WEEKDAYS: ReadonlySet<string> = new Set([
  "monday",
  "mon",
  "tuesday",
  "tue",
  "tues",
  "wednesday",
  "wed",
  "thursday",
  "thu",
  "thur",
  "thurs",
  "friday",
  "fri",
  "saturday",
  "sat",
  "sunday",
  "sun",
]);
const ORDINALS: ReadonlySet<string> = new Set(["st", "nd", "rd", "th"]);

const daysIn = (m: number, y: number | null): number =>
  m === 2
    ? y === null || (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))
      ? 29
      : 28
    : [4, 6, 9, 11].includes(m)
      ? 30
      : 31;

const validDate = (y: number | null, m: number, d: number | null): boolean =>
  m >= 1 &&
  m <= 12 &&
  (y === null || (y >= 1000 && y <= 2999)) &&
  (d === null || (d >= 1 && d <= daysIn(m, y)));

const pad = (value: number, size: number): string => String(value).padStart(size, "0");
const dateText = (reading: DateReading): string =>
  reading.y === null
    ? `--${pad(reading.m, 2)}${reading.d === null ? "" : `-${pad(reading.d, 2)}`}`
    : `${pad(reading.y, 4)}-${pad(reading.m, 2)}${reading.d === null ? "" : `-${pad(reading.d, 2)}`}`;

const NUM = 0;
const ALPHA = 1;
const PUNCT = 2;

/** A token of a folded text: a run of digits, a run of letters or one other character. */
interface Lexeme {
  readonly type: 0 | 1 | 2;
  readonly i: number;
  readonly j: number;
  readonly text: string;
  /** This value is true when a space comes before the token. */
  readonly gap: boolean;
}

const lex = (f: string, work: Work): Lexeme[] => {
  const out: Lexeme[] = [];
  let gap = false;
  let i = 0;
  while (i < f.length) {
    work.steps += 1;
    const char = f[i]!;
    if (char === " ") {
      gap = true;
      i += 1;
      continue;
    }
    let j = i + 1;
    let type: 0 | 1 | 2 = PUNCT;
    if (isDigitAt(f, i)) {
      type = NUM;
      while (isDigitAt(f, j)) j += 1;
    } else if (isLetterAt(f, i)) {
      type = ALPHA;
      while (isLetterAt(f, j)) j += 1;
    }
    work.steps += j - i;
    out.push({ type, i, j, text: f.slice(i, j), gap });
    gap = false;
    i = j;
  }
  return out;
};

const isNum = (token: Lexeme | undefined, min: number, max: number): token is Lexeme =>
  token !== undefined && token.type === NUM && token.text.length >= min && token.text.length <= max;
const isPunct = (token: Lexeme | undefined, chars: string): token is Lexeme =>
  token !== undefined && token.type === PUNCT && !token.gap && chars.includes(token.text);
const glued = (token: Lexeme | undefined): boolean => token !== undefined && !token.gap;

interface DateMatch {
  /** This value is the index of the token after the date. */
  readonly end: number;
  readonly readings: readonly DateReading[];
}

/** This function reads a day after a month or before it: one or two digits, and an ordinal suffix. */
const dayAt = (
  tokens: readonly Lexeme[],
  k: number,
): { readonly d: number; readonly next: number } | undefined => {
  const token = tokens[k];
  if (!isNum(token, 1, 2)) return undefined;
  const after = tokens[k + 1];
  if (after !== undefined && glued(after)) {
    if (after.type === ALPHA) {
      if (!ORDINALS.has(after.text)) return undefined;
      return { d: Number(token.text), next: k + 2 };
    }
    // a time (5:30) or a decimal (4.5) is not a day
    if (
      after.type === PUNCT &&
      (after.text === ":" || after.text === ".") &&
      isNum(tokens[k + 2], 1, 4) &&
      glued(tokens[k + 2])
    )
      return undefined;
    if (after.type === NUM) return undefined;
  }
  return { d: Number(token.text), next: k + 1 };
};

const yearAt = (
  tokens: readonly Lexeme[],
  k: number,
): { readonly y: number; readonly next: number } | undefined => {
  let at = k;
  if (isPunct(tokens[at], ",")) at += 1;
  const token = tokens[at];
  if (!isNum(token, 4, 4)) return undefined;
  if (glued(tokens[at + 1]) && tokens[at + 1]!.type === NUM) return undefined;
  return { y: Number(token.text), next: at + 1 };
};

/** This function reads a date that starts at a token, or gives undefined. It looks at a constant number of tokens. */
const dateAt = (tokens: readonly Lexeme[], t: number): DateMatch | undefined => {
  const a = tokens[t]!;
  const previous = tokens[t - 1];
  const chained =
    previous !== undefined &&
    !a.gap &&
    (previous.type === NUM || (previous.type === PUNCT && "/.-".includes(previous.text)));
  if (a.type === NUM && !chained) {
    const p1 = tokens[t + 1];
    const b = tokens[t + 2];
    const p2 = tokens[t + 3];
    const c = tokens[t + 4];
    const numeric =
      isPunct(p1, "-/.") &&
      isNum(b, 1, 2) &&
      !b.gap &&
      isPunct(p2, p1.text) &&
      glued(c) &&
      c!.type === NUM;
    if (numeric && a.text.length === 4 && isNum(c, 1, 2)) {
      const y = Number(a.text);
      const m = Number(b.text);
      const d = Number(c.text);
      if (!validDate(y, m, d)) return undefined;
      const iso = p1.text === "-" && b.text.length === 2 && c.text.length === 2;
      return { end: t + 5, readings: [{ y, m, d, form: iso ? "iso" : "ymd" }] };
    }
    if (numeric && a.text.length <= 2 && isNum(c, 4, 4)) {
      const first = Number(a.text);
      const second = Number(b.text);
      const y = Number(c.text);
      if (glued(tokens[t + 5]) && tokens[t + 5]!.type === NUM) return undefined;
      const readings: DateReading[] = [];
      if (first === second) {
        if (validDate(y, first, second)) readings.push({ y, m: first, d: second, form: "numeric" });
      } else {
        if (validDate(y, first, second)) readings.push({ y, m: first, d: second, form: "mdy" });
        if (validDate(y, second, first)) readings.push({ y, m: second, d: first, form: "dmy" });
      }
      return readings.length === 0 ? undefined : { end: t + 5, readings };
    }
  }
  if (a.type === ALPHA) {
    const m = MONTHS.get(a.text);
    if (m === undefined) return undefined;
    let k = t + 1;
    if (isPunct(tokens[k], ".")) k += 1;
    const day = tokens[k]?.gap === true || k > t + 1 ? dayAt(tokens, k) : undefined;
    if (day !== undefined) {
      const year = yearAt(tokens, day.next);
      const y = year?.y ?? null;
      if (!validDate(y, m, day.d)) return undefined;
      return { end: year?.next ?? day.next, readings: [{ y, m, d: day.d, form: "written" }] };
    }
    const year = yearAt(tokens, k);
    if (year === undefined || !validDate(year.y, m, null)) return undefined;
    return { end: year.next, readings: [{ y: year.y, m, d: null, form: "written" }] };
  }
  if (a.type === NUM && !chained) {
    const day = dayAt(tokens, t);
    if (day === undefined) return undefined;
    let k = day.next;
    if (tokens[k]?.type === ALPHA && tokens[k]!.text === "of") k += 1;
    const month = tokens[k];
    if (month === undefined || month.type !== ALPHA || !month.gap) return undefined;
    const m = MONTHS.get(month.text);
    if (m === undefined) return undefined;
    k += 1;
    if (isPunct(tokens[k], ".")) k += 1;
    const year = yearAt(tokens, k);
    const y = year?.y ?? null;
    if (!validDate(y, m, day.d)) return undefined;
    return { end: year?.next ?? k, readings: [{ y, m, d: day.d, form: "written" }] };
  }
  return undefined;
};

interface DateToken {
  readonly i: number;
  readonly j: number;
  readonly readings: readonly DateReading[];
}

const scanDates = (f: string, work: Work): DateToken[] => {
  const tokens = lex(f, work);
  const out: DateToken[] = [];
  let t = 0;
  while (t < tokens.length) {
    work.steps += 1;
    const found = dateAt(tokens, t);
    if (found === undefined) {
      t += 1;
      continue;
    }
    out.push({ i: tokens[t]!.i, j: tokens[found.end - 1]!.j, readings: found.readings });
    t = found.end;
  }
  return out;
};

const dateCands = (doc: Doc, work: Work): Cand<DateReading>[] =>
  cached(doc, "date", () =>
    scanDates(doc.folded.text, work).map((token) => {
      const span = spanOf(doc, token.i, token.j);
      const exact = doc.text.slice(span.start, span.end);
      return {
        where: { span, path: null },
        raw: exact,
        exact,
        excerpt: () => excerptOf(doc.text, span.start, span.end),
        readings: token.readings,
      };
    }),
  );

/** This function reads a proposed date: ISO 8601, written English months, or numbers. It gives no reading for a text that is not one date. */
const claimDate = (
  value: string | number,
): { readonly readings: DateReading[]; readonly time: boolean } => {
  if (typeof value === "number") return { readings: [], time: false };
  const text = fold(value, "quote").trim();
  const iso =
    /^(\d{4})-(\d{2})(?:-(\d{2}))?(t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?$/.exec(
      text,
    );
  if (iso !== null) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = iso[3] === undefined ? null : Number(iso[3]);
    if (iso[4] !== undefined && d === null) return { readings: [], time: false };
    return validDate(y, m, d)
      ? { readings: [{ y, m, d, form: "iso" }], time: iso[4] !== undefined }
      : { readings: [], time: false };
  }
  const work: Work = { steps: 0 };
  const tokens = lex(text, work);
  let t = 0;
  if (tokens[0]?.type === ALPHA && WEEKDAYS.has(tokens[0].text)) {
    t = 1;
    if (tokens[1]?.type === PUNCT && tokens[1].text === ",") t = 2;
  }
  const found = t < tokens.length ? dateAt(tokens, t) : undefined;
  const rest = found === undefined ? [] : tokens.slice(found.end);
  if (found === undefined || rest.some((token) => token.text !== "."))
    return { readings: [], time: false };
  return { readings: [...found.readings], time: false };
};

const DATE: Comparator<DateReading, DateReading> = {
  compare: (claim, reading) => {
    if (claim.m !== reading.m) return undefined;
    if (claim.y !== null && reading.y !== null && claim.y !== reading.y) return undefined;
    if (claim.d !== null && reading.d !== null && claim.d !== reading.d) return undefined;
    // the stored text says less than the value: the check does not add the year or the day
    const missing =
      (claim.y !== null && reading.y === null) || (claim.d !== null && reading.d === null);
    const partial =
      missing ||
      (claim.y === null && reading.y !== null) ||
      (claim.d === null && reading.d !== null);
    const labels = [claim.form === reading.form ? "date-form" : `date-${reading.form}`];
    if (partial) labels.push("date-partial");
    return { clean: !missing, key: dateText(reading), reading: dateText(reading), labels };
  },
  display: dateText,
};

// ── phone numbers ───────────────────────────────────────────────────────────

interface PhoneReading {
  /** These digits are the number with no international prefix and no national trunk prefix. */
  readonly digits: string;
  /** This value is true when the number starts with `+` or `00`. */
  readonly intl: boolean;
}

const phoneReading = (written: string): PhoneReading | undefined => {
  // "+44 (0)20" writes the trunk prefix of the national form in brackets
  const text = written.replace(/\(0\)/g, "");
  let digits = text.replace(/\D/g, "");
  let intl = text.trimStart().startsWith("+");
  if (!intl && digits.startsWith("00")) {
    intl = true;
    digits = digits.slice(2);
  } else if (!intl && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length < 7 || digits.length > 15) return undefined;
  return { digits, intl };
};

const phoneText = (reading: PhoneReading): string => `${reading.intl ? "+" : ""}${reading.digits}`;

/** The longest country code has three digits. */
const COUNTRY_DIGITS = 3;

const PHONE: Comparator<PhoneReading, PhoneReading> = {
  compare: (claim, reading) => {
    const key = reading.digits;
    if (claim.digits === reading.digits)
      return { clean: true, key, reading: phoneText(reading), labels: ["phone-digits"] };
    if (reading.digits.endsWith(claim.digits))
      return { clean: true, key, reading: phoneText(reading), labels: ["phone-suffix"] };
    if (claim.digits.endsWith(reading.digits)) {
      // the stored number has no country code, and the value has one: the rest is the national number
      const country = claim.digits.length - reading.digits.length;
      const clean = claim.intl && !reading.intl && country <= COUNTRY_DIGITS;
      return { clean, key, reading: phoneText(reading), labels: ["phone-suffix"] };
    }
    return undefined;
  },
  display: phoneText,
  same: (a, b) => a.key.endsWith(b.key) || b.key.endsWith(a.key),
};

const PHONE_CHARS = "-.()/";

/** This function finds the phone numbers of a folded text: 7 to 15 digits with spaces, dashes, points, brackets and slashes. */
const phoneCands = (doc: Doc, work: Work): Cand<PhoneReading>[] =>
  cached(doc, "phone", () => {
    const f = doc.folded.text;
    const n = f.length;
    const out: Cand<PhoneReading>[] = [];
    let i = 0;
    while (i < n) {
      work.steps += 1;
      const char = f[i]!;
      const starts =
        (isDigitAt(f, i) ||
          ((char === "+" || char === "(") && (isDigitAt(f, i + 1) || f[i + 1] === "("))) &&
        !isWordAt(f, i - 1) &&
        f[i - 1] !== "+";
      if (!starts) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < n) {
        work.steps += 1;
        const unit = f[j]!;
        if (isDigitAt(f, j) || PHONE_CHARS.includes(unit) || (unit === "+" && j === i)) {
          j += 1;
          continue;
        }
        if (unit === " " && (isDigitAt(f, j + 1) || f[j + 1] === "(")) {
          j += 1;
          continue;
        }
        break;
      }
      let e = j;
      while (e > i && !isDigitAt(f, e - 1)) e -= 1;
      const next = Math.max(j, i + 1);
      if (e > i && !isWordAt(f, e)) {
        const span = spanOf(doc, i, e);
        const exact = doc.text.slice(span.start, span.end);
        const reading = phoneReading(f.slice(i, e));
        if (reading !== undefined) {
          out.push({
            where: { span, path: null },
            raw: exact,
            exact,
            excerpt: () => excerptOf(doc.text, span.start, span.end),
            readings: [reading],
          });
        }
      }
      i = next;
    }
    return out;
  });

const claimPhone = (value: string | number): PhoneReading[] => {
  const text = (typeof value === "number" ? String(value) : fold(value, "quote").trim()).replace(
    /^tel:/,
    "",
  );
  if (!/^\+?[\d\s\-.()/]+$/.test(text)) return [];
  const reading = phoneReading(text);
  return reading === undefined ? [] : [reading];
};

// ── URLs ────────────────────────────────────────────────────────────────────

interface UrlReading {
  /** This URL is the canonical form (`canonicalUrl`). */
  readonly url: string;
  /** This value is true when the stored text has no scheme (`www.example.com`). */
  readonly schemeless: boolean;
  /** This value is true when the value was relative and the check resolved it against the page URL. */
  readonly relative: boolean;
  readonly written: string;
}

const withoutScheme = (url: string): string => url.replace(/^[a-z][a-z0-9+.-]*:/i, "");

const URL_STOP = /[\s<>"`{}|\\^]/u;
const URL_TRAIL = /[.,;:!?'"]/;

/** This function finds the URLs of a text: `http://`, `https://` and `www.` forms. It reads the original text, because a path keeps its case. */
const urlCands = (doc: Doc, work: Work): Cand<UrlReading>[] =>
  cached(doc, "url", () => {
    const text = doc.text;
    const n = text.length;
    const out: Cand<UrlReading>[] = [];
    let i = 0;
    while (i < n) {
      work.steps += 1;
      const code = text.charCodeAt(i) | 0x20;
      let prefix = 0;
      if (code === 0x68 && !isWordAt(text, i - 1)) {
        const head = text.slice(i, i + 8).toLowerCase();
        prefix = head.startsWith("https://") ? 8 : head.startsWith("http://") ? 7 : 0;
      } else if (
        code === 0x77 &&
        !isWordAt(text, i - 1) &&
        text[i - 1] !== "/" &&
        text[i - 1] !== "."
      ) {
        prefix = text.slice(i, i + 4).toLowerCase() === "www." ? 4 : 0;
      }
      if (prefix === 0) {
        i += 1;
        continue;
      }
      const start = i;
      let j = start + prefix;
      while (j < n && !URL_STOP.test(text[j]!)) {
        j += 1;
        work.steps += 1;
      }
      i = j;
      let e = j;
      // a final point or bracket belongs to the sentence, not to the URL; the counts make it linear
      const balance = { ")": 0, "]": 0 };
      for (let at = start; at < j; at += 1) {
        const char = text[at];
        if (char === "(") balance[")"] += 1;
        else if (char === ")") balance[")"] -= 1;
        else if (char === "[") balance["]"] += 1;
        else if (char === "]") balance["]"] -= 1;
      }
      work.steps += j - start;
      while (e > start + prefix) {
        work.steps += 1;
        const last = text[e - 1]!;
        if (URL_TRAIL.test(last)) {
          e -= 1;
          continue;
        }
        if ((last === ")" || last === "]") && balance[last] < 0) {
          balance[last] += 1;
          e -= 1;
          continue;
        }
        break;
      }
      if (e <= start + prefix) continue;
      const written = text.slice(start, e);
      const schemeless = prefix === 4;
      let url: string;
      try {
        url = canonicalUrl(schemeless ? `https://${written}` : written);
      } catch {
        continue;
      }
      const span: FieldSpan = { start, end: e, in: doc.name };
      out.push({
        where: { span, path: null },
        raw: written,
        exact: written,
        excerpt: () => excerptOf(text, start, e),
        readings: [{ url, schemeless, relative: false, written }],
      });
    }
    return out;
  });

/** This function gives the stored links of a page as places of a URL. The store keeps the canonical form of each link. */
const linkCands = (meta: Readonly<Record<string, unknown>>, work: Work): Cand<UrlReading>[] => {
  const links = meta["links"];
  if (!Array.isArray(links)) return [];
  const out: Cand<UrlReading>[] = [];
  for (const [index, link] of links.entries()) {
    work.steps += 1;
    if (link === null || typeof link !== "object") continue;
    const href = (link as { href?: unknown }).href;
    const label = (link as { text?: unknown }).text;
    if (typeof href !== "string") continue;
    out.push({
      where: { span: null, path: `links[${String(index)}]` },
      raw: href,
      exact: href,
      excerpt: () => (typeof label === "string" && label.length > 0 ? `${label} (${href})` : href),
      readings: [{ url: href, schemeless: false, relative: false, written: href }],
    });
  }
  return out;
};

/** This function reads a proposed URL, and resolves a relative URL against the URL of the page. Only `http` and `https` URLs are URLs of this kind. */
const claimUrl = (value: string | number, base: string | null): UrlReading[] => {
  if (typeof value === "number") return [];
  const text = value.trim().replace(/^<(.*)>$/s, "$1");
  if (text.length === 0 || /\s/.test(text)) return [];
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  const written = !hasScheme && /^www\./i.test(text) ? `//${text}` : text;
  let resolved: URL;
  try {
    resolved = hasScheme ? new URL(written) : new URL(written, base ?? undefined);
  } catch {
    return [];
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return [];
  return [
    { url: canonicalUrl(resolved.href), schemeless: false, relative: !hasScheme, written: text },
  ];
};

/** A text with an `http` or `https` scheme, a `www.` host, or a path from the root. */
const LOOKS_LIKE_URL = /^(?:https?:\/\/|www\.|\/|\.\.?\/)/i;

const URL_KIND: Comparator<UrlReading, UrlReading> = {
  compare: (claim, reading) => {
    const labels: string[] = [];
    if (claim.relative || reading.relative) labels.push("url-resolved");
    if (reading.schemeless) {
      if (withoutScheme(claim.url) !== withoutScheme(reading.url)) return undefined;
      labels.push("url-scheme");
      return { clean: true, key: claim.url, reading: claim.url, labels };
    }
    if (claim.url !== reading.url) return undefined;
    if (labels.length === 0) labels.push("url-form");
    return { clean: true, key: reading.url, reading: reading.url, labels };
  },
  display: (reading) => reading.url,
};

// ── email addresses ─────────────────────────────────────────────────────────

const LOCAL = /^[A-Za-z0-9._%+-]$/;
const DOMAIN = /^[A-Za-z0-9.-]$/;
const DOMAIN_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/** This function finds the email addresses of a text. Each unit is read two times at most. */
const emailCands = (doc: Doc, work: Work): Cand<string>[] =>
  cached(doc, "email", () => {
    const text = doc.text;
    const n = text.length;
    const out: Cand<string>[] = [];
    let i = 0;
    while (i < n) {
      work.steps += 1;
      if (text[i] !== "@") {
        i += 1;
        continue;
      }
      let s = i;
      while (s > 0 && LOCAL.test(text[s - 1]!)) {
        s -= 1;
        work.steps += 1;
      }
      while (s < i && text[s] === ".") s += 1;
      let e = i + 1;
      while (e < n && DOMAIN.test(text[e]!)) {
        e += 1;
        work.steps += 1;
      }
      const next = e;
      while (e > i + 1 && (text[e - 1] === "." || text[e - 1] === "-")) e -= 1;
      if (s < i && DOMAIN_NAME.test(text.slice(i + 1, e))) {
        const written = text.slice(s, e);
        const start = s;
        const end = e;
        out.push({
          where: { span: { start, end, in: doc.name }, path: null },
          raw: written,
          exact: written,
          excerpt: () => excerptOf(text, start, end),
          readings: [written.toLowerCase()],
        });
      }
      i = Math.max(next, i + 1);
    }
    return out;
  });

const claimEmail = (value: string | number): string[] => {
  if (typeof value === "number") return [];
  const text = value.trim().replace(/^mailto:/i, "");
  const at = text.lastIndexOf("@");
  if (at <= 0 || !/^[A-Za-z0-9._%+-]+$/.test(text.slice(0, at))) return [];
  return DOMAIN_NAME.test(text.slice(at + 1)) ? [text.toLowerCase()] : [];
};

const EMAIL: Comparator<string, string> = {
  compare: (claim, reading) =>
    claim === reading ? { clean: true, key: reading, reading, labels: ["email-case"] } : undefined,
  display: (reading) => reading,
};

// ── JSON-LD ─────────────────────────────────────────────────────────────────

/** A value of the JSON-LD at a path, with that path. */
interface Leaf {
  readonly path: string;
  readonly value: string | number | boolean;
}

/** A key of the JSON-LD goes into a path only when it is a name. Thus a path holds no other text of the page. */
const PATH_KEY = /^@?[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

interface Visit {
  readonly value: unknown;
  readonly path: string;
  readonly depth: number;
}

/**
 * This function gives the values of the JSON-LD at a path. The first part of the path names a
 * schema.org type (`*` is each top-level record), and the path starts at each object of that type,
 * at any depth. Each array on the path gives each of its values.
 */
const leavesAt = (records: readonly unknown[], path: string, work: Work): Leaf[] => {
  const [head = "", ...rest] = path.split(".");
  const type = head.toLowerCase();
  const starts: Array<{ readonly value: unknown; readonly path: string }> = [];
  // an explicit stack: JSON-LD nested deeply cannot overflow the call stack
  const stack: Visit[] = [];
  for (let index = records.length - 1; index >= 0; index -= 1)
    stack.push({ value: records[index], path: `jsonld[${String(index)}]`, depth: 0 });
  while (stack.length > 0) {
    work.steps += 1;
    const { value, path: at, depth } = stack.pop()!;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1)
        stack.push({ value: value[index], path: `${at}[${String(index)}]`, depth: depth + 1 });
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (type === "*") {
      if (depth === 0) starts.push({ value: record, path: at });
      continue;
    }
    if (typesOf(record).some((name) => name.toLowerCase() === type))
      starts.push({ value: record, path: at });
    const keys = Object.keys(record);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      if (PATH_KEY.test(key))
        stack.push({ value: record[key], path: `${at}.${key}`, depth: depth + 1 });
    }
  }
  const out: Leaf[] = [];
  for (const start of starts) {
    const walk: Visit[] = [{ value: start.value, path: start.path, depth: 0 }];
    while (walk.length > 0) {
      work.steps += 1;
      const { value, path: at, depth } = walk.pop()!;
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1)
          walk.push({ value: value[index], path: `${at}[${String(index)}]`, depth });
        continue;
      }
      if (depth === rest.length) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
          out.push({ path: at, value });
        else if (value !== null && typeof value === "object") {
          const inner = (value as Record<string, unknown>)["@value"];
          if (typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean")
            out.push({ path: `${at}.@value`, value: inner });
        }
        continue;
      }
      if (value === null || typeof value !== "object") continue;
      const key = rest[depth]!;
      const next = (value as Record<string, unknown>)[key];
      if (next !== undefined) walk.push({ value: next, path: `${at}.${key}`, depth: depth + 1 });
    }
  }
  return out;
};

const leafText = (value: string | number | boolean): string =>
  typeof value === "number" ? (decimalOf(value) ?? String(value)) : String(value);

/** This function checks a value against the JSON-LD at a path. It compares as a number, a date, a URL and a text, in that sequence. */
const checkJsonLd = (
  kind: string,
  path: string,
  value: string | number,
  claimText: string,
  source: ExtractSource,
  work: Work,
): FieldCheck => {
  const meta = source.meta ?? {};
  const records = Array.isArray(meta["jsonld"]) ? (meta["jsonld"] as unknown[]) : [];
  const leaves = leavesAt(records, path, work);
  const dropped = meta["jsonld_dropped"];
  const missing =
    typeof dropped === "number" && dropped > 0
      ? `the store keeps only a part of the JSON-LD of this page (${String(dropped)} records left out), so the path can be in the part that it left out`
      : null;
  if (leaves.length === 0) return empty("not-found", kind, missing);
  const base = source.url ?? null;
  const cand = <R>(leaf: Leaf, readings: readonly R[]): Cand<R> => ({
    where: { span: null, path: leaf.path },
    raw: leaf.value,
    exact: leafText(leaf.value),
    excerpt: () => JSON.stringify(leaf.value).slice(0, 200),
    readings,
  });
  const stringOf = (leaf: Leaf): string | undefined =>
    typeof leaf.value === "string" ? leaf.value : undefined;
  const folded = fold(claimText, "quote");
  const TEXT: Comparator<string, string> = {
    compare: (claim, reading) =>
      fold(reading, "quote") === folded
        ? { clean: true, key: folded, reading: folded, labels: textLabels(reading, claim) }
        : undefined,
    display: (reading) => reading,
  };
  const attempts: Array<() => FieldCheck | undefined> = [
    () => {
      const claims = claimNumber(value);
      if (claims.length === 0) return undefined;
      const cands = leaves.map((leaf) =>
        cand(leaf, typeof leaf.value === "boolean" ? [] : claimNumber(leaf.value)),
      );
      return decide(kind, claimText, claims, cands, NUMBER, work);
    },
    () => {
      const claim = claimDate(value);
      if (claim.readings.length === 0) return undefined;
      const cands = leaves.map((leaf) => {
        const text = stringOf(leaf);
        return cand(leaf, text === undefined ? [] : claimDate(text).readings);
      });
      return decide(kind, claimText, claim.readings, cands, DATE, work);
    },
    () => {
      // only a text that looks like a URL is a URL here: each word is a relative URL
      const claims = LOOKS_LIKE_URL.test(claimText) ? claimUrl(value, base) : [];
      if (claims.length === 0) return undefined;
      const cands = leaves.map((leaf) => {
        const text = stringOf(leaf);
        return cand(
          leaf,
          text === undefined || !LOOKS_LIKE_URL.test(text.trim()) ? [] : claimUrl(text, base),
        );
      });
      return decide(kind, claimText, claims, cands, URL_KIND, work);
    },
    () => {
      if (folded.length === 0) return undefined;
      const cands = leaves.map((leaf) => cand(leaf, [leafText(leaf.value)]));
      return decide(kind, claimText, [claimText], cands, TEXT, work);
    },
  ];
  for (const attempt of attempts) {
    const result = attempt();
    if (result !== undefined && result.status !== "not-found") return result;
  }
  return empty("not-found", kind, missing);
};

// ── the check of the fields ─────────────────────────────────────────────────

interface Context {
  readonly source: ExtractSource;
  readonly text: Doc;
  full: Doc | undefined | null;
  readonly work: Work;
}

/** This function gives the whole text of a page that the reader cut, or null. It folds that text at its first use only. */
const fullOf = (context: Context): Doc | null => {
  if (context.full === undefined) {
    const full = context.source.full_text;
    context.full =
      full === undefined || full === context.source.text
        ? null
        : prepare("full_text", full, context.work);
  }
  return context.full;
};

/** This function checks a field in the text. When the reader cut the text and the text does not hold the value, it checks the whole text too. */
const inText = (context: Context, check: (doc: Doc) => FieldCheck): FieldCheck => {
  const first = check(context.text);
  if (first.status !== "not-found") return first;
  const full = fullOf(context);
  if (full === null) return first;
  const second = check(full);
  return second.status === "not-found" ? first : second;
};

/** This function reads the kind of a field. A kind that is not a kind throws a `RangeError`. */
const kindOf = (name: string, claim: FieldClaim): string => {
  const kind: string = claim.kind ?? (typeof claim.value === "number" ? "number" : "text");
  if (FIELD_KINDS.includes(kind)) return kind;
  if (kind.startsWith("json-ld:") && kind.length > "json-ld:".length && !/\s/.test(kind))
    return kind;
  throw new RangeError(
    `the kind of the field ${name} is ${FIELD_KINDS.join(", ")} or json-ld:<path>, not ${JSON.stringify(kind)}`,
  );
};

const INVALID: Readonly<Record<string, string>> = {
  number: "the value is not a number",
  money: "the value is not an amount of money",
  date: "the value is not a date",
  url: "the value is not an http or https URL",
  email: "the value is not an email address",
  phone: "the value is not a phone number of 7 to 15 digits",
};

const checkOne = (name: string, claim: FieldClaim, context: Context): FieldCheck => {
  const kind = kindOf(name, claim);
  const value = claim.value;
  if (typeof value === "number" && !Number.isFinite(value))
    return empty("invalid", kind, "the value is not a finite number");
  // a mailto: or tel: link names the address or the number, so the exact text is without it
  const prefix = kind === "email" ? /^mailto:/i : kind === "phone" ? /^tel:/i : undefined;
  const trimmed = typeof value === "number" ? (decimalOf(value) ?? "") : value.trim();
  const claimText = prefix === undefined ? trimmed : trimmed.replace(prefix, "");
  if (claimText.length === 0) return empty("invalid", kind, "the value is empty");
  const work = context.work;
  const invalid = (): FieldCheck =>
    empty("invalid", kind, INVALID[kind] ?? "the value is not valid");
  switch (kind) {
    case "text":
      return inText(context, (doc) => checkText(doc, claimText, work));
    case "number": {
      const claims = claimNumber(value);
      if (claims.length === 0) return invalid();
      return inText(context, (doc) =>
        decide(kind, claimText, claims, numberCands(doc, work), NUMBER, work),
      );
    }
    case "money": {
      const claims = claimMoney(value);
      if (claims.length === 0) return invalid();
      return inText(context, (doc) =>
        decide(kind, claimText, claims, moneyCands(doc, work), MONEY, work),
      );
    }
    case "date": {
      const claim = claimDate(value);
      if (claim.readings.length === 0) return invalid();
      const result = inText(context, (doc) =>
        decide(kind, claimText, claim.readings, dateCands(doc, work), DATE, work),
      );
      if (!claim.time || result.status === "verified") return result;
      const timeNote = "the check compares the date of the value, not its time";
      return { ...result, note: result.note === null ? timeNote : `${result.note}; ${timeNote}` };
    }
    case "url": {
      const claims = claimUrl(value, context.source.url ?? null);
      if (claims.length === 0) return invalid();
      const links = linkCands(context.source.meta ?? {}, work);
      return inText(context, (doc) =>
        decide(kind, claimText, claims, [...urlCands(doc, work), ...links], URL_KIND, work),
      );
    }
    case "email": {
      const claims = claimEmail(value);
      if (claims.length === 0) return invalid();
      return inText(context, (doc) =>
        decide(kind, claimText, claims, emailCands(doc, work), EMAIL, work),
      );
    }
    case "phone": {
      const claims = claimPhone(value);
      if (claims.length === 0) return invalid();
      return inText(context, (doc) =>
        decide(kind, claimText, claims, phoneCands(doc, work), PHONE, work),
      );
    }
    default:
      return checkJsonLd(
        kind,
        kind.slice("json-ld:".length),
        value,
        claimText,
        context.source,
        work,
      );
  }
};

/** This function validates the fields, and gives their names and values. A field that is not valid throws a `RangeError`. */
const claimsOf = (
  fields: Readonly<Record<string, FieldClaim>>,
): Array<readonly [string, FieldClaim]> => {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields))
    throw new RangeError("fields must be an object of names and values");
  const entries = Object.entries(fields);
  for (const [name, claim] of entries) {
    if (name.length === 0) throw new RangeError("the name of a field must not be empty");
    if (claim === null || typeof claim !== "object")
      throw new RangeError(`the field ${name} must be an object with a value`);
    if (typeof claim.value !== "string" && typeof claim.value !== "number")
      throw new RangeError(`the value of the field ${name} must be a text or a number`);
    kindOf(name, claim);
  }
  return entries;
};

const summaryOf = (statuses: readonly FieldStatus[]): ExtractSummary => {
  const count = (status: FieldStatus): number => statuses.filter((one) => one === status).length;
  return {
    fields: statuses.length,
    verified: count("verified"),
    normalized: count("normalized"),
    ambiguous: count("ambiguous"),
    not_found: count("not-found"),
    held_back: count("held-back"),
    invalid: count("invalid"),
  };
};

/**
 * This function checks the proposed values of fields against the text and the metadata of a
 * document. It sends no request and writes nothing. It does not make values. A field that is not
 * valid throws a `RangeError`. The work grows in proportion to the length of the text.
 *
 * @beta
 */
export const checkFields = (
  source: ExtractSource,
  fields: Readonly<Record<string, FieldClaim>>,
): FieldsChecked => {
  const claims = claimsOf(fields);
  const work: Work = { steps: 0 };
  const context: Context = {
    source,
    text: prepare("text", source.text, work),
    full: undefined,
    work,
  };
  const checked: Record<string, FieldCheck> = {};
  for (const [name, claim] of claims) checked[name] = checkOne(name, claim, context);
  return {
    fields: checked,
    summary: summaryOf(Object.values(checked).map((field) => field.status)),
    steps: work.steps,
  };
};

// ── the check of a stored document ──────────────────────────────────────────

const withCapture = (
  fields: Readonly<Record<string, FieldCheck>>,
  capture: string | null,
  fetchedAt: string | null,
): Record<string, FieldResult> =>
  Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      { ...field, capture, fetched_at: fetchedAt },
    ]),
  );

/** This function gives the same result for each field, with no check: for a held-back document, or a time before the first capture. */
const sameForEach = (
  claims: ReadonlyArray<readonly [string, FieldClaim]>,
  status: FieldStatus,
  note: string,
): Record<string, FieldResult> =>
  Object.fromEntries(
    claims.map(([name, claim]) => [
      name,
      { ...empty(status, kindOf(name, claim), note), capture: null, fetched_at: null },
    ]),
  );

/**
 * This function checks the proposed values of fields against a stored document. It does not make
 * values. It applies the rules of `verify`:
 *
 * - With no option, it checks the current version. `capture` checks the version of one capture,
 *   and `at` checks the version that was current at a time.
 * - A held-back document gives `held-back` for each field, with no position and no capture, unless
 *   `userProvided`. The crawler then logs an override.
 * - A field that is not valid throws a `RangeError`, and an unknown document throws an error.
 *
 * @beta
 */
export const extractDocument = async (
  runtime: CrawlRuntime,
  id: string,
  fields: Readonly<Record<string, FieldClaim>>,
  options: ExtractOptions = {},
): Promise<ExtractResult> => {
  const claims = claimsOf(fields);
  if (options.at !== undefined && options.capture !== undefined)
    throw new RangeError("give capture or at, not the two: each one chooses a version");
  const at = options.at === undefined ? undefined : isoTime("at", options.at);
  const doc = runtime.index.get(id);
  if (doc === undefined)
    throw new Error(`no stored document ${id}: find one with find(), or fetch its page`);
  let version: VersionText | undefined;
  let first: string | undefined;
  if (options.capture !== undefined) {
    version = runtime.index.versionText(id, options.capture);
    if (version === undefined)
      throw new Error(`the document ${id} has no version from the capture ${options.capture}`);
  } else if (at !== undefined) ({ version, first } = versionAtTime(runtime, id, at));
  else version = runtime.index.versionText(id);
  const aiInput: AiInput =
    doc.ai_input === "no" || version?.ai_input === "no"
      ? "no"
      : (version?.ai_input ?? doc.ai_input);
  const userProvided = options.userProvided ?? false;
  const base = {
    doc: doc.doc,
    url: doc.url,
    captures: doc.captures,
    ...(at === undefined ? {} : { at }),
  };
  if (isHeldBack({ ai_input: aiInput }, userProvided)) {
    // no check runs: the result is the same for each value, so it tells nothing about the text
    return {
      ...base,
      capture: null,
      blob: null,
      fetched_at: null,
      held_back: true,
      fields: sameForEach(claims, "held-back", HELD_BACK),
      summary: summaryOf(claims.map(() => "held-back")),
      note: HELD_BACK,
    };
  }
  if (aiInput === "no" && userProvided) await recordOverride(runtime, doc, "extract");
  if (version === undefined) {
    const note = `the document ${id} has no version at ${at ?? "this time"} or before${first === undefined ? "" : `: its first capture is from ${first}`}`;
    return {
      ...base,
      capture: null,
      blob: null,
      fetched_at: null,
      held_back: false,
      fields: sameForEach(claims, "not-found", note),
      summary: summaryOf(claims.map(() => "not-found")),
      note,
      before_first: true,
    };
  }
  const checked = checkFields(
    {
      text: version.text,
      full_text: version.full_text,
      url: version.url ?? doc.url,
      meta: version.meta,
    },
    Object.fromEntries(claims),
  );
  const incomplete = version.meta["truncated"] === true && version.full_text === undefined;
  // an archived copy says so, as in read and verify, so a citation cannot present it as the current page
  const archived = archivedOf(version.meta);
  const notes = [
    ...(incomplete && checked.summary.not_found > 0
      ? [
          "the reader stopped before the end of the file, so a value that is not found can be in the part that it did not read",
        ]
      : []),
    ...(archived === undefined ? [] : [archivedNote(archived)]),
  ];
  return {
    ...base,
    capture: version.capture,
    blob: version.blob,
    fetched_at: version.fetched_at,
    held_back: false,
    fields: withCapture(checked.fields, version.capture, version.fetched_at),
    summary: checked.summary,
    note: notes.length > 0 ? notes.join("; ") : null,
    ...(archived === undefined ? {} : { archived }),
  };
};
