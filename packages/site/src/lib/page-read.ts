/**
 * What the crawler reads in one HTML page, as plain data. The page reader gets this data from a
 * worker, so a large page does not stop the page of the tool. The build also uses it for the first
 * example, so that the HTML of the page shows a result.
 */
import { extractPage, readJsonLd, typesOf } from "polite-crawler/html";

export interface PageRead {
  readonly ok: boolean;
  readonly error?: string;
  readonly title: string;
  /** the page has no title, so the reader uses the URL */
  readonly titleFromUrl: boolean;
  readonly lang: string | null;
  readonly types: readonly string[];
  readonly text: string;
  readonly jsonld: string;
  /** the JSON-LD blocks that the reader could not parse */
  readonly brokenJsonLd: number;
  readonly links: ReadonlyArray<{ readonly href: string; readonly text: string }>;
  readonly linkCount: number;
  readonly needsRender: boolean;
  readonly renderReason: string | null;
  readonly visibleChars: number;
  /** the canonical URL of the page, when it is on the same site */
  readonly canonical: string | null;
  /** the target of a meta refresh that sends the reader on at once */
  readonly redirect: string | null;
  /** the bot check or the firewall that sent its page in place of the content */
  readonly blocked: string | null;
  /** what the reader left out */
  readonly notes: readonly string[];
}

const BLOCKS =
  /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

/** This function counts the JSON-LD blocks with text that does not give a JSON-LD object. */
export const brokenJsonLd = (html: string): number =>
  [...html.matchAll(BLOCKS)].filter((match) => {
    const source = match[1] ?? "";
    return source.trim().length > 0 && readJsonLd([source]).length === 0;
  }).length;

/** This function reads one page with `extractPage`, as the crawler does. */
export const readPage = (html: string, url: string): PageRead => {
  const pageUrl = url.trim().length > 0 ? url.trim() : "https://example.com/";
  try {
    const page = extractPage(html, pageUrl);
    return {
      ok: true,
      title: page.title,
      titleFromUrl: page.title === pageUrl,
      lang: page.lang,
      types: [...new Set(page.jsonld.flatMap(typesOf))],
      text: page.text,
      jsonld: page.jsonld.length > 0 ? JSON.stringify(page.jsonld, null, 2) : "",
      brokenJsonLd: brokenJsonLd(html),
      links: page.links.slice(0, 20),
      linkCount: page.links.length,
      needsRender: page.needsRender,
      renderReason: page.renderReason ?? null,
      visibleChars: page.visibleChars,
      canonical: page.canonical,
      redirect: page.redirect,
      blocked: page.blocked,
      notes: page.notes,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      title: "",
      titleFromUrl: false,
      lang: null,
      types: [],
      text: "",
      jsonld: "",
      brokenJsonLd: 0,
      links: [],
      linkCount: 0,
      needsRender: false,
      renderReason: null,
      visibleChars: 0,
      canonical: null,
      redirect: null,
      blocked: null,
      notes: [],
    };
  }
};
