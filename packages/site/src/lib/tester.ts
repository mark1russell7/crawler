/**
 * The input of the robots.txt tester, made ready for `decide`. A reader can paste a full URL in place
 * of a path, and a full User-Agent header in place of a product token.
 */
import { productToken as tokenOf } from "polite-crawler/robots";

/**
 * This function gives the product token that robots.txt matches, as the crawler finds it
 * (`productToken` of polite-crawler), in the case that the reader wrote. `MyBot/1.0` gives `MyBot`.
 * The header `Mozilla/5.0 (compatible; MyBot/1.0; +https://example.com/bot)` also gives `MyBot`.
 */
export const productToken = (input: string): string => {
  const token = tokenOf(input);
  const at = input.toLowerCase().indexOf(token);
  return token.length > 0 && at !== -1 ? input.slice(at, at + token.length) : token;
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
