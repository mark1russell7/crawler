/**
 * This module gives the canonical form of a URL. The document id of a page and the cache key of the
 * crawler use it. Thus two spellings of one page are one document and one cached answer.
 */

const TRACKING =
  /^(utm_[a-z_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|ttclid|twclid|li_fat_id|srsltid|mc_[a-z]+|_ga|_gl|_hsenc|_hsmi|__hstc|__hssc|__hsfp|mkt_tok|ref_src|igshid)$/i;

/** This function decodes the escapes of unreserved characters (`%7E` is `~`), and writes the other escapes in capitals. */
const normalizeEscapes = (value: string): string =>
  value.replace(/%[0-9a-f]{2}/gi, (escape) => {
    const char = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return /^[A-Za-z0-9\-._~]$/.test(char) ? char : escape.toUpperCase();
  });

/**
 * This function gives one URL for each page: a lowercase host, and no fragment, tracking
 * parameters, empty query or default port. It decodes the escapes of unreserved characters.
 */
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
  // a copy of the keys, because the loop deletes from the live list
  for (const key of Array.from(url.searchParams.keys())) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname.includes("%")) url.pathname = normalizeEscapes(url.pathname);
  // "/p?" is "/p"
  url.search = url.search.includes("%") ? normalizeEscapes(url.search) : url.search;
  return url.href;
};

/**
 * This function gives the cache key of a URL: its canonical form. A text that is not a URL stays as
 * it is. The crawler and `reindex` use the same key, so a rebuilt index answers the same requests.
 */
export const cacheKeyOf = (value: string): string => {
  try {
    return canonicalUrl(value);
  } catch {
    return value;
  }
};

/**
 * This function gives the site of a host name: the name in lowercase, with no final dot and no
 * `www.` at the start. Thus `www.example.com` and `example.com` are one site.
 */
export const siteOf = (host: string): string =>
  host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");

/** These options set the hosts that a crawl or a discovery keeps. */
export interface ScopeOptions {
  /** With the default value true, the URLs on the sites of the start URLs are in scope. */
  readonly sameSite?: boolean | undefined;
  /** The URLs on these hosts are in scope too. A name that starts with `*.` names the hosts under it. */
  readonly allowHosts?: readonly string[] | undefined;
}

/**
 * This function gives the test of the scope of a crawl or a discovery. With `sameSite: false`
 * and no `allowHosts`, each http(s) URL is in scope.
 */
export const scopeTest = (
  starts: readonly URL[],
  options: ScopeOptions,
): ((url: URL) => boolean) => {
  const sameSite = options.sameSite !== false;
  const sites = new Set(starts.map((start) => siteOf(start.hostname)));
  const hosts = (options.allowHosts ?? []).map((host) =>
    host.trim().toLowerCase().replace(/\.$/, ""),
  );
  const any = !sameSite && options.allowHosts === undefined;
  return (url) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (any) return true;
    const name = url.hostname.toLowerCase().replace(/\.$/, "");
    if (sameSite && sites.has(siteOf(name))) return true;
    return hosts.some((host) =>
      host.startsWith("*.") ? name.endsWith(host.slice(1)) : name === host,
    );
  };
};
