import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/**
 * The page reader reads a web page with no browser first. It gives:
 *
 * 1. The JSON-LD, the structured data that 41% of pages have. For a venue, it gives the name, the
 *    address, the phone number and sometimes the hours.
 * 2. The visible text of the page.
 * 3. A decision: does the page need JavaScript to show its content?
 *
 * On a short page, the text is all of the visible text. Readability is for articles, and it
 * removes footers, sidebars and tables, where a venue keeps its hours. Thus on a long page, the
 * main text of Readability comes first, and each other line of the page follows it.
 */

export interface PageLink {
  readonly href: string;
  readonly text: string;
}

export interface PageExtract {
  readonly title: string;
  readonly description: string | null;
  readonly text: string;
  /** These are the JSON-LD objects of the page, with each `@graph` made flat. */
  readonly jsonld: readonly Record<string, unknown>[];
  readonly links: readonly PageLink[];
  readonly lang: string | null;
  readonly visibleChars: number;
  /** These are the names of the application states that the HTML holds (Next.js, Nuxt, Apollo). */
  readonly embedded: readonly string[];
  /** This value is true when the page shows almost nothing without its scripts. */
  readonly needsRender: boolean;
  readonly renderReason: string | null;
}

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "head",
  // never shown, and a page without a <head> leaves it among the content
  "title",
  "iframe",
  "object",
  "canvas",
]);
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  // a dropdown's choices, one to a line
  "option",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);
/** A table row becomes one line ("Sunday 10 am–5 pm"), with a space between its cells. */
const CELL = new Set(["td", "th"]);
const WORD_END = new Set(["a", "button"]);

/** A page shorter than this keeps all its text. On a longer page, the text of Readability comes first. */
const SHORT_PAGE_CHARS = 6000;
const MAX_TEXT_CHARS = 50_000;
const MAX_LINKS = 300;

interface DomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<DomNode>;
}

/** This is the small part of the DOM that this file uses. Node has no DOM types, and linkedom supplies the DOM. */
interface DomElement {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
}

/**
 * This type has no `body` or `head`, on purpose. When an element comes before `<head>`, linkedom
 * makes a new, empty pair. Then `document.body` reads nothing, but a browser shows the full page.
 */
interface DomDocument extends DomNode {
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement> & Iterable<DomElement>;
  readonly documentElement: DomElement | null;
}

const parse = (html: string): DomDocument =>
  (parseHTML(html) as unknown as { document: DomDocument }).document;

/** This function gives the text that a reader sees, with one line for each block. */
export const visibleText = (root: DomNode): string => {
  const parts: string[] = [];
  // a link or a button ends a word even where the markup runs it into the
  // next ("Offers from AmexGlobal Dining Access"), though not before a stop
  let seam = false;
  const walk = (node: DomNode): void => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      if (seam && /^[^\s.,;:!?)\]–—-]/.test(text)) parts.push(" ");
      if (text.length > 0) seam = false;
      parts.push(text);
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    const name = node.nodeName.toLowerCase();
    if (SKIP.has(name)) return;
    const block = BLOCK.has(name);
    if (block) parts.push("\n");
    for (let index = 0; index < node.childNodes.length; index += 1) walk(node.childNodes[index]!);
    if (block) parts.push("\n");
    else if (CELL.has(name)) parts.push(" ");
    if (block) seam = false;
    else if (WORD_END.has(name)) seam = true;
  };
  walk(root);
  return parts
    .join("")
    .split("\n")
    .map((line) =>
      line
        .replace(/[\u200b-\u200d\ufeff]/g, "")
        .replace(/[ \t\u00a0]+/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join("\n");
};

/** This function reads the JSON-LD blocks and makes arrays and `@graph` flat. It ignores a damaged block. */
export const readJsonLd = (sources: readonly string[]): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record["@graph"])) {
      for (const item of record["@graph"]) push(item);
      const { "@graph": _graph, ...rest } = record;
      if (Object.keys(rest).some((key) => key !== "@context")) out.push(rest);
      return;
    }
    out.push(record);
  };
  for (const source of sources) {
    const cleaned = source
      .replace(/^\s*<!--/, "")
      .replace(/-->\s*$/, "")
      .replace(/^\s*\/\/\s*<!\[CDATA\[/, "")
      .replace(/\/\/\s*\]\]>\s*$/, "")
      .trim();
    try {
      push(JSON.parse(cleaned));
    } catch {
      // a broken block says nothing; the rest of the page still does
    }
  }
  return out;
};

/** This function gives the types that a JSON-LD object declares, without the schema.org prefix. */
export const typesOf = (record: Record<string, unknown>): string[] => {
  const raw = record["@type"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/^.*[/#]/, ""));
};

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_[a-z]+|_ga|_gl|ref_src|igshid)$/i;

/** This function gives one URL for each page: a lowercase host, and no fragment, tracking parameters or default port. */
export const canonicalUrl = (value: string): string => {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  return url.href;
};

const EMBEDDED: ReadonlyArray<readonly [string, RegExp]> = [
  ["next", /<script[^>]+id=["']__NEXT_DATA__["']/i],
  ["next-app", /self\.__next_f\.push/],
  ["nuxt", /__NUXT_DATA__|window\.__NUXT__/],
  ["apollo", /__APOLLO_STATE__/],
];

export const extractPage = (html: string, pageUrl: string): PageExtract => {
  const doc = parse(html);
  const meta = (selector: string): string | null =>
    doc.querySelector(selector)?.getAttribute("content")?.trim() || null;

  const jsonld = readJsonLd(
    [...doc.querySelectorAll('script[type="application/ld+json"]')].map(
      (node) => node.textContent ?? "",
    ),
  );

  const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
  const base = (() => {
    try {
      return new URL(baseHref ?? pageUrl, pageUrl).href;
    } catch {
      return pageUrl;
    }
  })();
  const seen = new Set<string>();
  const links: PageLink[] = [];
  for (const anchor of doc.querySelectorAll("a[href]")) {
    if (links.length >= MAX_LINKS) break;
    const raw = anchor.getAttribute("href") ?? "";
    let href: string;
    try {
      href = canonicalUrl(new URL(raw, base).href);
    } catch {
      continue;
    }
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    const text =
      (anchor.textContent ?? "").replace(/\s+/g, " ").trim() ||
      anchor.getAttribute("aria-label")?.trim() ||
      anchor.getAttribute("title")?.trim() ||
      "";
    links.push({ href, text: text.slice(0, 120) });
  }

  const title =
    meta('meta[property="og:title"]') ??
    doc.querySelector("title")?.textContent?.trim() ??
    doc.querySelector("h1")?.textContent?.trim() ??
    pageUrl;
  const description = meta('meta[name="description"]') ?? meta('meta[property="og:description"]');
  const lang = doc.documentElement?.getAttribute("lang") ?? null;
  const noscript = [...doc.querySelectorAll("noscript")]
    .map((node) => node.textContent ?? "")
    .join(" ");
  const embedded = EMBEDDED.filter(([, pattern]) => pattern.test(html)).map(([name]) => name);

  // the whole document, head skipped: a page that omits <html> is not under
  // documentElement at all, and document.body can be a decoy (see DomDocument;
  // a homepage read as 0 characters and went to the browser for nothing)
  const all = visibleText(doc);
  let text = all;
  if (all.length > SHORT_PAGE_CHARS) {
    // Readability rewrites the document it reads, so it reads its own copy
    const copy = parse(html) as unknown as ConstructorParameters<typeof Readability>[0];
    const article = new Readability(copy, { charThreshold: 500 }).parse();
    // its HTML, read here so blocks stay lines: its textContent runs them
    // together ("Start HereTicketsFor more information")
    const main =
      typeof article?.content === "string"
        ? visibleText(parse(`<!doctype html><html><body>${article.content}</body></html>`))
        : "";
    if (main.length > 500) {
      // the article first, then every other line the page shows: a venue's
      // hours sit in a table or a sidebar Readability drops (a museum's visit
      // page), not only in its footer
      const kept = new Set(main.split("\n"));
      const rest = all
        .split("\n")
        .filter((line) => !kept.has(line))
        .join("\n");
      text = rest.length > 0 ? `${main}\n\n[the rest of the page]\n${rest}` : main;
    }
  }
  text = text.slice(0, MAX_TEXT_CHARS);

  const visibleChars = all.length;
  const appRoot = /<div[^>]+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html);
  const reason =
    // an app shell shows next to nothing; a small venue page can still say
    // its hours and address in a hundred characters, and needs no browser
    visibleChars < 80
      ? `only ${String(visibleChars)} characters of visible text`
      : visibleChars < 1200 &&
          /enable javascript|requires javascript|javascript is (disabled|required)/i.test(noscript)
        ? "the page asks for JavaScript"
        : visibleChars < 600 && appRoot
          ? "an empty application root"
          : null;

  return {
    title: title.replace(/\s+/g, " ").slice(0, 300),
    description,
    text,
    jsonld,
    links,
    lang,
    visibleChars,
    embedded,
    needsRender: reason !== null,
    renderReason: reason,
  };
};
