/**
 * The input of the robots.txt tester, made ready for `decide`. A reader can paste a full URL in place
 * of a path, and a full User-Agent header in place of a product token.
 */

/** The parts of a browser User-Agent that are not the name of a bot. */
const BROWSER_PARTS = new Set([
  "mozilla",
  "applewebkit",
  "khtml",
  "gecko",
  "chrome",
  "chromium",
  "safari",
  "version",
  "mobile",
  "firefox",
  "edg",
  "opr",
  "like",
]);

/**
 * This function gives the product token that robots.txt matches. `MyBot/1.0` gives `MyBot`. The header
 * `Mozilla/5.0 (compatible; MyBot/1.0; +https://example.com/bot)` also gives `MyBot`.
 */
export const productToken = (input: string): string => {
  const text = input.trim();
  const first = /^[A-Za-z_-]+/.exec(text)?.[0] ?? "";
  if (first.toLowerCase() !== "mozilla") return first;
  const compatible = /compatible;\s*([A-Za-z_-]+)/i.exec(text)?.[1];
  if (compatible !== undefined) return compatible;
  const products = [...text.matchAll(/([A-Za-z][A-Za-z_-]*)\/[\w.]+/g)].map((match) => match[1] ?? "");
  return products.find((product) => !BROWSER_PARTS.has(product.toLowerCase())) ?? first;
};

/** A path to test, and the text that the reader wrote when it was not a path. */
export interface TestPath {
  readonly path: string;
  readonly from?: string;
}

/**
 * This function gives the path and the query that robots.txt rules match. A URL gives its path and
 * its query, and a path with no leading slash gets one.
 */
export const toPath = (input: string): TestPath => {
  const text = input.trim();
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text
    : text.startsWith("//")
      ? `https:${text}`
      : /^www\.[^/\s]+(\/|$)/i.test(text)
        ? `https://${text}`
        : undefined;
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      return { path: `${parsed.pathname}${parsed.search}`, from: text };
    } catch {
      // not a URL: read the text as a path
    }
  }
  if (text.startsWith("/")) return { path: text };
  return { path: `/${text}`, from: text };
};
