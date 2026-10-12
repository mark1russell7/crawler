/**
 * The outcome tells what a response means for the crawl. The crawler decides it before it keeps
 * the body as content. The crawler sees a refusal and stops. It does not try again with a
 * different identity.
 *
 * - `challenge`: a bot challenge page. Cloudflare marks it with `cf-mitigated: challenge`. AWS WAF
 *   answers 202 (challenge) or 405 (CAPTCHA) with an `x-amzn-waf-action` header. The host stops
 *   for 24 hours.
 * - `payment-required` (402): a site that wants payment or a license for a crawl. The crawler
 *   records the price and does not pay. The host stops for 24 hours.
 * - `blocked` (401, 403): RFC 9110 tells a client not to send the request again automatically.
 *   The host stops for 1 hour.
 * - `rate-limited` (429) and `unavailable` (502, 503, 504): the host waits until the time of
 *   Retry-After, or for a backoff with jitter. A busy gateway is a reason to wait, not a failure.
 * - `error`: a different status, or no answer. A 5xx or no answer counts toward the stop of the
 *   host. A different 4xx (a 400 or a 422) is a problem of the request, and it does not count.
 *
 * The politeness policy (`PolitenessPolicy`) sets each time of a stop.
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const LONG_DAY = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const MONTH = `(${MONTHS.join("|")})`;
const TIME = "(\\d{2}):(\\d{2}):(\\d{2})";
const IMF_FIXDATE = new RegExp(`^${DAY}, (\\d{2}) ${MONTH} (\\d{4}) ${TIME} GMT$`);
const RFC_850 = new RegExp(`^${LONG_DAY}, (\\d{2})-${MONTH}-(\\d{2}) ${TIME} GMT$`);
const ASCTIME = new RegExp(`^${DAY} ${MONTH} ( \\d|\\d{2}) ${TIME} (\\d{4})$`);

/**
 * This function reads an HTTP date in the three forms of RFC 9110 §5.6.7: the IMF-fixdate, the
 * RFC 850 form and the asctime form. It gives milliseconds since the epoch, or no value for a text
 * in a different form. It does not use `Date.parse`, which reads many texts that are not dates.
 */
export const parseHttpDate = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const text = value.trim();
  // each form gives day, month, year, hour, minute and second
  let parts: readonly string[] | undefined;
  const fixdate = IMF_FIXDATE.exec(text);
  const rfc850 = fixdate === null ? RFC_850.exec(text) : null;
  const asctime = fixdate === null && rfc850 === null ? ASCTIME.exec(text) : null;
  if (fixdate !== null) parts = fixdate.slice(1);
  else if (rfc850 !== null) {
    const short = Number(rfc850[3]);
    // RFC 9110: a two-digit year more than 50 years in the future is in the past century
    const century = 2000 + short > new Date().getUTCFullYear() + 50 ? 1900 : 2000;
    parts = [rfc850[1]!, rfc850[2]!, String(century + short), ...rfc850.slice(4)];
  } else if (asctime !== null) {
    parts = [asctime[2]!, asctime[1]!, asctime[6]!, asctime[3]!, asctime[4]!, asctime[5]!];
  }
  if (parts === undefined) return undefined;
  const [day, month, year, hour, minute, second] = parts as [string, string, string, string, string, string];
  const at = Date.UTC(
    Number(year),
    MONTHS.indexOf(month),
    Number(day.trim()),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isFinite(at) ? at : undefined;
};

/**
 * Retry-After is either delta-seconds or an HTTP date (RFC 9110 §10.2.3). The function reads only
 * these two forms. A different text, for example `1.5` or `-5`, gives no value, so the backoff
 * applies.
 */
export const parseRetryAfter = (value: string | undefined, now: number): number | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = parseHttpDate(trimmed);
  return at === undefined ? undefined : Math.max(0, at - now);
};

/** After these outcomes, the crawler does not ask the host again until the stop ends. */
export const STOPS_HOST: ReadonlySet<Outcome> = new Set([
  "challenge",
  "blocked",
  "payment-required",
]);

/**
 * This function tells if a status is a client error with no meaning for the host. Such a status
 * is a 4xx other than 401, 402, 403, 404, 408, 410 and 429. The request was wrong, and a
 * different request can succeed. Thus the failure count of the host does not change.
 */
export const isClientError = (status: number): boolean =>
  status >= 400 && status < 500 && ![401, 402, 403, 404, 408, 410, 429].includes(status);

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
