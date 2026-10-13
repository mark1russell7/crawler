/**
 * "What does this response mean?" It classifies a status and headers with `classify`, the function
 * that the crawler applies to each response, and tells what the crawler does next.
 */
import { useState, type ReactElement } from "react";
import type { Outcome } from "polite-crawler/classify";
import { STOPS_HOST, classify } from "polite-crawler/classify";
import { DEFAULT_POLICY } from "polite-crawler/politeness";
import { afterRetry } from "../lib/response.ts";

const EXAMPLES: ReadonlyArray<{ readonly name: string; readonly status: string; readonly headers: string }> = [
  { name: "200", status: "200", headers: "content-type: text/html" },
  { name: "304 Not Modified", status: "304", headers: 'etag: "a1b2"' },
  { name: "429 with Retry-After", status: "429", headers: "retry-after: 120" },
  { name: "503 with a date", status: "503", headers: "retry-after: Wed, 21 Oct 2026 07:28:00 GMT" },
  { name: "429, wait of two days", status: "429", headers: "retry-after: 172800" },
  { name: "403", status: "403", headers: "" },
  { name: "Cloudflare challenge", status: "403", headers: "cf-mitigated: challenge" },
  { name: "AWS WAF", status: "202", headers: "x-amzn-waf-action: challenge" },
  { name: "402 Payment Required", status: "402", headers: "crawler-price: USD 0.01" },
];

/** The time of a stop in hours, from the policy of the package: "1 hour", "24 hours". */
const hours = (ms: number): string => {
  const count = ms / 3_600_000;
  return `${String(count)} ${count === 1 ? "hour" : "hours"}`;
};

const STOP_FOR: Readonly<Partial<Record<Outcome, string>>> = {
  challenge: hours(DEFAULT_POLICY.challengeStopMs),
  "payment-required": hours(DEFAULT_POLICY.paymentStopMs),
  blocked: hours(DEFAULT_POLICY.blockedStopMs),
};

const NEXT: Readonly<Record<Outcome, string>> = {
  ok: "It keeps the body, reads it and rests before the next request to the host.",
  "not-modified": "The stored copy is still correct. It reads the stored body again and downloads nothing.",
  redirect: "It follows the redirect, for a maximum of five steps. Each step is a separate decision.",
  challenge: `A bot challenge. It stops the host for ${STOP_FOR.challenge!} and does not try a different identity.`,
  "payment-required": `The site wants payment or a license. It records the price, pays nothing and stops the host for ${STOP_FOR["payment-required"]!}.`,
  blocked: `A refusal. RFC 9110 tells a client not to send the request again, so it stops the host for ${STOP_FOR.blocked!}.`,
  "not-found": "The page is not there. It records the result and continues with the next page.",
  "rate-limited": "The site limits the rate. The host waits until Retry-After, or for a backoff with jitter.",
  unavailable: "The server is busy or down. The host waits until Retry-After, or for a backoff with jitter.",
  error: `An unknown failure. The host waits for a backoff, and ${String(DEFAULT_POLICY.maxFailures)} failures in sequence stop it for ${hours(DEFAULT_POLICY.failureStopMs)}.`,
};

/** The classifier. */
export default function ResponseClassifier(): ReactElement {
  const [status, setStatus] = useState(EXAMPLES[2]!.status);
  const [headers, setHeaders] = useState(EXAMPLES[2]!.headers);
  const map = new Map<string, string>();
  for (const line of headers.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) map.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const code = Number(status);
  const now = Date.parse("2026-10-21T07:00:00Z");
  const result = Number.isInteger(code) ? classify(code, (name) => map.get(name.toLowerCase()), now) : undefined;
  // a Retry-After of more than 1 hour stops the host, as a refusal does
  const retry = afterRetry(result?.retryAfterMs);
  const stops = result !== undefined && (STOPS_HOST.has(result.outcome) || retry.kind === "stop");
  return (
    <div className="pc-tool not-content">
      <div className="pc-presets" role="group" aria-label="Examples">
        {EXAMPLES.map((example) => (
          <button
            key={example.name}
            type="button"
            className="pc-chip"
            aria-pressed={status === example.status && headers === example.headers}
            onClick={() => {
              setStatus(example.status);
              setHeaders(example.headers);
            }}
          >
            {example.name}
          </button>
        ))}
      </div>
      <div className="pc-tool-grid">
        <div className="pc-tool-side">
          <label className="pc-field">
            <span>Status</span>
            <input value={status} inputMode="numeric" onChange={(event) => setStatus(event.currentTarget.value)} />
          </label>
          <label className="pc-field">
            <span>Headers, one on each line</span>
            <textarea value={headers} rows={4} spellcheck={false} onChange={(event) => setHeaders(event.currentTarget.value)} />
          </label>
        </div>
        <div className="pc-tool-side" aria-live="polite">
          {result === undefined ? (
            <p className="pc-empty">Write a status code, for example 429.</p>
          ) : (
            <>
              <div className={`pc-callout ${stops ? "pc-callout-stop" : result.outcome === "ok" || result.outcome === "not-modified" ? "pc-callout-ok" : "pc-callout-warn"}`}>
                <strong>
                  <code>{result.outcome}</code>
                  {STOPS_HOST.has(result.outcome) ? `: the host stops for ${STOP_FOR[result.outcome] ?? "a time"}` : retry.kind === "stop" ? ": the host stops" : ""}
                </strong>
                <span>{NEXT[result.outcome]}</span>
              </div>
              <dl className="pc-facts">
                <div>
                  <dt>{retry.label}</dt>
                  <dd>{retry.text}</dd>
                </div>
                <div>
                  <dt>Note</dt>
                  <dd>{result.note ?? "none"}</dd>
                </div>
              </dl>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
