/**
 * The freshness of an HTTP response, as RFC 9111 §4.2 calculates it. The crawler uses it for the
 * end of the freshness of each capture. `polite-crawler/api` gives `freshUntil` to API clients. The
 * module imports no Node.js module.
 */
import { parseHttpDate } from "./classify.ts";

/** These redirect statuses are permanent. A cache can keep them with no explicit freshness. */
export const PERMANENT_REDIRECTS: ReadonlySet<number> = new Set([301, 308]);

/** A response with one of these statuses can get a heuristic freshness (RFC 9110 §15.1). */
const HEURISTIC_STATUSES: ReadonlySet<number> = new Set([
  200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501,
]);

/** This value is the maximum freshness lifetime of a response: ten years. */
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const DIGITS = /^\d+$/;

/** This function gives the directives of a `Cache-Control` header. Each name is in lowercase. */
const directives = (value: string | undefined): Map<string, string> => {
  const out = new Map<string, string>();
  for (const part of (value ?? "").split(",")) {
    const equals = part.indexOf("=");
    const name = (equals === -1 ? part : part.slice(0, equals)).trim().toLowerCase();
    if (name.length === 0) continue;
    const raw = equals === -1 ? "" : part.slice(equals + 1).trim();
    out.set(
      name,
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw,
    );
  }
  return out;
};

/**
 * This function gives the end of the freshness of an HTTP response, as RFC 9111 §4.2 calculates
 * it. A client that keeps the answers of `poll` and `send` asks again at that time.
 *
 * The sources in sequence are `max-age` of `Cache-Control`, `Expires` minus `Date`, and 10
 * percent of the age of `Last-Modified`. Only a heuristic status (RFC 9110 §15.1) uses the last
 * source, and `capMs` is its maximum. A permanent redirect with no `Last-Modified` gets `capMs`.
 * The function subtracts the `Age` of the response. Ten years is the maximum lifetime.
 *
 * A response with `no-store` or `no-cache` is stale at once, so the function gives `fetchedAt`.
 * An `Expires` that is not a date also gives `fetchedAt`.
 *
 * For a `Reply`, a call is
 * `freshUntil((name) => reply.headers[name], reply.status, fetchedAt, reply.headers["last-modified"], capMs)`.
 *
 * @param header - This function gives the value of one header. Each name is in lowercase.
 * @param status - This value is the status of the response.
 * @param fetchedAt - This value is the time of the response, in milliseconds since the epoch.
 * @param lastModified - This value is the `Last-Modified` header of the response, or undefined.
 * @param capMs - This value is the maximum of the heuristic freshness, in milliseconds.
 * @returns the end of the freshness in milliseconds since the epoch, or undefined when the
 * response has no freshness.
 * @beta
 */
export function freshUntil(
  header: (name: string) => string | undefined,
  status: number,
  fetchedAt: number,
  lastModified: string | undefined,
  capMs: number,
): number | undefined {
  const control = directives(header("cache-control"));
  if (control.has("no-store") || control.has("no-cache")) return fetchedAt;
  const ageText = header("age")?.trim() ?? "";
  const age = DIGITS.test(ageText) ? Number(ageText) * 1000 : 0;
  const date = parseHttpDate(header("date")) ?? fetchedAt;
  let lifetime: number | undefined;
  const maxAge = control.get("max-age");
  const expires = header("expires");
  if (maxAge !== undefined && DIGITS.test(maxAge)) lifetime = Number(maxAge) * 1000;
  else if (expires !== undefined) {
    // an Expires that is not a date means that the response is already stale
    const at = parseHttpDate(expires);
    lifetime = at === undefined ? 0 : at - date;
  } else if (HEURISTIC_STATUSES.has(status)) {
    const modified = parseHttpDate(lastModified);
    if (modified !== undefined && modified < date)
      lifetime = Math.min(capMs, (date - modified) / 10);
    else if (PERMANENT_REDIRECTS.has(status)) lifetime = capMs;
  }
  if (lifetime === undefined) return undefined;
  return fetchedAt + Math.max(0, Math.min(lifetime, TEN_YEARS_MS) - age);
}
