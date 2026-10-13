import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { canonicalUrl } from "./urls.ts";

export { bodyEncoding, decodeBody } from "./text.ts";

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
 * main text of Readability comes first. A blank line follows it, and then each other line of the
 * page.
 *
 * The cost of the reader grows in proportion to the size of the page. It walks the document with
 * no recursion, so deep markup cannot overflow the stack. It does not use Readability on a page
 * that is too large or too deep for it.
 */

export interface PageLink {
  readonly href: string;
  readonly text: string;
}

export interface PageExtract {
  readonly title: string;
  readonly description: string | null;
  readonly text: string;
  /**
   * When the reader cut `text` to its maximum, this text is the whole visible text in the order of
   * the page. A quote past the cut is still in it. Otherwise this value is undefined.
   */
  readonly fullText?: string | undefined;
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
  /** This URL is the `<link rel="canonical">` of the page when it is on the same site, or null. */
  readonly canonical: string | null;
  /** This URL is the target of a `<meta http-equiv="refresh">` that sends the reader on in 5 seconds or less. */
  readonly redirect: string | null;
  /**
   * This value names the bot check or the firewall that sent its page in place of the content, for
   * example "Cloudflare". A crawler must not open a browser to get past it.
   */
  readonly blocked: string | null;
  /** These notes tell what the reader left out, for example a JSON-LD block that it cannot read. */
  readonly notes: readonly string[];
}

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  // a template is inert; a declarative shadow root is read (see `isShadowRoot`)
  "template",
  "svg",
  "math",
  // never shown, and a page without a <head> leaves it among the content
  "title",
  "meta",
  "link",
  "base",
  "iframe",
  "frame",
  "object",
  "embed",
  "canvas",
  "audio",
  "video",
  "datalist",
  "param",
  "source",
  "track",
]);
/** These elements show as blocks: each starts a line. The list follows the default style sheet of HTML. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "br",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  // linkedom leaves the content of a page that never closes its <head> inside it
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "legend",
  "li",
  "listing",
  "main",
  "marquee",
  "menu",
  "nav",
  "noframes",
  "ol",
  // a dropdown's choices, one to a line
  "optgroup",
  "option",
  "p",
  "plaintext",
  "pre",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
  "xmp",
]);
/**
 * These elements run inline with the text around them. Any other element, a custom element too,
 * ends a word, so its text stays apart from the next word.
 */
const INLINE = new Set([
  "a",
  "abbr",
  "acronym",
  "b",
  "bdi",
  "bdo",
  "big",
  "blink",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "img",
  "ins",
  "kbd",
  "label",
  "mark",
  "nobr",
  "picture",
  "q",
  "rb",
  "rp",
  "rt",
  "rtc",
  "ruby",
  "s",
  "samp",
  "slot",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
]);
/** A table row becomes one line ("Sunday 10 am–5 pm"), with a space between its cells. */
const CELL = new Set(["td", "th"]);
const WORD_END = new Set(["a", "button"]);

/** A page shorter than this keeps all its text. On a longer page, the text of Readability comes first. */
const SHORT_PAGE_CHARS = 6000;
const MAX_TEXT_CHARS = 50_000;
/** On a long page, this part of the text is kept for the lines after the article: a footer keeps its hours. */
const REST_RESERVE_CHARS = 12_000;
const MAX_LINKS = 300;
/** Readability takes seconds on a page with more elements or links than this, and more time again on deep markup. */
const READABILITY_MAX_ELEMENTS = 10_000;
const READABILITY_MAX_LINKS = 1500;
const READABILITY_MAX_DEPTH = 150;
/**
 * The parser of linkedom takes time in proportion to the square of the depth of the markup: 200,000
 * levels take 30 seconds. The reader reads the tags below this depth as text.
 */
const MAX_DEPTH = 1000;

/** This is the small part of the DOM that this file uses. Node has no DOM types, and linkedom supplies the DOM. */
interface DomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<DomNode>;
  readonly firstChild?: DomNode | null | undefined;
  readonly nextSibling?: DomNode | null | undefined;
  readonly parentNode?: DomNode | null | undefined;
  /** This method takes the node out of its parent. */
  readonly remove?: (() => void) | undefined;
}

interface DomElement extends DomNode {
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomElement | null;
  /** This is the content of a `<template>`. */
  readonly content?: DomNode | null | undefined;
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

/** These elements have no end tag. */
const VOID = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** The content of these elements is text up to their end tag, not markup. */
const RAW_TEXT = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);
/** A new element of one of these kinds closes the open one ("<li>one<li>two"). */
const IMPLIED_END = new Set([
  "dd",
  "dt",
  "li",
  "optgroup",
  "option",
  "p",
  "rb",
  "rp",
  "rt",
  "rtc",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
]);

const isLetter = (code: number): boolean => (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
const isNameChar = (code: number): boolean =>
  isLetter(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x3a || code === 0x5f || code === 0x2e;

/** This function gives the index after the `>` of a tag. A `>` inside a quoted attribute value does not end it. */
const endOfTag = (html: string, from: number): number => {
  let quote = 0;
  let afterEquals = false;
  for (let at = from; at < html.length; at += 1) {
    const code = html.charCodeAt(at);
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if ((code === 0x22 || code === 0x27) && afterEquals) {
      quote = code;
    } else if (code === 0x3e) {
      return at + 1;
    }
    if (code === 0x3d) afterEquals = true;
    else if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) afterEquals = false;
  }
  return html.length;
};

/**
 * This function reads the tags below `MAX_DEPTH` levels as text: a block tag becomes a line break
 * and another tag becomes nothing. It counts the open elements roughly, in one pass. When it
 * removes nothing, it gives the same string.
 */
const flattenDeepMarkup = (html: string): { readonly html: string; readonly dropped: number } => {
  const stack: string[] = [];
  const open = new Map<string, number>();
  const extra = new Map<string, number>();
  const out: string[] = [];
  let copied = 0;
  let dropped = 0;
  const popTo = (name: string): void => {
    if ((open.get(name) ?? 0) === 0) return;
    for (;;) {
      const top = stack.pop()!;
      open.set(top, (open.get(top) ?? 1) - 1);
      if (top === name) return;
    }
  };
  const replace = (start: number, end: number, name: string): void => {
    out.push(html.slice(copied, start), BLOCK.has(name) ? "\n" : INLINE.has(name) ? "" : " ");
    copied = end;
  };
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const next = html.charCodeAt(lt + 1);
    if (next === 0x21 || next === 0x3f) {
      const end = html.indexOf(">", lt);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    const closing = next === 0x2f;
    const nameStart = lt + (closing ? 2 : 1);
    if (!isLetter(html.charCodeAt(nameStart))) {
      index = lt + 1;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (nameEnd < html.length && isNameChar(html.charCodeAt(nameEnd))) nameEnd += 1;
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const tagEnd = endOfTag(html, nameEnd);
    index = tagEnd;
    if (closing) {
      // the deepest elements close first, and those are the ones that were removed
      const removed = extra.get(name) ?? 0;
      if (removed > 0) {
        extra.set(name, removed - 1);
        replace(lt, tagEnd, name);
      } else {
        popTo(name);
      }
      continue;
    }
    if (RAW_TEXT.has(name)) {
      const end = new RegExp(`</${name}[\\s/>]`, "gi");
      end.lastIndex = tagEnd;
      index = end.exec(html)?.index ?? html.length;
      continue;
    }
    if (VOID.has(name) || html.charCodeAt(tagEnd - 2) === 0x2f) continue;
    if (IMPLIED_END.has(name)) popTo(name);
    if (stack.length >= MAX_DEPTH) {
      extra.set(name, (extra.get(name) ?? 0) + 1);
      dropped += 1;
      replace(lt, tagEnd, name);
      continue;
    }
    stack.push(name);
    open.set(name, (open.get(name) ?? 0) + 1);
  }
  if (dropped === 0) return { html, dropped };
  out.push(html.slice(copied));
  return { html: out.join(""), dropped };
};

const attribute = (node: DomNode, name: string): string | null =>
  typeof (node as Partial<DomElement>).getAttribute === "function"
    ? (node as DomElement).getAttribute(name)
    : null;

/** A `<template shadowrootmode>` holds a declarative shadow root: the browser shows its content. */
const isShadowRoot = (node: DomNode): boolean =>
  attribute(node, "shadowrootmode") !== null || attribute(node, "shadowroot") !== null;

/** The reader reads only these properties of an inline style. */
const STYLE_PROPERTIES = new Set(["display", "font-size"]);

/**
 * This function reads `display` and `font-size` from the `style` attribute of an element. The last
 * declaration wins, and an `!important` declaration wins over a declaration that is not important.
 * It reads no style sheet. Its time grows in proportion to the length of the attribute.
 */
const inlineStyle = (node: DomNode): ReadonlyMap<string, string> => {
  const found = new Map<string, string>();
  const style = attribute(node, "style");
  if (style === null || style.length === 0) return found;
  const important = new Set<string>();
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (!STYLE_PROPERTIES.has(property)) continue;
    let value = declaration.slice(colon + 1).trim().toLowerCase();
    const bang = value.lastIndexOf("!");
    const strong = bang !== -1 && value.slice(bang + 1).trim() === "important";
    if (strong) value = value.slice(0, bang).trim();
    if (important.has(property) && !strong) continue;
    if (strong) important.add(property);
    found.set(property, value);
  }
  return found;
};

/**
 * This function tells if a reader of the page does not get an element and its content. A browser
 * does not show an element with `display: none` or with the attribute `hidden` (unless its inline
 * style sets a different display). A screen reader skips an element with `aria-hidden="true"`, and
 * a model reads a page as a screen reader does.
 */
const notRendered = (node: DomNode, style: ReadonlyMap<string, string>): boolean => {
  const display = style.get("display");
  if (display === "none") return true;
  if (display === undefined && attribute(node, "hidden") !== null) return true;
  return attribute(node, "aria-hidden")?.trim().toLowerCase() === "true";
};

/** A font size of zero: `0`, `0px`, `0em` or `0%`. */
const ZERO_SIZE = /^\+?(?:0+(?:\.0*)?|\.0+)(?:[a-z]{1,4}|%)?$/;
/** These sizes are a part of the size of the parent, so a part of zero stays zero. */
const RELATIVE_SIZE = /^(?:\+?[\d.]+(?:em|ex|ch|cap|ic|lh|%)|larger|smaller|inherit|unset|revert|revert-layer)$/;

/** This function tells if the text of an element has a zero size. A child that sets a size of its own shows its text again. */
const zeroSize = (fontSize: string | undefined, parentZero: boolean): boolean => {
  if (fontSize === undefined) return parentZero;
  if (ZERO_SIZE.test(fontSize)) return true;
  return parentZero && RELATIVE_SIZE.test(fontSize);
};

interface Walked {
  readonly text: string;
  readonly elements: number;
  readonly links: number;
  readonly depth: number;
  /** These nodes are not text for a reader: the elements that `notRendered` refuses, and the text of a zero size. */
  readonly unseen: readonly DomNode[];
}

interface Frame {
  readonly name: string;
  /** The children of an element are read with `nextSibling`, which costs nothing in linkedom. */
  next: DomNode | null | undefined;
  /** linkedom gives a document type no `nextSibling`, so the few children of a document are read as a list. */
  readonly list: ArrayLike<DomNode> | undefined;
  index: number;
  /** This value is true when the text of the element has a zero size. */
  readonly zero: boolean;
}

/**
 * This function walks a tree with a stack of its own. Thus the depth of the markup cannot overflow
 * the stack. It reads only the text that a reader gets (refer to `notRendered` and `zeroSize`), and it
 * gives the nodes that it did not read.
 */
const walkText = (root: DomNode): Walked => {
  const parts: string[] = [];
  const unseen: DomNode[] = [];
  // a link or a button ends a word even where the markup runs it into the
  // next ("Offers from AmexGlobal Dining Access"), though not before a stop
  let seam = false;
  let elements = 0;
  let links = 0;
  let depth = 0;
  const stack: Frame[] = [];
  const enter = (node: DomNode): void => {
    if (node.nodeType === 3) {
      if (stack[stack.length - 1]?.zero === true) {
        unseen.push(node);
        return;
      }
      const text = node.textContent ?? "";
      if (seam && /^[^\s.,;:!?)\]–—-]/.test(text)) parts.push(" ");
      if (text.length > 0) seam = false;
      parts.push(text);
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    const name = node.nodeName.toLowerCase();
    let container = node;
    if (name === "template") {
      if (!isShadowRoot(node)) return;
      container = (node as DomElement).content ?? node;
    } else if (SKIP.has(name)) {
      return;
    }
    let zero = stack[stack.length - 1]?.zero ?? false;
    if (node.nodeType === 1) {
      const style = inlineStyle(node);
      if (notRendered(node, style)) {
        unseen.push(node);
        return;
      }
      zero = zeroSize(style.get("font-size"), zero);
      elements += 1;
      if (name === "a") links += 1;
      if (BLOCK.has(name)) parts.push("\n");
      else if (!INLINE.has(name) && !CELL.has(name)) seam = true;
    }
    stack.push(
      container.nodeType === 1
        ? { name, next: container.firstChild, list: undefined, index: 0, zero }
        : { name, next: undefined, list: container.childNodes, index: 0, zero },
    );
    if (stack.length > depth) depth = stack.length;
  };
  const leave = (name: string): void => {
    const block = BLOCK.has(name);
    if (block) parts.push("\n");
    else if (CELL.has(name)) parts.push(" ");
    if (block) seam = false;
    else if (WORD_END.has(name) || !INLINE.has(name)) seam = true;
  };
  enter(root);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    let child: DomNode | null | undefined;
    if (frame.list !== undefined) {
      child = frame.index < frame.list.length ? frame.list[frame.index] : undefined;
      frame.index += 1;
    } else {
      child = frame.next;
      if (child !== null && child !== undefined) frame.next = child.nextSibling;
    }
    if (child === null || child === undefined) {
      stack.pop();
      leave(frame.name);
    } else {
      enter(child);
    }
  }
  const text = parts
    .join("")
    .split("\n")
    .map((line) =>
      line
        .replace(/[​-‍⁠﻿­]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join("\n");
  return { text, elements, links, depth, unseen };
};

/** This function gives the text that a reader sees, with one line for each block. */
export const visibleText = (root: DomNode): string => walkText(root).text;

// ── JSON-LD ─────────────────────────────────────────────────────────────────

const WRAPPERS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^<!--/, /-->$/],
  [/^\/\/\s{0,8}<!\[CDATA\[/, /\/\/\s{0,8}\]\]>$/],
  [/^\/\*\s{0,8}<!\[CDATA\[\s{0,8}\*\//, /\/\*\s{0,8}\]\]>\s{0,8}\*\/$/],
  [/^<!\[CDATA\[/, /\]\]>$/],
];

const unwrap = (source: string): string => {
  let text = source.replace(/^﻿/, "").trim();
  for (const [open, close] of WRAPPERS) {
    text = text.replace(open, "").trim();
    text = text.replace(close, "").trim();
  }
  return text;
};

/**
 * This function cuts a script into its top-level JSON values. It also repairs two common faults: a
 * comma before a closing bracket, and a raw control character inside a string.
 */
const jsonValues = (source: string): string[] => {
  const values: string[] = [];
  let out: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let pendingComma = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const code = source.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      // a string between two values is skipped with them
      if (depth === 0) continue;
      out.push(
        code >= 0x20
          ? char
          : char === "\n"
            ? "\\n"
            : char === "\r"
              ? "\\r"
              : char === "\t"
                ? "\\t"
                : `\\u${code.toString(16).padStart(4, "0")}`,
      );
      continue;
    }
    if (depth === 0) {
      // between values only an object or an array starts a value
      if (char === "{" || char === "[") {
        depth = 1;
        out = [char];
        pendingComma = false;
      } else if (char === '"') {
        inString = true;
      }
      continue;
    }
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      out.push(char);
      continue;
    }
    if (char === ",") {
      if (pendingComma) out.push(",");
      pendingComma = true;
      continue;
    }
    if (pendingComma) {
      // a comma before a closing bracket is dropped
      if (char !== "}" && char !== "]") out.push(",");
      pendingComma = false;
    }
    out.push(char);
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        values.push(out.join(""));
        out = [];
      }
    }
  }
  // a value that never closes is given whole, and its parse fails
  if (depth > 0) values.push(out.join(""));
  return values;
};

const parseJsonLd = (
  sources: readonly string[],
): { readonly records: Record<string, unknown>[]; readonly unreadable: number } => {
  const records: Record<string, unknown>[] = [];
  let unreadable = 0;
  // an explicit stack: JSON nested deeply in arrays cannot overflow the call stack
  const push = (first: unknown): void => {
    const stack: unknown[] = [first];
    const found: Record<string, unknown>[] = [];
    while (stack.length > 0) {
      const value = stack.pop();
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
        continue;
      }
      if (value === null || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      const graph = record["@graph"];
      if (graph !== undefined && graph !== null && typeof graph === "object") {
        const { "@graph": _graph, ...rest } = record;
        // the record itself first, then its graph, in the order of the page
        stack.push(graph);
        if (Object.keys(rest).some((key) => key !== "@context")) found.push(rest);
        continue;
      }
      found.push(record);
    }
    records.push(...found);
  };
  for (const source of sources) {
    const text = unwrap(source);
    if (text.length === 0) continue;
    try {
      push(JSON.parse(text));
      continue;
    } catch {
      // repaired below
    }
    let failed = false;
    let any = false;
    for (const value of jsonValues(text)) {
      try {
        push(JSON.parse(value));
        any = true;
      } catch {
        failed = true;
      }
    }
    if (failed || !any) unreadable += 1;
  }
  return { records, unreadable };
};

/**
 * This function reads the JSON-LD blocks and makes arrays and `@graph` flat. It repairs a comma
 * before a closing bracket, a raw line break in a string and two values in one block. It ignores
 * a block that it cannot repair.
 */
export const readJsonLd = (sources: readonly string[]): Record<string, unknown>[] =>
  parseJsonLd(sources).records;

/** This function gives the types that a JSON-LD object declares, without the schema.org prefix. */
export const typesOf = (record: Record<string, unknown>): string[] => {
  const raw = record["@type"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/^.*[/#]/, "").replace(/^[A-Za-z][\w.+-]*:/, ""));
};

// ── URLs ────────────────────────────────────────────────────────────────────

export { canonicalUrl };

const isWeb = (url: URL): boolean => url.protocol === "http:" || url.protocol === "https:";
const siteOf = (host: string): string => host.toLowerCase().replace(/^www\./, "");

// ── what the page needs ─────────────────────────────────────────────────────

/** The marks of the pages that a bot check or a firewall sends in place of the content. */
const CHALLENGES: ReadonlyArray<readonly [string, RegExp]> = [
  ["Incapsula", /_Incapsula_Resource|Incapsula incident ID/i],
  ["Cloudflare", /\/cdn-cgi\/challenge-platform\/|cf-chl-|cf_chl_opt|cf-browser-verification/i],
  ["Sucuri", /sucuri_cloudproxy|Sucuri WebSite Firewall/i],
  ["DataDome", /captcha-delivery\.com/i],
  ["PerimeterX", /_pxCaptcha|px-captcha|captcha\.px-cdn\.net/i],
  ["AWS WAF", /AwsWafIntegration|token\.awswaf\.com|\/challenge\.js.{0,80}awswaf/i],
  ["DDoS-Guard", /ddos-guard\.net\/|__ddg1_/i],
];
const CHALLENGE_TITLE =
  /^(?:just a moment\.*|attention required!? \| cloudflare|access to this page has been denied\.?|please verify you are a human|are you a robot\??|ddos-guard|checking your browser.{0,40})$/i;

const ASKS_FOR_SCRIPT =
  /(?:enable|turn on|activate|switch on|allow)\s+(?:your\s+)?javascript|javascript\s+(?:is\s+)?(?:required|disabled|turned off|not enabled|must be enabled|needs to be enabled)|(?:requires?|needs?)\s+javascript|javascript\s+aktivieren|activ(?:er|ez)\s+(?:le\s+)?javascript|habilit(?:ar|e)\s+(?:el\s+)?javascript/i;
/** The noscript of a comment widget (Disqus) asks for JavaScript for the comments, not for the page. */
const COMMENTS = /comments|disqus/i;

/** These elements hold the whole page of an application that its scripts draw. */
const APP_ROOTS = "#root, #app, #__next, #__nuxt, #___gatsby, app-root, my-app, [data-reactroot]";

const EMBEDDED: ReadonlyArray<readonly [string, (html: string, doc: DomDocument) => boolean]> = [
  ["next", (_html, doc) => doc.querySelector('script[id="__NEXT_DATA__"]') !== null],
  ["next-app", (html) => html.includes("self.__next_f.push")],
  ["nuxt", (html) => html.includes("__NUXT_DATA__") || html.includes("window.__NUXT__")],
  ["apollo", (html) => html.includes("__APOLLO_STATE__")],
];

/** This function reads `content="0; url=/home"`. A refresh with no URL reloads the page, and is no redirect. */
const refreshTarget = (content: string): { readonly delay: number; readonly url: string } | undefined => {
  const text = content.slice(0, 2000).trim();
  const delay = /^\d+(?:\.\d*)?/.exec(text)?.[0] ?? "";
  const url = text
    .slice(delay.length)
    .replace(/^[\s;,]+/, "")
    .replace(/^url\s*=\s*/i, "")
    .replace(/^(["'])(.*)\1$/s, "$2")
    .trim();
  return url.length === 0 ? undefined : { delay: Number(delay || 0), url };
};

// ── composing the text ──────────────────────────────────────────────────────

/** This function cuts text to a length at the end of a line where it can. It does not cut a surrogate pair. */
const cutHead = (text: string, length: number): string => {
  if (text.length <= length) return text;
  if (length <= 0) return "";
  const line = text.lastIndexOf("\n", length);
  let end = line > length - 2000 && line > 0 ? line : length;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
};

/** This function keeps the end of the text, from the start of a line where it can. */
const cutTail = (text: string, length: number): string => {
  if (text.length <= length) return text;
  if (length <= 0) return "";
  let start = text.length - length;
  const line = text.indexOf("\n", start);
  if (line !== -1 && line < start + 2000) start = line + 1;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
};

/** This function keeps the start and the end of a text that is too long: a footer keeps its hours. */
const capText = (text: string): string =>
  text.length <= MAX_TEXT_CHARS
    ? text
    : `${cutHead(text, MAX_TEXT_CHARS - REST_RESERVE_CHARS - 2)}\n\n${cutTail(text, REST_RESERVE_CHARS)}`;

/** A line that can label the lines below it: short, with no number, and not a sentence ("Opening hours"). */
const isHeading = (line: string): boolean =>
  line.length <= 40 && !/[.!?]$/.test(line) && !/[0-9]/.test(line);

/**
 * This function finds the lines of the article in the lines of the page, one for one and in order.
 * Thus a line that the article and a sidebar share stays in the sidebar ("10 am – 5 pm").
 */
const articleLines = (all: readonly string[], main: readonly string[]): Uint8Array => {
  const taken = new Uint8Array(all.length);
  const positions = new Map<string, number[]>();
  all.forEach((line, index) => {
    const list = positions.get(line);
    if (list === undefined) positions.set(line, [index]);
    else list.push(index);
  });
  const cursors = new Map<string, number>();
  let at = 0;
  let matched = 0;
  for (const line of main) {
    const list = positions.get(line);
    if (list === undefined) continue;
    let cursor = cursors.get(line) ?? 0;
    while (cursor < list.length && list[cursor]! < at) cursor += 1;
    cursors.set(line, cursor);
    const position = list[cursor];
    if (position === undefined) continue;
    // a line far ahead is the same line only when the page has it once
    if (matched > 0 && position - at > 400 && list.length > 1) continue;
    taken[position] = 1;
    cursors.set(line, cursor + 1);
    at = position + 1;
    matched += 1;
  }
  return taken;
};

/** This function gives the lines of the page that are not in the article. Each run keeps the heading above it. */
const restOf = (all: readonly string[], taken: Uint8Array): string[] => {
  const rest: string[] = [];
  for (let index = 0; index < all.length; index += 1) {
    if (taken[index] === 1) continue;
    const above = all[index - 1];
    if (index > 0 && taken[index - 1] === 1 && above !== undefined && isHeading(above)) rest.push(above);
    rest.push(all[index]!);
  }
  return rest;
};

export const extractPage = (html: string, pageUrl: string): PageExtract => {
  const notes: string[] = [];
  const flat = flattenDeepMarkup(html);
  if (flat.dropped > 0) {
    notes.push(
      `the markup nests deeper than ${String(MAX_DEPTH)} elements, so the reader read the deeper tags as text`,
    );
  }
  const doc = parse(flat.html);
  const meta = (selector: string): string | null =>
    doc.querySelector(selector)?.getAttribute("content")?.trim() || null;

  const scripts = [...doc.querySelectorAll("script")];
  const parsed = parseJsonLd(
    scripts
      .filter((node) => /^\s*application\/ld\+json\s*(?:;|$)/i.test(node.getAttribute("type") ?? ""))
      .map((node) => node.textContent ?? ""),
  );
  const jsonld = parsed.records;
  if (parsed.unreadable > 0) {
    notes.push(
      `${String(parsed.unreadable)} JSON-LD ${parsed.unreadable === 1 ? "block" : "blocks"} could not be read`,
    );
  }

  const page = (() => {
    try {
      return new URL(pageUrl);
    } catch {
      return undefined;
    }
  })();
  const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
  const base = (() => {
    try {
      const resolved = new URL(baseHref ?? pageUrl, pageUrl);
      // a <base href="javascript:..."> would take every relative link with it
      return isWeb(resolved) ? resolved.href : pageUrl;
    } catch {
      return pageUrl;
    }
  })();
  const resolve = (raw: string): URL | undefined => {
    try {
      const url = new URL(raw.trim(), base);
      if (!isWeb(url)) return undefined;
      url.username = "";
      url.password = "";
      return url;
    } catch {
      return undefined;
    }
  };
  const self = page === undefined ? undefined : canonicalUrl(page.href);

  const refresh = [...doc.querySelectorAll("meta[http-equiv]")]
    .filter((node) => /^\s*refresh\s*$/i.test(node.getAttribute("http-equiv") ?? ""))
    .map((node) => refreshTarget(node.getAttribute("content") ?? ""))
    .find((target) => target !== undefined);
  const refreshUrl = refresh === undefined ? undefined : resolve(refresh.url);
  const redirect =
    refresh !== undefined &&
    refresh.delay <= 5 &&
    refreshUrl !== undefined &&
    canonicalUrl(refreshUrl.href) !== self
      ? canonicalUrl(refreshUrl.href)
      : null;

  const canonical = (() => {
    const node = [...doc.querySelectorAll("link[rel][href]")].find((link) =>
      (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"),
    );
    const url = node === undefined ? undefined : resolve(node.getAttribute("href") ?? "");
    // a canonical on another site could take the page's identity: it is not trusted
    if (url === undefined || page === undefined || siteOf(url.hostname) !== siteOf(page.hostname)) {
      return null;
    }
    return canonicalUrl(url.href);
  })();

  const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
  const titles = [...doc.querySelectorAll("title")];
  // an <svg> keeps a <title> of its own ("Icon"), which names no page
  const inSvg = (node: DomNode): boolean => {
    for (let parent = node.parentNode; parent; parent = parent.parentNode) {
      if (parent.nodeName.toLowerCase() === "svg") return true;
    }
    return false;
  };
  const title =
    meta('meta[property="og:title"]') ||
    clean(titles.find((node) => !inSvg(node))?.textContent) ||
    clean(doc.querySelector("h1")?.textContent) ||
    pageUrl;
  const description = meta('meta[name="description"]') ?? meta('meta[property="og:description"]');
  const lang = doc.documentElement?.getAttribute("lang")?.trim() || null;
  const noscript = [...doc.querySelectorAll("noscript")]
    .map((node) => node.textContent ?? "")
    .filter((text) => !COMMENTS.test(text))
    .join(" ");
  const embedded = EMBEDDED.filter(([, found]) => found(html, doc)).map(([name]) => name);
  const appShell = [...doc.querySelectorAll(APP_ROOTS)].some(
    (node) => (node.textContent ?? "").trim().length === 0,
  );

  // the whole document: a page that omits <html> is not under
  // documentElement at all, and document.body can be a decoy (see DomDocument;
  // a homepage read as 0 characters and went to the browser for nothing)
  const walked = walkText(doc);
  // the links and Readability read only what a reader gets: text that the page hides goes now
  for (const node of walked.unseen) node.remove?.();

  const seen = new Set<string>(self === undefined ? [] : [self]);
  const links: PageLink[] = [];
  if (redirect !== null) {
    seen.add(redirect);
    links.push({ href: redirect, text: "" });
  }
  for (const anchor of doc.querySelectorAll("a[href]")) {
    if (links.length >= MAX_LINKS) break;
    const url = resolve(anchor.getAttribute("href") ?? "");
    if (url === undefined) continue;
    const href = canonicalUrl(url.href);
    const text =
      (anchor.textContent ?? "").replace(/\s+/g, " ").trim() ||
      anchor.getAttribute("aria-label")?.trim() ||
      anchor.getAttribute("title")?.trim() ||
      anchor.querySelector("img[alt]")?.getAttribute("alt")?.trim() ||
      "";
    // the link to the target of a meta refresh gets the text of the first anchor that names it
    if (href === redirect && links[0]?.href === redirect && links[0].text === "") {
      links[0] = { href, text: text.slice(0, 120) };
      continue;
    }
    // a link to the page itself ("#menu") is no link
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: text.slice(0, 120) });
  }

  const all = walked.text;
  let text = capText(all);
  let cut = text.length < all.length;
  if (all.length > SHORT_PAGE_CHARS) {
    const main = (() => {
      if (
        walked.elements > READABILITY_MAX_ELEMENTS ||
        walked.links > READABILITY_MAX_LINKS ||
        walked.depth > READABILITY_MAX_DEPTH
      ) {
        notes.push("the page is too large for Readability, so its text is in page order");
        return "";
      }
      try {
        // Readability rewrites the document, and the reader has no more use for it. It gives its
        // article as an element, read here so that blocks stay lines
        const article = new Readability<DomNode>(
          doc as unknown as ConstructorParameters<typeof Readability>[0],
          { charThreshold: 500, disableJSONLD: true, serializer: (node) => node as unknown as DomNode },
        ).parse();
        return article?.content === null || article?.content === undefined
          ? ""
          : visibleText(article.content);
      } catch {
        notes.push("Readability could not read the page, so its text is in page order");
        return "";
      }
    })();
    if (main.length > 500) {
      // the article first, then every other line the page shows: a venue's
      // hours sit in a table or a sidebar Readability drops (a museum's visit
      // page), not only in its footer
      const lines = all.split("\n");
      const rest = restOf(lines, articleLines(lines, main.split("\n"))).join("\n");
      const head = cutHead(main, MAX_TEXT_CHARS - Math.min(rest.length, REST_RESERVE_CHARS) - 2);
      const tail = cutHead(rest, MAX_TEXT_CHARS - head.length - 2);
      text = rest.length > 0 ? `${head}\n\n${tail}` : head;
      cut = head.length < main.length || tail.length < rest.length;
    }
  }
  if (cut) notes.push(`the text is cut to ${String(MAX_TEXT_CHARS)} characters`);

  const visibleChars = all.length;
  const pageTitle = clean(titles[0]?.textContent);
  const blocked =
    visibleChars < 2000
      ? CHALLENGE_TITLE.test(pageTitle)
        ? (CHALLENGES.find(([, pattern]) => pattern.test(html))?.[0] ?? "a bot check")
        : (CHALLENGES.find(([, pattern]) => pattern.test(html))?.[0] ?? null)
      : null;
  const reason =
    // a browser would only go past a bot check or follow the redirect
    blocked !== null || redirect !== null
      ? null
      : // an app shell shows next to nothing; a small venue page can still say
        // its hours and address in a hundred characters, and needs no browser
        visibleChars < 80
        ? `only ${String(visibleChars)} characters of visible text`
        : visibleChars < 1200 && ASKS_FOR_SCRIPT.test(noscript)
          ? "the page asks for JavaScript"
          : visibleChars < 1200 && appShell
            ? "an empty application root"
            : null;

  return {
    title: title.replace(/\s+/g, " ").slice(0, 300),
    description,
    text,
    ...(cut ? { fullText: all } : {}),
    jsonld,
    links,
    lang,
    visibleChars,
    embedded,
    needsRender: reason !== null,
    renderReason: reason,
    canonical,
    redirect,
    blocked,
    notes,
  };
};
