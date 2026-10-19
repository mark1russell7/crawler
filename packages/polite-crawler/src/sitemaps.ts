import { canonicalUrl } from "./urls.ts";

/**
 * The sitemap reader reads the files that list the pages of a site. These are an XML sitemap, a
 * sitemap index, an RSS 2.0 or RSS 1.0 feed and an Atom feed. A text sitemap with one URL on each
 * line is a file of this kind too. The reader is small and strict, because the files come from the web:
 *
 * - It reads the text one time from the start to the end, and it builds no tree. Its time is
 *   linear in the length of the text.
 * - It expands no entity. It knows only the five entities of XML and the character references. A
 *   DTD in the file changes nothing.
 * - It stops at a maximum depth of elements, at a maximum number of entries and at the first
 *   error in the markup. The entries before the stop stay.
 *
 * It imports no Node.js module, so a browser can use it.
 */

/** The kind of a file: the name of its root element, or `text` for a text sitemap. */
export type SitemapKind = "urlset" | "sitemapindex" | "rss" | "atom" | "rdf" | "text" | "unknown";

/** The values of `<changefreq>` in the sitemap protocol. */
export type Changefreq = "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";

/**
 * One entry of a file: a page, or a sitemap of an index.
 *
 * @beta
 */
export interface SitemapEntry {
  /** This URL is the canonical form of the URL of the entry. */
  readonly url: string;
  /** This time (ISO 8601) is the last change that the file gives, or null. */
  readonly lastmod: string | null;
  /** This value is the `<changefreq>` of a sitemap entry, or null. */
  readonly changefreq: Changefreq | null;
}

/**
 * The result of one file.
 *
 * @beta
 */
export interface SitemapRead {
  readonly kind: SitemapKind;
  /** These entries are the pages of the file, or the sitemaps of an index, in the order of the file. */
  readonly entries: readonly SitemapEntry[];
  /** This value counts the entries with no valid http(s) URL. */
  readonly invalid: number;
  /** This value is false when the reader stopped before the end of the file. */
  readonly complete: boolean;
  /** These notes tell why the reader stopped, or what it ignored. */
  readonly notes: readonly string[];
}

/**
 * These limits stop the reader on a large or a hostile file.
 *
 * @beta
 */
export interface SitemapLimits {
  /** This value is the maximum number of entries. The default is 50,000, the limit of the sitemap protocol. */
  readonly maxEntries?: number | undefined;
  /** This value is the maximum depth of the elements. The default is 32. */
  readonly maxDepth?: number | undefined;
}

/**
 * These are the default limits of the reader, and the maximum length of one value.
 *
 * @beta
 */
export const SITEMAP_LIMITS = {
  maxEntries: 50_000,
  maxDepth: 32,
  /** A value (a URL or a date) longer than this number of characters is not valid. */
  maxValue: 4096,
} as const;

/** The reader counts its steps here. A test uses the count to show that the time is linear. */
export interface Meter {
  steps: number;
}

const CHANGEFREQ: ReadonlySet<string> = new Set([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
]);
const SITEMAP_NS = [
  "http://www.sitemaps.org/schemas/sitemap/0.9",
  "http://www.google.com/schemas/sitemap/0.84",
  "http://www.google.com/schemas/sitemap/0.9",
];
const ATOM_NS = ["http://www.w3.org/2005/Atom"];
const RSS1_NS = ["http://purl.org/rss/1.0/"];
const DC_NS = ["http://purl.org/dc/elements/1.1/"];
const RDF_NS = ["http://www.w3.org/1999/02/22-rdf-syntax-ns#"];
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
/** A tag keeps this number of attributes at most. The reader reads the others and keeps nothing of them. */
const MAX_ATTRIBUTES = 64;
const NAME = /^[A-Za-z_][\w.:-]*$/;
const W3C_DATE =
  /^\d{4}(?:-\d{2}(?:-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/;
const MAIL_DATE =
  /^(?:[A-Za-z]{3},?\s+)?\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:[A-Za-z]{1,5}|[+-]\d{4}))?$/;

const short = (name: string | undefined): string =>
  name === undefined ? "nothing" : name.length > 40 ? `${name.slice(0, 40)}...` : name;

/**
 * This function changes a date of a sitemap or a feed into ISO 8601. It reads the W3C form of the
 * sitemap protocol and Atom, and the mail form of RSS. A time with no zone is UTC. It gives null
 * for a text that it cannot read.
 *
 * @beta
 */
export const feedDate = (value: string): string | null => {
  const text = value.trim();
  if (text.length === 0 || text.length > 64) return null;
  let parse: string | undefined;
  const w3c = W3C_DATE.exec(text);
  if (w3c !== null) {
    const iso = text.replace(" ", "T");
    // a time with no zone is UTC, and Date.parse reads it as local time
    parse = iso.includes("T") && w3c[1] === undefined ? `${iso}Z` : iso;
  } else if (MAIL_DATE.test(text)) parse = text;
  if (parse === undefined) return null;
  const ms = Date.parse(parse);
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : null;
};

/** This function gives the canonical form of an http(s) URL, or undefined. A relative URL needs a base. */
const webUrl = (value: string, base: string | undefined): string | undefined => {
  const text = value.trim();
  if (text.length === 0 || text.length > SITEMAP_LIMITS.maxValue) return undefined;
  try {
    const url = base === undefined ? new URL(text) : new URL(text, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return canonicalUrl(url.href);
  } catch {
    return undefined;
  }
};

/** This function decodes the five entities of XML and the character references. It gives undefined for each other entity. */
const decodeText = (raw: string, meter: Meter): string | undefined => {
  meter.steps += raw.length;
  if (!raw.includes("&")) return raw;
  let out = "";
  let at = 0;
  for (;;) {
    const amp = raw.indexOf("&", at);
    if (amp === -1) return out + raw.slice(at);
    out += raw.slice(at, amp);
    const semi = raw.indexOf(";", amp + 1);
    if (semi === -1 || semi - amp > 10) return undefined;
    const name = raw.slice(amp + 1, semi);
    let char = XML_ENTITIES[name];
    if (char === undefined && /^#(?:\d{1,7}|x[0-9a-fA-F]{1,6})$/.test(name)) {
      const code = name[1] === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff))
        char = String.fromCodePoint(code);
    }
    // an entity of a DTD is not expanded: the value is not valid
    if (char === undefined) return undefined;
    out += char;
    at = semi + 1;
  }
};

interface Tag {
  readonly name: string;
  readonly attributes: ReadonlyArray<readonly [string, string]>;
  readonly selfClosing: boolean;
  /** This value is the position after the `>` of the tag. */
  readonly end: number;
}

const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13;

/** This function reads a start tag from the position after its `<`. It gives undefined for a tag that is not well formed. */
const readTag = (text: string, from: number, meter: Meter): Tag | undefined => {
  const tag = tagAt(text, from);
  // the scan of a tag moves forward only, so its steps are the characters from its start to its end
  meter.steps += (tag?.end ?? text.length) - from;
  return tag;
};

const tagAt = (text: string, from: number): Tag | undefined => {
  const n = text.length;
  let at = from;
  while (at < n) {
    const code = text.charCodeAt(at);
    if (isSpace(code) || code === 47 || code === 62) break;
    at += 1;
  }
  const name = text.slice(from, Math.min(at, from + 256));
  if (at - from > 256 || !NAME.test(name)) return undefined;
  const attributes: Array<readonly [string, string]> = [];
  for (;;) {
    while (at < n && isSpace(text.charCodeAt(at))) at += 1;
    if (at >= n) return undefined;
    const code = text.charCodeAt(at);
    if (code === 62) return { name, attributes, selfClosing: false, end: at + 1 };
    if (code === 47) {
      return text.charCodeAt(at + 1) === 62
        ? { name, attributes, selfClosing: true, end: at + 2 }
        : undefined;
    }
    const start = at;
    while (at < n) {
      const next = text.charCodeAt(at);
      if (isSpace(next) || next === 61 || next === 62 || next === 47) break;
      at += 1;
    }
    const key = text.slice(start, Math.min(at, start + 256));
    if (at - start > 256 || !NAME.test(key)) return undefined;
    while (at < n && isSpace(text.charCodeAt(at))) at += 1;
    if (text.charCodeAt(at) !== 61) return undefined;
    at += 1;
    while (at < n && isSpace(text.charCodeAt(at))) at += 1;
    const quote = text[at];
    if (quote !== '"' && quote !== "'") return undefined;
    const close = text.indexOf(quote, at + 1);
    if (close === -1) return undefined;
    if (attributes.length < MAX_ATTRIBUTES && close - at <= SITEMAP_LIMITS.maxValue)
      attributes.push([key, text.slice(at + 1, close)]);
    at = close + 1;
  }
};

/**
 * This function finds the end of a declaration (`<!DOCTYPE ...>`) with its internal subset. It
 * gives the position after the `>`, or -1, and it tells if the declaration has an internal subset.
 */
const declarationEnd = (
  text: string,
  from: number,
  meter: Meter,
): { readonly end: number; readonly subset: boolean } => {
  let depth = 0;
  let quote = 0;
  let subset = false;
  for (let at = from; at < text.length; at += 1) {
    meter.steps += 1;
    const code = text.charCodeAt(at);
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if (code === 34 || code === 39) quote = code;
    else if (code === 91) {
      depth += 1;
      subset = true;
    } else if (code === 93) depth = Math.max(0, depth - 1);
    else if (code === 62 && depth === 0) return { end: at + 1, subset };
  }
  return { end: -1, subset };
};

/** The fields of an entry that the reader keeps. */
type Field = "loc" | "lastmod" | "changefreq" | "link" | "guid" | "date";

interface OpenEntry {
  readonly depth: number;
  readonly base: string;
  loc: string | undefined;
  link: string | undefined;
  guid: string | undefined;
  lastmod: string | undefined;
  changefreq: string | undefined;
  about: string | undefined;
  /** This value is true when the Atom link of the entry is a link to a web page. */
  linkPage: boolean;
}

interface OpenField {
  readonly field: Field;
  readonly depth: number;
  readonly parts: string[];
  length: number;
  bad: boolean;
}

/** This function reads a text sitemap: each line that is an absolute http(s) URL is an entry. */
const readLines = (text: string, maxEntries: number, meter: Meter): SitemapRead => {
  const entries: SitemapEntry[] = [];
  let invalid = 0;
  let at = 0;
  while (at < text.length) {
    let end = text.indexOf("\n", at);
    if (end === -1) end = text.length;
    meter.steps += end - at + 1;
    const line = end - at > SITEMAP_LIMITS.maxValue + 2 ? "-" : text.slice(at, end).trim();
    at = end + 1;
    if (line.length === 0) continue;
    const url = webUrl(line, undefined);
    if (url === undefined) invalid += 1;
    else entries.push({ url, lastmod: null, changefreq: null });
    if (entries.length >= maxEntries) {
      const complete = at >= text.length;
      return {
        kind: "text",
        entries,
        invalid,
        complete,
        notes: complete ? [] : [`the reader stopped at ${String(maxEntries)} entries`],
      };
    }
  }
  return { kind: "text", entries, invalid, complete: true, notes: [] };
};

/**
 * This function reads a sitemap, a sitemap index, a feed or a text sitemap, and it counts its
 * steps in `meter`. The function `readSitemap` uses it. A test uses it to show that the time is linear.
 */
export const scanSitemap = (
  text: string,
  base: string,
  limits: SitemapLimits = {},
  meter: Meter = { steps: 0 },
): SitemapRead => {
  const maxEntries = Math.max(1, Math.floor(limits.maxEntries ?? SITEMAP_LIMITS.maxEntries));
  const maxDepth = Math.max(1, Math.floor(limits.maxDepth ?? SITEMAP_LIMITS.maxDepth));
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (at < text.length && isSpace(text.charCodeAt(at))) at += 1;
  if (at < text.length && text[at] !== "<") return readLines(text.slice(at), maxEntries, meter);

  const n = text.length;
  const notes: string[] = [];
  const entries: SitemapEntry[] = [];
  const stack: string[] = [];
  const prefixes = new Map<string, string>();
  let kind: SitemapKind = "unknown";
  let invalid = 0;
  let complete = true;
  let done = false;
  let feedBase = base;
  let entry: OpenEntry | undefined;
  let field: OpenField | undefined;
  const stop = (note: string): void => {
    complete = false;
    done = true;
    notes.push(note);
  };

  /** This function tells if a name is a local name of one of the namespaces, or the local name with no prefix. */
  const named = (qname: string, local: string, spaces: readonly string[]): boolean => {
    const colon = qname.indexOf(":");
    if (colon === -1) return qname === local;
    return (
      qname.slice(colon + 1) === local && spaces.includes(prefixes.get(qname.slice(0, colon)) ?? "")
    );
  };
  const attribute = (tag: Tag, local: string, spaces?: readonly string[]): string | undefined => {
    for (const [key, raw] of tag.attributes) {
      if (spaces === undefined ? key === local : named(key, local, spaces) && key.includes(":"))
        return decodeText(raw, meter);
    }
    return undefined;
  };

  const fieldOf = (qname: string): Field | undefined => {
    switch (kind) {
      case "urlset":
      case "sitemapindex":
        if (named(qname, "loc", SITEMAP_NS)) return "loc";
        if (named(qname, "lastmod", SITEMAP_NS)) return "lastmod";
        return kind === "urlset" && named(qname, "changefreq", SITEMAP_NS)
          ? "changefreq"
          : undefined;
      case "rss":
        if (qname === "link") return "link";
        if (qname === "guid") return "guid";
        return qname === "pubDate" ? "date" : undefined;
      case "atom":
        return named(qname, "updated", ATOM_NS) || named(qname, "published", ATOM_NS)
          ? "date"
          : undefined;
      case "rdf":
        if (named(qname, "link", RSS1_NS)) return "link";
        return named(qname, "date", DC_NS) ? "date" : undefined;
      default:
        return undefined;
    }
  };

  const isEntry = (qname: string, depth: number): boolean => {
    switch (kind) {
      case "urlset":
        return depth === 2 && named(qname, "url", SITEMAP_NS);
      case "sitemapindex":
        return depth === 2 && named(qname, "sitemap", SITEMAP_NS);
      case "rss":
        return depth === 3 && qname === "item" && stack[1] === "channel";
      case "atom":
        return depth === 2 && named(qname, "entry", ATOM_NS);
      case "rdf":
        return depth === 2 && named(qname, "item", RSS1_NS);
      default:
        return false;
    }
  };

  const resolveBase = (tag: Tag, against: string): string => {
    const declared = attribute(tag, "xml:base");
    if (declared === undefined) return against;
    try {
      return new URL(declared.trim(), against).href;
    } catch {
      return against;
    }
  };

  const open = (tag: Tag, depth: number): void => {
    for (const [key, raw] of tag.attributes) {
      if (key.startsWith("xmlns:")) {
        const uri = decodeText(raw, meter);
        if (uri !== undefined) prefixes.set(key.slice(6), uri.trim());
      }
    }
    if (depth === 1) {
      const local = tag.name.slice(tag.name.indexOf(":") + 1);
      if (local === "urlset" || local === "sitemapindex" || local === "rss") kind = local;
      else if (local === "feed") kind = "atom";
      else if (local === "RDF") kind = "rdf";
      else {
        stop(`not a sitemap or a feed: the root element is <${short(tag.name)}>`);
        return;
      }
      feedBase = resolveBase(tag, base);
      return;
    }
    if (entry === undefined) {
      if (isEntry(tag.name, depth)) {
        entry = {
          depth,
          base: kind === "atom" ? resolveBase(tag, feedBase) : feedBase,
          loc: undefined,
          link: undefined,
          guid: undefined,
          lastmod: undefined,
          changefreq: undefined,
          about: kind === "rdf" ? attribute(tag, "about", RDF_NS) : undefined,
          linkPage: false,
        };
      }
      return;
    }
    if (field !== undefined) {
      // a field holds text only
      field.bad = true;
      return;
    }
    if (depth !== entry.depth + 1) return;
    if (kind === "atom" && named(tag.name, "link", ATOM_NS)) {
      const rel = (attribute(tag, "rel") ?? "alternate").trim().toLowerCase();
      const href = attribute(tag, "href");
      const type = (attribute(tag, "type") ?? "text/html").trim().toLowerCase();
      // the first alternate link wins, and a link to a web page wins over a link to a file
      const page = type.startsWith("text/html") || type.startsWith("application/xhtml");
      if (
        rel === "alternate" &&
        href !== undefined &&
        (entry.link === undefined || (page && !entry.linkPage))
      ) {
        entry.link = href;
        entry.linkPage = page;
      }
      return;
    }
    const which = fieldOf(tag.name);
    if (which === undefined) return;
    if (which === "guid") {
      // a guid is a link only when it says so, or when it does not say
      const permalink = (attribute(tag, "isPermaLink") ?? "true").trim().toLowerCase();
      if (permalink === "false") return;
    }
    field = { field: which, depth, parts: [], length: 0, bad: false };
  };

  const finishEntry = (current: OpenEntry): void => {
    const raw =
      kind === "urlset" || kind === "sitemapindex"
        ? current.loc
        : (current.link ?? (kind === "rdf" ? current.about : current.guid));
    const url =
      raw === undefined
        ? undefined
        : webUrl(raw, kind === "urlset" || kind === "sitemapindex" ? undefined : current.base);
    if (url === undefined) {
      invalid += 1;
      return;
    }
    const freq = current.changefreq?.trim().toLowerCase();
    entries.push({
      url,
      lastmod: current.lastmod === undefined ? null : feedDate(current.lastmod),
      changefreq:
        freq !== undefined && CHANGEFREQ.has(freq) && kind === "urlset"
          ? (freq as Changefreq)
          : null,
    });
    if (entries.length >= maxEntries) stop(`the reader stopped at ${String(maxEntries)} entries`);
  };

  const close = (depth: number): void => {
    if (field !== undefined && depth === field.depth) {
      const finished = field;
      field = undefined;
      if (finished.bad || entry === undefined) return;
      const value = finished.parts.join("").trim();
      // an empty field gives no value, so a later field (a guid after an empty link) can
      if (value.length === 0) return;
      if (finished.field === "loc") entry.loc ??= value;
      else if (finished.field === "link") entry.link ??= value;
      else if (finished.field === "guid") entry.guid ??= value;
      else if (finished.field === "lastmod" || finished.field === "date") {
        // an Atom entry gives `updated` and `published`: the later field does not replace the first
        entry.lastmod ??= value;
      } else entry.changefreq ??= value;
      return;
    }
    if (entry !== undefined && depth === entry.depth) {
      const finished = entry;
      entry = undefined;
      finishEntry(finished);
    }
  };

  const addText = (value: string | undefined): void => {
    if (field === undefined || field.bad) return;
    if (value === undefined || field.length + value.length > SITEMAP_LIMITS.maxValue) {
      field.bad = true;
      return;
    }
    field.parts.push(value);
    field.length += value.length;
  };

  while (at < n && !done) {
    meter.steps += 1;
    const lt = text.indexOf("<", at);
    const end = lt === -1 ? n : lt;
    if (end > at) {
      meter.steps += end - at;
      if (field !== undefined && !field.bad) {
        addText(
          end - at > SITEMAP_LIMITS.maxValue ? undefined : decodeText(text.slice(at, end), meter),
        );
      }
    }
    if (lt === -1) break;
    at = lt;
    if (text.startsWith("<!--", at)) {
      const endOf = text.indexOf("-->", at + 4);
      if (endOf === -1) {
        stop("a comment does not end");
        break;
      }
      meter.steps += endOf + 3 - at;
      at = endOf + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", at)) {
      const endOf = text.indexOf("]]>", at + 9);
      if (endOf === -1) {
        stop("a CDATA section does not end");
        break;
      }
      meter.steps += endOf + 3 - at;
      if (field !== undefined && !field.bad) {
        addText(endOf - at - 9 > SITEMAP_LIMITS.maxValue ? undefined : text.slice(at + 9, endOf));
      }
      at = endOf + 3;
      continue;
    }
    if (text.startsWith("<?", at)) {
      const endOf = text.indexOf("?>", at + 2);
      if (endOf === -1) {
        stop("a processing instruction does not end");
        break;
      }
      meter.steps += endOf + 2 - at;
      at = endOf + 2;
      continue;
    }
    if (text.startsWith("<!", at)) {
      const declaration = declarationEnd(text, at + 2, meter);
      if (declaration.end === -1) {
        stop("a declaration does not end");
        break;
      }
      if (declaration.subset && /^<!DOCTYPE/i.test(text.slice(at, at + 9))) {
        notes.push("the file declares a DTD: the reader ignores it and expands no entity");
      }
      at = declaration.end;
      continue;
    }
    if (text.startsWith("</", at)) {
      const endOf = text.indexOf(">", at + 2);
      if (endOf === -1) {
        stop("an end tag does not end");
        break;
      }
      meter.steps += endOf + 1 - at;
      const name = text.slice(at + 2, Math.min(endOf, at + 300)).trim();
      const top = stack.pop();
      if (top !== name) {
        stop(`the end tag </${short(name)}> does not match <${short(top)}>`);
        break;
      }
      close(stack.length + 1);
      at = endOf + 1;
      // the text after the root element is not part of the file
      if (stack.length === 0) break;
      continue;
    }
    const tag = readTag(text, at + 1, meter);
    if (tag === undefined) {
      stop("a start tag is not well formed");
      break;
    }
    at = tag.end;
    const depth = stack.length + 1;
    if (depth > maxDepth) {
      stop(`the elements nest deeper than ${String(maxDepth)}`);
      break;
    }
    open(tag, depth);
    if (done) break;
    if (tag.selfClosing) close(depth);
    else stack.push(tag.name);
    if (depth === 1 && tag.selfClosing) break;
  }
  if (!done && stack.length > 0) stop("the file ends inside an element");
  if (kind === "unknown" && notes.length === 0) {
    complete = false;
    notes.push("not a sitemap or a feed: the file has no root element");
  }
  return { kind, entries, invalid, complete, notes };
};

/**
 * This function reads a sitemap, a sitemap index, an RSS or Atom feed, or a text sitemap. The
 * root element of the file tells its kind. The entries of a feed can have URLs relative to `base`
 * (the URL of the file). The entries of a sitemap must have absolute URLs.
 *
 * @beta
 */
export const readSitemap = (text: string, base: string, limits?: SitemapLimits): SitemapRead =>
  scanSitemap(text, base, limits);
