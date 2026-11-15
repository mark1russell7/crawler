/**
 * The polite send of a documented API. It keeps the pace of each host with the scheduler of the
 * crawler (`HostScheduler`). As for the `Crawler`, `reactToOutcome` gives its reaction to each
 * answer. The send stores no page, because the terms of some APIs forbid a store.
 *
 * The transport is a port: a host gives `fetch` or a different HTTP client, and a test gives a fake.
 * The module imports no Node.js module, and it uses no type of a platform except the signal.
 *
 * The module also has the OAuth 2.0 client credentials grant (RFC 6749, section 4.4): `readGrant`,
 * `tokenStore` and `sendWithToken`. `fetchTransport` is a transport over `fetch` with a User-Agent
 * and a time limit. `poll` sends conditional requests. Each export is beta: a minor version can
 * change it.
 */
import { ApiError } from "./api-error.ts";
import type { Classified } from "./classify.ts";
import { classify } from "./classify.ts";
import type { HostStateStore, Paced, PolicyOptions, ValidatorAnswer } from "./politeness.ts";
import { policyFor, restAfter, validatorsToSend } from "./politeness.ts";
import type { OutcomeFacts } from "./reaction.ts";
import { outcomeResult, reactToOutcome } from "./reaction.ts";
import { QuotaError } from "./quota.ts";

export { ApiError } from "./api-error.ts";
export type { Classified, Outcome } from "./classify.ts";
export type {
  HostCounts,
  HostResult,
  HostStateStore,
  HostStop,
  Paced,
  PolicyOptions,
  PolitenessPolicy,
  ValidatorAnswer,
  ValidatorMemo,
  ValidatorReport,
  ValidatorVerdict,
} from "./politeness.ts";
export type { HostReaction, OutcomeFacts, ReactionContext } from "./reaction.ts";
export { outcomeResult, reactToOutcome } from "./reaction.ts";
export type {
  Quota,
  QuotaGate,
  QuotaGateOptions,
  QuotaHeaders,
  QuotaReading,
  QuotaRecord,
  QuotaState,
  QuotaStore,
  QuotaWindow,
  WithQuotaOptions,
} from "./quota.ts";
export { memoryQuotaStore, QuotaError, quotaGate, readQuotaHeaders, withQuota } from "./quota.ts";

/**
 * One request of a client to an API.
 *
 * @beta
 */
export interface Exchange {
  /** This value is the method of the request, for example `GET` or `POST`. */
  readonly method: string;
  readonly url: string;
  /** These are the headers of the request. Each name is in lowercase. */
  readonly headers: Readonly<Record<string, string>>;
  /** This value is the body of the request, or null. */
  readonly body: string | null;
}

/**
 * The answer of an API to one exchange.
 *
 * @beta
 */
export interface Reply {
  readonly status: number;
  /** This value is the reason phrase of the status line. HTTP/2 has no reason phrase, so it can be empty. */
  readonly statusText: string;
  /** These are the headers of the answer. Each name is in lowercase. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The part of a signal that the send reads. An `AbortSignal` has it.
 *
 * @beta
 */
export interface Signal {
  readonly aborted: boolean;
}

/**
 * A transport sends one exchange and gives the answer. It does not follow a redirect. It throws an
 * error when the API gives no answer, and when the signal stops the request.
 *
 * @beta
 */
export type Transport<S extends Signal = AbortSignal> = (
  exchange: Exchange,
  signal: S | undefined,
) => Promise<Reply>;

/**
 * The part of a `HostScheduler` that the send uses. A `HostScheduler` has each member.
 *
 * @beta
 */
export interface ApiScheduler<S extends Signal = AbortSignal> {
  run<T>(host: string, task: () => Promise<Paced<T>>, signal?: S): Promise<T>;
  /**
   * This store keeps the counts and the stops of each host. When it has the validator memo
   * (`validators` and `noteValidators`), `poll` uses it as the crawler does. The two members are optional, as in
   * `HostStateStore`, so a store of `record` and `stop` is sufficient.
   */
  readonly store: Pick<HostStateStore, "record" | "stop" | "validators" | "noteValidators">;
}

/**
 * The pace of the API clients of one process. Give one pace to each client, so each host keeps one pace.
 *
 * @beta
 */
export interface Pace<S extends Signal = AbortSignal> {
  /** This scheduler keeps one request in progress for each host. Give the scheduler of the crawler to share its pace. */
  readonly scheduler: ApiScheduler<S>;
  /** This function gives the time in milliseconds since the epoch. Give the clock of the scheduler. */
  readonly now: () => number;
  /** This value is the politeness policy. The default is `DEFAULT_POLICY`. */
  readonly policy?: PolicyOptions | undefined;
  /** This function gives a number in [0, 1) for the jitter of a backoff. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
}

/**
 * This function removes each secret from the text of an error. `secrets` holds the secrets of the
 * exchange: its keys and its token.
 *
 * @beta
 */
export type Redact = (text: string, secrets: readonly string[]) => string;


/**
 * One exchange of a client, and its context for the pace and the messages.
 *
 * @beta
 */
export interface Send {
  /** This value is the name of the API in a message, for example `Example API`. */
  readonly source: string;
  /** This value is the host of the URL. The scheduler keeps one pace for each host. */
  readonly host: string;
  /** This value is the documented pace of the API: the shortest time between two requests. The default is `apiIntervalMs` of the policy. */
  readonly minIntervalMs?: number | undefined;
  /** This value tells what the exchange asks for, in a message, for example `the product P-1`. */
  readonly what: string;
  readonly exchange: Exchange;
  /** These are the secrets of the exchange. The send gives them to `redact`. */
  readonly secrets?: readonly string[] | undefined;
  /**
   * This function removes the secrets from the text of each error. The default changes nothing.
   * Give a function that removes each form of a secret, for example `redactSecrets` of `@mark1russell7/text`.
   */
  readonly redact?: Redact | undefined;
  /** With true, a 401 does not stop the host. The client then gets a new token one time. */
  readonly tokenRetry?: boolean | undefined;
}

/**
 * An answer, and what it means for the host.
 *
 * @beta
 */
export interface Answer {
  readonly reply: Reply;
  readonly classified: Classified;
}

const unchanged: Redact = (text) => text;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * This function gives the status line of an answer for a message, with no control character.
 *
 * @beta
 */
export function statusLine(reply: Reply): string {
  const reason = reply.statusText
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 80);
  return reason === "" ? String(reply.status) : `${String(reply.status)} ${reason}`;
}

/**
 * This function sends one exchange at the pace of its host. The scheduler waits the rest of the
 * host first. After the answer, `reactToOutcome` sets the rest of the host and its stops, as for
 * the `Crawler`:
 *
 * - A 429, 502, 503 or 504 parks the host for its `Retry-After`, or for a backoff with jitter.
 * - A 401 or a 403 stops the host for 1 hour. A 402 and a bot challenge stop it for 24 hours.
 * - An error 5xx and an exchange with no answer are failures. After 5 failures in sequence, the host stops.
 * - A `QuotaError` of the transport (`withQuota`) does not change the host.
 *
 * The function gives each answer, with each status. The caller reads the status.
 *
 * @throws ApiError when the API gives no answer, or when the host is stopped. `redact` examined the message.
 * @throws QuotaError of the transport, as it is, when a quota refuses the exchange.
 * @throws the reason of the signal, when the signal stops the exchange.
 * @beta
 */
export async function send<S extends Signal = AbortSignal>(
  pace: Pace<S>,
  transport: Transport<S>,
  input: Send,
  signal?: S,
): Promise<Answer> {
  const { scheduler } = pace;
  const { host } = input;
  const policy = policyFor(pace.policy, host);
  const random = pace.random ?? Math.random;
  const redact = (text: string): string => (input.redact ?? unchanged)(text, input.secrets ?? []);
  const spare = input.tokenRetry === true ? [401] : undefined;
  // the reaction of the host, inside the slot of the request, as the crawler does it
  const settle = (facts: OutcomeFacts, elapsedMs: number): number => {
    const now = pace.now();
    const restMs = restAfter(policy, {
      kind: "api",
      elapsedMs,
      minIntervalMs: input.minIntervalMs,
    }).ms;
    const counts = scheduler.store.record(host, outcomeResult(facts));
    const reaction = reactToOutcome(facts, counts, { policy, now, restMs, random });
    if (reaction.stop !== undefined)
      scheduler.store.stop(host, reaction.stop.until, reaction.stop.reason);
    return reaction.restMs;
  };
  let attempt: Answer | { readonly error: unknown };
  try {
    attempt = await scheduler.run<Answer | { readonly error: unknown }>(
      host,
      async () => {
        const started = pace.now();
        let reply: Reply;
        try {
          reply = await transport(input.exchange, signal);
        } catch (error) {
          // a quota refused the exchange before it started, so the host keeps its state and its pace
          if (error instanceof QuotaError) return { value: { error }, delayMs: 0 };
          // a request that the caller stopped is no fault of the host
          const cancelled = signal?.aborted === true;
          const facts: OutcomeFacts = {
            outcome: "error",
            status: 0,
            ...(cancelled ? { result: "neutral" as const } : {}),
          };
          return { value: { error }, delayMs: settle(facts, pace.now() - started) };
        }
        const classified = classify(
          reply.status,
          (name) => reply.headers[name.toLowerCase()],
          pace.now(),
        );
        const facts: OutcomeFacts = {
          outcome: classified.outcome,
          status: reply.status,
          retryAfterMs: classified.retryAfterMs,
          spare,
        };
        return { value: { reply, classified }, delayMs: settle(facts, pace.now() - started) };
      },
      signal,
    );
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new ApiError(
      redact(`The client of ${input.source} did not send ${input.what}: ${messageOf(error)}`),
    );
  }
  if ("error" in attempt) {
    if (signal?.aborted === true || attempt.error instanceof QuotaError) throw attempt.error;
    throw new ApiError(
      redact(`${input.source} gave no answer to ${input.what}: ${messageOf(attempt.error)}`),
    );
  }
  return attempt;
}

/**
 * The token of a client credentials grant, and the time when the client stops its use.
 *
 * @beta
 */
export interface Grant {
  readonly token: string;
  /** The client uses the token before this time, in milliseconds since the epoch. */
  readonly until: number;
}

/**
 * A client stops the use of a token this time before its end.
 *
 * @beta
 */
export const TOKEN_MARGIN_MS: number = 60_000;

/** A token is printable ASCII with no space, from 8 to 4096 characters, so it goes into a header. */
const TOKEN = /^[!-~]{8,4096}$/;

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

/**
 * This function reads the answer of a token endpoint of the OAuth 2.0 client credentials grant
 * (RFC 6749, section 4.4). The client uses the token until `TOKEN_MARGIN_MS` before its end, or
 * for half of a short life.
 *
 * @throws ApiError when the answer is not a 2xx with an `access_token` and an `expires_in`. The
 * message has no part of the body, and `redact` examined it.
 * @beta
 */
export function readGrant(
  reply: Reply,
  source: string,
  issuedAt: number,
  secrets: readonly string[] = [],
  redact: Redact = unchanged,
): Grant {
  if (reply.status < 200 || reply.status > 299) {
    throw new ApiError(redact(`${source} refused the token: ${statusLine(reply)}.`, secrets));
  }
  let body: unknown;
  try {
    body = JSON.parse(reply.body);
  } catch {
    throw new ApiError(`The token answer of ${source} is not JSON.`);
  }
  const token = fieldOf(body, "access_token");
  const expiresIn = fieldOf(body, "expires_in");
  if (typeof token !== "string" || !TOKEN.test(token)) {
    throw new ApiError(`The token answer of ${source} has no valid access_token.`);
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new ApiError(`The token answer of ${source} has no valid expires_in.`);
  }
  const lifeMs = expiresIn * 1000;
  return {
    token,
    until: issuedAt + (lifeMs > 2 * TOKEN_MARGIN_MS ? lifeMs - TOKEN_MARGIN_MS : lifeMs / 2),
  };
}

/**
 * A store of one token. The exchanges that wait for a token at one time share one grant.
 *
 * @beta
 */
export interface Tokens<S extends Signal = AbortSignal> {
  /** This method gives a token that the client can use. With no such token, it gets a new token. */
  get(signal?: S): Promise<string>;
  /**
   * This method forgets the token after an answer 401. With a token, it forgets only that token,
   * so a second 401 of an old token does not drop a newer token.
   */
  drop(token?: string): void;
}

/**
 * This function makes a store of one token. The store gets a new token from `grant` when the token
 * ends. `now` gives the time in milliseconds since the epoch.
 *
 * @beta
 */
export function tokenStore<S extends Signal = AbortSignal>(
  grant: (signal: S | undefined) => Promise<Grant>,
  now: () => number,
): Tokens<S> {
  let held: Grant | undefined;
  let pending: Promise<Grant> | undefined;
  return {
    async get(signal) {
      if (held !== undefined && now() < held.until) return held.token;
      pending ??= grant(signal).finally(() => {
        pending = undefined;
      });
      const next = await pending;
      held = next;
      return next.token;
    },
    drop(token) {
      if (token === undefined || held?.token === token) held = undefined;
    },
  };
}

/**
 * This function sends an exchange with a token. `headers` gives the headers of the token, for
 * example `authorization`. After an answer 401, the function forgets the token, gets a new token,
 * and sends the exchange one more time. A second 401 stops the host. The token goes into the
 * secrets of the messages.
 *
 * @throws ApiError as `send` does, and the error of the grant.
 * @beta
 */
export async function sendWithToken<S extends Signal = AbortSignal>(
  pace: Pace<S>,
  transport: Transport<S>,
  tokens: Tokens<S>,
  input: Send,
  headers: (token: string) => Readonly<Record<string, string>>,
  signal?: S,
): Promise<Answer> {
  const once = async (tokenRetry: boolean): Promise<{ answer: Answer; token: string }> => {
    const token = await tokens.get(signal);
    const exchange = {
      ...input.exchange,
      headers: { ...input.exchange.headers, ...headers(token) },
    };
    const secrets = [...(input.secrets ?? []), token];
    const answer = await send(pace, transport, { ...input, exchange, secrets, tokenRetry }, signal);
    return { answer, token };
  };
  const first = await once(true);
  if (first.answer.reply.status !== 401) return first.answer;
  tokens.drop(first.token);
  return (await once(false)).answer;
}

/**
 * The part of a `fetch` function that `fetchTransport` uses. The `fetch` of Node.js and of a
 * browser has it.
 *
 * @beta
 */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly redirect: "manual";
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  readonly statusText: string;
  readonly headers: { forEach(callback: (value: string, name: string) => void): void };
  text(): Promise<string>;
}>;

/**
 * The default time limit of `fetchTransport`: 30 seconds for the request and its body.
 *
 * @beta
 */
export const API_TIMEOUT_MS: number = 30_000;

/**
 * The options of `fetchTransport`.
 *
 * @beta
 */
export interface FetchTransportOptions {
  /**
   * This value names the client and a contact, for example `example-app/1.0 (ops@example.com)`.
   * Each request sends it, except a request with its own `user-agent` header. Some APIs, for
   * example `api.weather.gov`, refuse a request with no User-Agent.
   */
  readonly userAgent: string;
  /** This value is the time limit of one request and its body, in milliseconds. The default is `API_TIMEOUT_MS`. */
  readonly timeoutMs?: number | undefined;
  /** This function sends the request. The default is the global `fetch`. */
  readonly fetch?: FetchLike | undefined;
}

/** A User-Agent is printable ASCII, from 1 to 512 characters, with no space at an end. */
const USER_AGENT = /^[!-~](?:[ -~]{0,510}[!-~])?$/;

/**
 * This function makes a transport over `fetch`. The transport sends the User-Agent, does not
 * follow a redirect, and stops a request after the time limit. A request that the time limit
 * stopped throws an error, and `send` counts it as a failure of the host. A request that the
 * signal stopped throws the reason of the signal.
 *
 * @throws ApiError when the User-Agent is not printable ASCII, or when the time limit is not a positive number.
 * @beta
 */
export function fetchTransport(options: FetchTransportOptions): Transport {
  const { userAgent } = options;
  if (!USER_AGENT.test(userAgent)) {
    throw new ApiError(
      "The transport needs a User-Agent of 1 to 512 printable ASCII characters, with no space at an end.",
    );
  }
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ApiError(
      `The time limit of the transport is not a positive number: ${String(timeoutMs)}.`,
    );
  }
  const fetchOf: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return async (exchange, signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const both = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const headers: Record<string, string> = { "user-agent": userAgent, ...exchange.headers };
    try {
      const response = await fetchOf(exchange.url, {
        method: exchange.method,
        headers,
        ...(exchange.body === null ? {} : { body: exchange.body }),
        redirect: "manual",
        signal: both,
      });
      // the time limit also stops a body that does not end
      const body = await response.text();
      const replyHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        replyHeaders[name.toLowerCase()] = value;
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: replyHeaders,
        body,
      };
    } catch (error) {
      if (timeout.aborted && signal?.aborted !== true) {
        throw new Error(`no answer in ${String(Math.ceil(timeoutMs / 1000))} s`, { cause: error });
      }
      throw error;
    }
  };
}

/**
 * What a poll keeps of the last answer 2xx of one URL.
 *
 * @beta
 */
export interface Condition {
  /** This value is the `ETag` header of the answer, when it had one. */
  readonly etag?: string | undefined;
  /** This value is the `Last-Modified` header of the answer, when it had one. */
  readonly lastModified?: string | undefined;
  /** This value is the SHA-256 of the body, in hexadecimal. */
  readonly digest: string;
}

/**
 * A store of the conditions of a poll, one for each URL. A `Map` is a store in memory. One store
 * goes with one set of request headers: give a second store to a second `accept` header.
 *
 * @beta
 */
export interface Conditions {
  get(url: string): Condition | undefined;
  set(url: string, condition: Condition): void;
}

/**
 * An answer of a poll.
 *
 * @beta
 */
export interface Polled extends Answer {
  /**
   * This value is true for an answer 2xx with a body that is not the body of the last answer 2xx
   * of the URL. It is false for a 304, for the same body, and for each other status.
   */
  readonly changed: boolean;
}

const HEX = "0123456789abcdef";

/** This function gives the SHA-256 of a text, in hexadecimal. */
const digestOf = async (text: string): Promise<string> => {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  let hex = "";
  for (const byte of bytes) hex += (HEX[byte >> 4] ?? "") + (HEX[byte & 15] ?? "");
  return hex;
};

/**
 * This function sends one conditional GET at the pace of its host, as `send` does. It sends the
 * validators of the last answer 2xx of the URL: `If-None-Match` with its ETag and
 * `If-Modified-Since` with its date. The store of the scheduler can have a validator memo. Then
 * the function sends only the date to a host whose ETags do not match, as the crawler does.
 *
 * A 304 gives no body: the caller keeps the result of the last changed body. A server that does
 * not answer 304 can send the same body again. The function then gives `changed: false` too.
 *
 * @throws ApiError as `send` does, and when the method is not GET.
 * @throws the reason of the signal, when the signal stops the exchange.
 * @beta
 */
export async function poll<S extends Signal = AbortSignal>(
  pace: Pace<S>,
  transport: Transport<S>,
  conditions: Conditions,
  input: Send,
  signal?: S,
): Promise<Polled> {
  const { exchange, host } = input;
  if (exchange.method.toUpperCase() !== "GET") {
    throw new ApiError(`A poll sends only GET, not ${exchange.method}.`);
  }
  const { store } = pace.scheduler;
  const last = conditions.get(exchange.url);
  const which = validatorsToSend(
    store.validators?.(host),
    { etag: last?.etag !== undefined, lastModified: last?.lastModified !== undefined },
    pace.now(),
  );
  const headers: Record<string, string> = { ...exchange.headers };
  if (which.etag && last?.etag !== undefined) headers["if-none-match"] = last.etag;
  if (which.lastModified && last?.lastModified !== undefined)
    headers["if-modified-since"] = last.lastModified;
  const answer = await send(
    pace,
    transport,
    { ...input, exchange: { ...exchange, headers } },
    signal,
  );
  const { reply } = answer;
  let verdict: ValidatorAnswer | undefined;
  let changed = false;
  if (reply.status === 304) verdict = "not-modified";
  else if (reply.status >= 200 && reply.status <= 299) {
    const digest = await digestOf(reply.body);
    changed = last?.digest !== digest;
    verdict = changed ? "changed" : "same";
    conditions.set(exchange.url, {
      etag: reply.headers["etag"],
      lastModified: reply.headers["last-modified"],
      digest,
    });
  }
  const report = {
    etag: headers["if-none-match"] !== undefined,
    lastModified: headers["if-modified-since"] !== undefined,
  };
  if (verdict !== undefined && (report.etag || report.lastModified))
    store.noteValidators?.(host, { ...report, answer: verdict }, pace.now());
  return { ...answer, changed };
}
