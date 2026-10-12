/**
 * The outcome tells what a response means for the crawl. The crawler decides it before it keeps
 * the body as content. The crawler sees a refusal and stops. It does not try again with a
 * different identity.
 *
 * - `challenge`: a bot challenge page. Cloudflare marks it with `cf-mitigated: challenge`. AWS WAF
 *   answers 202 (challenge) or 405 (CAPTCHA) with an `x-amzn-waf-action` header. The host stops
 *   for the run.
 * - `payment-required` (402): a site that wants payment or a license for a crawl. The crawler
 *   records the price and does not pay.
 * - `blocked` (401, 403): RFC 9110 tells a client not to send the request again automatically.
 *   The host stops for the run.
 * - `rate-limited` (429) and `unavailable` (502, 503, 504): the host waits until the time of
 *   Retry-After, or for a backoff with jitter. A busy gateway is a reason to wait, not a failure.
 */

export type Outcome =
  | "ok"
  | "not-modified"
  | "redirect"
  | "challenge"
  | "payment-required"
  | "blocked"
  | "not-found"
  | "rate-limited"
  | "unavailable"
  | "error";

export interface Classified {
  readonly outcome: Outcome;
  /** This value is the wait that the server asked for, when it asked for one. */
  readonly retryAfterMs: number | undefined;
  readonly note: string | undefined;
}

/** Retry-After is either delta-seconds or an HTTP date (RFC 9110 §10.2.3) */
export const parseRetryAfter = (value: string | undefined, now: number): number | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
};

/** outcomes after which the host is not asked again during this run */
export const STOPS_HOST: ReadonlySet<Outcome> = new Set([
  "challenge",
  "blocked",
  "payment-required",
]);

export const classify = (
  status: number,
  header: (name: string) => string | undefined,
  now: number,
): Classified => {
  const retryAfterMs = parseRetryAfter(header("retry-after"), now);
  const result = (outcome: Outcome, note?: string): Classified => ({
    outcome,
    retryAfterMs,
    note,
  });
  if (header("cf-mitigated")?.trim().toLowerCase() === "challenge") {
    return result("challenge", "Cloudflare challenge");
  }
  const waf = header("x-amzn-waf-action")?.trim().toLowerCase();
  if (
    waf !== undefined &&
    (waf === "challenge" || waf === "captcha" || status === 202 || status === 405)
  ) {
    return result("challenge", `AWS WAF ${waf}`);
  }
  if (status === 304) return result("not-modified");
  if (status >= 200 && status < 300) return result("ok");
  if (status >= 300 && status < 400) return result("redirect");
  if (status === 402) {
    const price = header("crawler-price");
    return result("payment-required", price === undefined ? undefined : `price ${price}`);
  }
  if (status === 401 || status === 403) return result("blocked");
  if (status === 404 || status === 410) return result("not-found");
  if (status === 429) return result("rate-limited");
  if (status === 502 || status === 503 || status === 504) return result("unavailable");
  return result("error", status === 0 ? "no response" : `status ${String(status)}`);
};
