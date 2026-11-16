import { describe, expect, it } from "vitest";
import {
  API_TIMEOUT_MS,
  ApiError,
  TOKEN_MARGIN_MS,
  fetchTransport,
  poll,
  readGrant,
  send,
  sendWithToken,
  statusLine,
  tokenStore,
  type ApiScheduler,
  type Condition,
  type Exchange,
  type FetchLike,
  type Grant,
  type Pace,
  type Redact,
  type Reply,
  type Send,
  type Tokens,
  type Transport,
} from "./api.ts";
import { HostScheduler, VALIDATOR_MEMO, type Clock } from "./politeness.ts";
import { fakeClock } from "./test-helpers.ts";

const SECRET = "s3cr3t-Value_9";
const MARK = "[secret]";
const HOST = "api.example.com";

/** A redact function for the tests: it puts the mark in the place of each raw secret. */
const mark: Redact = (text, secrets) =>
  secrets.reduce((out, secret) => (secret === "" ? out : out.split(secret).join(MARK)), text);

/** A pace on a real scheduler with a fake clock. The jitter is always the middle value. */
const fakePace = (): { pace: Pace; clock: Clock; scheduler: HostScheduler } => {
  const clock = fakeClock();
  const scheduler = new HostScheduler(clock, 4);
  return { pace: { scheduler, now: clock.now, random: () => 0.5 }, clock, scheduler };
};

const reply = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  statusText = "",
): Reply => ({
  status,
  statusText,
  headers,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

interface Sent {
  readonly exchange: Exchange;
  readonly at: number;
}

/** A transport that records each exchange with its time. The handler gives the answer, or an error to throw. */
const fakeTransport = (
  clock: Clock,
  handler: (exchange: Exchange, index: number) => Reply | Error,
): { transport: Transport; sent: Sent[] } => {
  const sent: Sent[] = [];
  const transport: Transport = (exchange, signal) => {
    sent.push({ exchange, at: clock.now() });
    if (signal?.aborted === true) return Promise.reject(signal.reason as Error);
    const answer = handler(exchange, sent.length - 1);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { transport, sent };
};

/** This function gives the error of a promise that rejects with an error. */
const failure = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`The promise rejected with a value that is not an error: ${String(error)}`);
  }
  throw new Error("The promise did not reject.");
};

const input = (changes: Partial<Send> = {}): Send => ({
  source: "Example",
  host: HOST,
  minIntervalMs: 500,
  what: "the thing",
  exchange: { method: "GET", url: `https://${HOST}/thing`, headers: {}, body: null },
  secrets: [SECRET],
  redact: mark,
  ...changes,
});

describe("statusLine", () => {
  it("gives the status and the reason phrase with no control character", () => {
    expect(statusLine(reply(404, "", {}, "Not Found"))).toBe("404 Not Found");
    expect(statusLine(reply(404, ""))).toBe("404");
    expect(statusLine(reply(400, "", {}, "Bad\r\nInjected: yes"))).toBe("400 Bad  Injected: yes");
  });
});

describe("send", () => {
  it("keeps the pace of the source between two exchanges to one host", async () => {
    const { pace, clock } = fakePace();
    const { transport, sent } = fakeTransport(clock, () => reply(200, {}));
    await send(pace, transport, input());
    await send(pace, transport, input());
    expect(sent[1]!.at - sent[0]!.at).toBe(500);
  });

  it("keeps the API interval of the policy when the source has no documented pace", async () => {
    const { pace, clock } = fakePace();
    const { transport, sent } = fakeTransport(clock, () => reply(200, {}));
    await send(pace, transport, input({ minIntervalMs: undefined }));
    await send(pace, transport, input({ minIntervalMs: undefined }));
    expect(sent[1]!.at - sent[0]!.at).toBe(1000);
  });

  it("sends the method, the headers and the body of the exchange as they are", async () => {
    const { pace, clock } = fakePace();
    const { transport, sent } = fakeTransport(clock, () => reply(200, {}));
    const exchange: Exchange = {
      method: "POST",
      url: `https://${HOST}/oauth/token`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    };
    await send(pace, transport, input({ exchange }));
    expect(sent[0]!.exchange).toEqual(exchange);
  });

  it("waits the Retry-After of a 429 before the next exchange, and gives the 429", async () => {
    const { pace, clock } = fakePace();
    const { transport, sent } = fakeTransport(clock, (_, index) =>
      index === 0 ? reply(429, {}, { "retry-after": "30" }) : reply(200, {}),
    );
    const first = await send(pace, transport, input());
    expect(first.reply.status).toBe(429);
    expect(first.classified.outcome).toBe("rate-limited");
    await send(pace, transport, input());
    expect(sent[1]!.at - sent[0]!.at).toBe(30_000);
  });

  it("parks the host for a backoff after a 503 with no Retry-After, and after an error 500", async () => {
    for (const status of [503, 500]) {
      const { pace, clock } = fakePace();
      const { transport, sent } = fakeTransport(clock, (_, index) =>
        reply(index === 0 ? status : 200, {}),
      );
      await send(pace, transport, input());
      await send(pace, transport, input());
      // the first step of the backoff is 5 s: half of it, and half of the rest at random 0.5
      expect(sent[1]!.at - sent[0]!.at).toBe(3750);
    }
  });

  it("stops the host for a Retry-After longer than 1 hour", async () => {
    const { pace, clock, scheduler } = fakePace();
    const { transport, sent } = fakeTransport(clock, () =>
      reply(503, {}, { "retry-after": "7200" }),
    );
    await send(pace, transport, input());
    expect(scheduler.stopOf(HOST)).toEqual({
      until: clock.now() + 7_200_000,
      reason: "asked to wait 7200 s",
    });
    const error = await failure(send(pace, transport, input()));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(
      `The client of Example did not send the thing: ${HOST} stopped: asked to wait 7200 s`,
    );
    expect(sent).toHaveLength(1);
  });

  it("stops the host after a 403, and the next exchange does not go", async () => {
    const { pace, clock } = fakePace();
    const { transport, sent } = fakeTransport(clock, () => reply(403, {}));
    expect((await send(pace, transport, input())).reply.status).toBe(403);
    const error = await failure(send(pace, transport, input()));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.name).toBe("ApiError");
    expect(error.message).toContain("The client of Example did not send the thing");
    expect(sent).toHaveLength(1);
  });

  it("stops the host after 5 exchanges in sequence with no answer, and no message has the secret", async () => {
    const { pace, clock } = fakePace();
    const { transport, sent } = fakeTransport(
      clock,
      () => new Error(`connect failed for https://${HOST}/?key=${SECRET}`),
    );
    for (let round = 0; round < 5; round += 1) {
      const error = await failure(send(pace, transport, input()));
      expect(error).toBeInstanceOf(ApiError);
      expect(error.message).toBe(
        `Example gave no answer to the thing: connect failed for https://${HOST}/?key=${MARK}`,
      );
    }
    const stopped = await failure(send(pace, transport, input()));
    expect(stopped.message).toContain("5 failures in a row");
    expect(sent).toHaveLength(5);
  });

  it("changes no message with the default redact function", async () => {
    const { pace, clock } = fakePace();
    const { transport } = fakeTransport(clock, () => new Error(`failed with ${SECRET}`));
    const error = await failure(send(pace, transport, input({ redact: undefined })));
    expect(error.message).toBe(`Example gave no answer to the thing: failed with ${SECRET}`);
  });

  it("does not stop the host for a client error 400 or a 404", async () => {
    const { pace, clock } = fakePace();
    const { transport, sent } = fakeTransport(clock, (_, index) =>
      reply(index % 2 === 0 ? 400 : 404, {}),
    );
    for (let round = 0; round < 8; round += 1) await send(pace, transport, input());
    expect(sent).toHaveLength(8);
  });

  it("gives the reason of the signal when the signal stops the exchange, and counts no failure", async () => {
    const { pace, clock, scheduler } = fakePace();
    const { transport } = fakeTransport(clock, () => reply(200, {}));
    const controller = new AbortController();
    const reason = new Error("stopped by the test");
    controller.abort(reason);
    const error = await failure(send(pace, transport, input(), controller.signal));
    expect(error).toBe(reason);
    // the method failed records one failure and gives the count, so 1 shows that the abort counted none
    expect(scheduler.failed(HOST)).toBe(1);
  });

  it("counts no failure for an exchange that the signal stops in the transport", async () => {
    const { pace, scheduler } = fakePace();
    const controller = new AbortController();
    const reason = new Error("stopped in flight");
    const transport: Transport = () => {
      controller.abort(reason);
      return Promise.reject(reason);
    };
    expect(await failure(send(pace, transport, input(), controller.signal))).toBe(reason);
    expect(scheduler.failed(HOST)).toBe(1);
  });

  it("shares one pace for each host with other tasks of the scheduler", async () => {
    const { pace, clock, scheduler } = fakePace();
    const { transport, sent } = fakeTransport(clock, () => reply(200, {}));
    await send(pace, transport, input());
    const at = await scheduler.run(HOST, () => Promise.resolve({ value: clock.now(), delayMs: 0 }));
    expect(at - sent[0]!.at).toBe(500);
  });
});

describe("readGrant", () => {
  const issuedAt = Date.parse("2026-11-12T18:00:00Z");

  it("keeps a token until 1 minute before its end, or for half of a short life", () => {
    expect(TOKEN_MARGIN_MS).toBe(60_000);
    expect(
      readGrant(reply(200, { access_token: "token-0001", expires_in: 599 }), "X", issuedAt),
    ).toEqual({
      token: "token-0001",
      until: issuedAt + 539_000,
    });
    expect(
      readGrant(reply(200, { access_token: "token-0001", expires_in: 60 }), "X", issuedAt).until,
    ).toBe(issuedAt + 30_000);
  });

  it("gives an error with no part of the body for each bad answer", () => {
    const cases: [Reply, string][] = [
      [reply(401, { error: SECRET }, {}, "Unauthorized"), "X refused the token: 401 Unauthorized."],
      [reply(200, `<html>${SECRET}</html>`), "The token answer of X is not JSON."],
      [reply(200, [SECRET]), "The token answer of X has no valid access_token."],
      [
        reply(200, { access_token: "no space allowed", expires_in: 10 }),
        "The token answer of X has no valid access_token.",
      ],
      [
        reply(200, { access_token: "token-0001", expires_in: 0 }),
        "The token answer of X has no valid expires_in.",
      ],
      [
        reply(200, { access_token: "token-0001", expires_in: "600" }),
        "The token answer of X has no valid expires_in.",
      ],
    ];
    for (const [answer, message] of cases) {
      expect(() => readGrant(answer, "X", issuedAt, [SECRET], mark)).toThrow(new ApiError(message));
    }
  });

  it("gives the status line of a refusal to the redact function", () => {
    const refusal = reply(400, {}, {}, `Bad client ${SECRET}`);
    expect(() => readGrant(refusal, "X", issuedAt, [SECRET], mark)).toThrow(
      new ApiError(`X refused the token: 400 Bad client ${MARK}.`),
    );
  });
});

describe("tokenStore", () => {
  const start = Date.parse("2026-11-12T18:00:00Z");

  it("gets one token for two exchanges that wait at one time, and a new token after its end", async () => {
    let time = start;
    let grants = 0;
    const tokens = tokenStore(
      () => {
        grants += 1;
        return Promise.resolve({
          token: `token-000${String(grants)}`,
          until: time + 1000,
        } satisfies Grant);
      },
      () => time,
    );
    expect(await Promise.all([tokens.get(), tokens.get()])).toEqual(["token-0001", "token-0001"]);
    expect(grants).toBe(1);
    time += 999;
    expect(await tokens.get()).toBe("token-0001");
    time += 1;
    expect(await tokens.get()).toBe("token-0002");
    tokens.drop();
    expect(await tokens.get()).toBe("token-0003");
  });

  it("drops only the token that it gets, so an old token does not drop a newer token", async () => {
    let grants = 0;
    const tokens = tokenStore(
      () => {
        grants += 1;
        return Promise.resolve({
          token: `token-000${String(grants)}`,
          until: Number.POSITIVE_INFINITY,
        });
      },
      () => start,
    );
    expect(await tokens.get()).toBe("token-0001");
    tokens.drop("token-0001");
    expect(await tokens.get()).toBe("token-0002");
    tokens.drop("token-0001");
    expect(await tokens.get()).toBe("token-0002");
  });

  it("asks again after a grant that failed", async () => {
    let grants = 0;
    const tokens = tokenStore(
      () => {
        grants += 1;
        if (grants === 1) return Promise.reject(new ApiError("no token"));
        return Promise.resolve({ token: "token-0002", until: Number.POSITIVE_INFINITY });
      },
      () => start,
    );
    await expect(tokens.get()).rejects.toThrow("no token");
    expect(await tokens.get()).toBe("token-0002");
  });
});

describe("sendWithToken", () => {
  const tokens = (): { store: Tokens; count: () => number } => {
    let grants = 0;
    const store = tokenStore(
      () => {
        grants += 1;
        return Promise.resolve({
          token: `token-000${String(grants)}`,
          until: Number.POSITIVE_INFINITY,
        });
      },
      () => 0,
    );
    return { store, count: () => grants };
  };
  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  it("gets a new token after a 401, and sends the exchange one more time", async () => {
    const { pace, clock, scheduler } = fakePace();
    const { transport, sent } = fakeTransport(clock, (_, index) =>
      reply(index === 0 ? 401 : 200, {}),
    );
    const { store, count } = tokens();
    const answer = await sendWithToken(pace, transport, store, input(), bearer);
    expect(answer.reply.status).toBe(200);
    expect(count()).toBe(2);
    expect(sent.map(({ exchange }) => exchange.headers["authorization"])).toEqual([
      "Bearer token-0001",
      "Bearer token-0002",
    ]);
    expect(scheduler.stopOf(HOST)).toBeUndefined();
  });

  it("stops the host after a second 401", async () => {
    const { pace, clock } = fakePace();
    const { transport, sent } = fakeTransport(clock, () => reply(401, {}));
    const { store } = tokens();
    expect((await sendWithToken(pace, transport, store, input(), bearer)).reply.status).toBe(401);
    await expect(sendWithToken(pace, transport, store, input(), bearer)).rejects.toThrow(ApiError);
    expect(sent).toHaveLength(2);
  });

  it("stops the host after a 403, with no new token", async () => {
    const { pace, clock } = fakePace();
    const { transport, sent } = fakeTransport(clock, () => reply(403, {}));
    const { store, count } = tokens();
    expect((await sendWithToken(pace, transport, store, input(), bearer)).reply.status).toBe(403);
    await expect(sendWithToken(pace, transport, store, input(), bearer)).rejects.toThrow(ApiError);
    expect(count()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("puts the token among the secrets of a message", async () => {
    const { pace, clock } = fakePace();
    const { transport } = fakeTransport(
      clock,
      (exchange) => new Error(`failed with ${exchange.headers["authorization"] ?? ""}`),
    );
    const { store } = tokens();
    const error = await failure(sendWithToken(pace, transport, store, input(), bearer));
    expect(error.message).toBe(`Example gave no answer to the thing: failed with Bearer ${MARK}`);
  });
});

/** A fetch function that records each call and gives a fixed answer. With `bytes`, the answer has `arrayBuffer`. */
const fakeFetch = (
  answer: {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: string;
    bytes?: Uint8Array;
  } = { status: 200 },
): { fetch: FetchLike; calls: { url: string; init: Parameters<FetchLike>[1] }[] } => {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const { bytes } = answer;
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      status: answer.status,
      statusText: answer.statusText ?? "",
      headers: new Headers(answer.headers ?? {}),
      text: () => Promise.resolve(answer.body ?? ""),
      ...(bytes === undefined ? {} : { arrayBuffer: () => Promise.resolve(bytes.slice().buffer) }),
    });
  };
  return { fetch, calls };
};

/** A fetch function that answers only when the signal stops it, with the reason of the signal. */
const stuckFetch: FetchLike = (_, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      reject(init.signal.reason as Error);
    });
  });

const get = (headers: Record<string, string> = {}): Exchange => ({
  method: "GET",
  url: `https://${HOST}/`,
  headers,
  body: null,
});

describe("fetchTransport", () => {
  it("sends the User-Agent, the method, the headers and the body, and follows no redirect", async () => {
    const { fetch, calls } = fakeFetch({
      status: 201,
      statusText: "Created",
      headers: { ETag: '"v1"', "Content-Type": "application/json" },
      body: "{}",
    });
    const transport = fetchTransport({ userAgent: "example-app/1.0 (ops@example.com)", fetch });
    const answer = await transport(
      {
        method: "POST",
        url: `https://${HOST}/thing`,
        headers: { accept: "application/json" },
        body: "x=1",
      },
      undefined,
    );
    expect(calls[0]!.url).toBe(`https://${HOST}/thing`);
    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      headers: { "user-agent": "example-app/1.0 (ops@example.com)", accept: "application/json" },
      body: "x=1",
      redirect: "manual",
    });
    expect(answer).toEqual({
      status: 201,
      statusText: "Created",
      headers: { etag: '"v1"', "content-type": "application/json" },
      body: "{}",
    });
  });

  it("keeps the user-agent header of an exchange, and sends no body for a null body", async () => {
    const { fetch, calls } = fakeFetch();
    const transport = fetchTransport({ userAgent: "default/1.0", fetch });
    await transport(get({ "user-agent": "own/2.0" }), undefined);
    expect(calls[0]!.init.headers["user-agent"]).toBe("own/2.0");
    expect("body" in calls[0]!.init).toBe(false);
  });

  it("gives a binary body byte for byte to an exchange that reads bytes", async () => {
    // the bytes of a gzip header, and two bytes that are not UTF-8
    const binary = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe]);
    const { fetch } = fakeFetch({ status: 200, body: "not read", bytes: binary });
    const transport = fetchTransport({ userAgent: "app/1.0", fetch });
    const answer = await transport({ ...get(), read: "bytes" }, undefined);
    expect(answer.body).toBe("");
    expect(answer.bytes).toEqual(binary);
    const text = await transport({ ...get(), read: "text" }, undefined);
    expect(text.body).toBe("not read");
    expect("bytes" in text).toBe(false);
  });

  it("refuses to read bytes with a fetch function that gives no arrayBuffer", async () => {
    const { fetch } = fakeFetch({ status: 200, body: "x" });
    const transport = fetchTransport({ userAgent: "app/1.0", fetch });
    const error = await failure(transport({ ...get(), read: "bytes" }, undefined));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("arrayBuffer");
  });

  it("refuses a User-Agent that is empty, that is not ASCII, or that has a control character", () => {
    for (const userAgent of ["", " app/1.0", "app/1.0 ", "app\r\nx: y", "äpp/1.0", "a".repeat(513)])
      expect(() => fetchTransport({ userAgent })).toThrow(ApiError);
    expect(() => fetchTransport({ userAgent: "a".repeat(512) })).not.toThrow();
  });

  it("refuses a time limit that is not a positive number", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => fetchTransport({ userAgent: "app/1.0", timeoutMs })).toThrow(ApiError);
    expect(API_TIMEOUT_MS).toBe(30_000);
  });

  it("stops a request after the time limit with an error that tells the limit", async () => {
    const transport = fetchTransport({ userAgent: "app/1.0", timeoutMs: 20, fetch: stuckFetch });
    const error = await failure(transport(get(), undefined));
    expect(error.message).toBe("no answer in 1 s");
  });

  it("gives the reason of the signal when the signal stops the request", async () => {
    const transport = fetchTransport({ userAgent: "app/1.0", fetch: stuckFetch });
    const controller = new AbortController();
    const reason = new Error("the caller stopped");
    const pending = transport(get(), controller.signal);
    controller.abort(reason);
    expect(await failure(pending)).toBe(reason);
  });

  it("counts a request that the time limit stopped as a failure of the host", async () => {
    const { pace } = fakePace();
    const transport = fetchTransport({ userAgent: "app/1.0", timeoutMs: 5, fetch: stuckFetch });
    for (let round = 0; round < 5; round += 1) {
      const error = await failure(send(pace, transport, input()));
      expect(error).toBeInstanceOf(ApiError);
      expect(error.message).toBe("Example gave no answer to the thing: no answer in 1 s");
    }
    const stopped = await failure(send(pace, transport, input()));
    expect(stopped.message).toContain("5 failures in a row");
  });
});

describe("poll", () => {
  const url = `https://${HOST}/thing`;
  const DATE = "Sat, 14 Nov 2026 12:00:00 GMT";

  it("sends the validators of the last answer, and gives changed false for a 304", async () => {
    const { pace, clock } = fakePace();
    const { transport, sent } = fakeTransport(clock, (_, index) =>
      index === 0 ? reply(200, "body 1", { etag: '"v1"', "last-modified": DATE }) : reply(304, ""),
    );
    const conditions = new Map<string, Condition>();
    const first = await poll(pace, transport, conditions, input());
    expect(first.changed).toBe(true);
    expect(sent[0]!.exchange.headers).toEqual({});
    expect(conditions.get(url)).toMatchObject({ etag: '"v1"', lastModified: DATE });
    const second = await poll(pace, transport, conditions, input());
    expect(sent[1]!.exchange.headers).toEqual({
      "if-none-match": '"v1"',
      "if-modified-since": DATE,
    });
    expect(second.changed).toBe(false);
    expect(second.reply.status).toBe(304);
    expect(second.classified.outcome).toBe("not-modified");
    expect(sent[1]!.at - sent[0]!.at).toBe(500);
  });

  it("gives changed false for the same body, and true for a new body", async () => {
    const { pace, clock } = fakePace();
    const bodies = ["a", "a", "b"];
    const { transport } = fakeTransport(clock, (_, index) => reply(200, bodies[index] ?? ""));
    const conditions = new Map<string, Condition>();
    const changed: boolean[] = [];
    for (let round = 0; round < bodies.length; round += 1)
      changed.push((await poll(pace, transport, conditions, input())).changed);
    expect(changed).toEqual([true, false, true]);
    // the SHA-256 of "b"
    expect(conditions.get(url)?.digest).toBe(
      "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d",
    );
  });

  it("compares the bytes of a body that reads bytes, also where their text is the same", async () => {
    const { pace, clock } = fakePace();
    // as text, each body is two U+FFFD characters
    const bodies = [
      new Uint8Array([0xff, 0xfe]),
      new Uint8Array([0xff, 0xfe]),
      new Uint8Array([0xff, 0xfd]),
    ];
    const { transport } = fakeTransport(clock, (_, index) => ({
      ...reply(200, ""),
      bytes: bodies[index],
    }));
    const conditions = new Map<string, Condition>();
    const changed: boolean[] = [];
    const bytes = input({ exchange: { ...input().exchange, read: "bytes" } });
    for (let round = 0; round < bodies.length; round += 1)
      changed.push((await poll(pace, transport, conditions, bytes)).changed);
    expect(changed).toEqual([true, false, true]);
    // the SHA-256 of the bytes ff fd
    expect(conditions.get(url)?.digest).toBe(
      "e37ebf9386af53684064f4c6053faf2ee35662571e72eabdad46108d841bd892",
    );
  });

  it("sends only the date to a host whose ETag does not match, as the crawler does", async () => {
    const { pace, clock, scheduler } = fakePace();
    const { transport, sent } = fakeTransport(clock, () =>
      reply(200, "same", { etag: '"unstable"', "last-modified": DATE }),
    );
    const conditions = new Map<string, Condition>();
    for (let round = 0; round <= VALIDATOR_MEMO.misses + 1; round += 1)
      await poll(pace, transport, conditions, input());
    expect(scheduler.store.validators?.(HOST)?.skipEtag).toBe(true);
    expect(sent.at(-1)!.exchange.headers).toEqual({ "if-modified-since": DATE });
  });

  it("polls with a store that has no validator memo, and sends both validators", async () => {
    const { clock, scheduler: full } = fakePace();
    // The type check of this file proves that a store of only `record` and `stop` is a store of the scheduler.
    const scheduler: ApiScheduler = {
      run: full.run.bind(full),
      store: { record: full.store.record.bind(full.store), stop: full.store.stop.bind(full.store) },
    };
    const pace: Pace = { scheduler, now: clock.now, random: () => 0.5 };
    const { transport, sent } = fakeTransport(clock, (_, index) =>
      index === 0 ? reply(200, "body 1", { etag: '"v1"', "last-modified": DATE }) : reply(304, ""),
    );
    const conditions = new Map<string, Condition>();
    const first = await poll(pace, transport, conditions, input());
    expect(first.changed).toBe(true);
    expect(sent[0]!.exchange.headers).toEqual({});
    const second = await poll(pace, transport, conditions, input());
    expect(sent[1]!.exchange.headers).toEqual({
      "if-none-match": '"v1"',
      "if-modified-since": DATE,
    });
    expect(second.changed).toBe(false);
    // The poll wrote no memo: the store that it saw has no noteValidators.
    expect(full.store.validators?.(HOST)).toBeUndefined();
  });

  it("keeps the conditions after an answer that is not 2xx", async () => {
    const { pace, clock } = fakePace();
    const { transport } = fakeTransport(clock, (_, index) =>
      index === 0 ? reply(200, "body", { etag: '"v1"' }) : reply(404, "missing"),
    );
    const conditions = new Map<string, Condition>();
    await poll(pace, transport, conditions, input());
    const kept = conditions.get(url);
    const missing = await poll(pace, transport, conditions, input());
    expect(missing.changed).toBe(false);
    expect(missing.reply.status).toBe(404);
    expect(conditions.get(url)).toBe(kept);
  });

  it("refuses a method that is not GET, and sends nothing", async () => {
    const { pace, clock } = fakePace();
    const { transport, sent } = fakeTransport(clock, () => reply(200, ""));
    const exchange: Exchange = { method: "POST", url, headers: {}, body: "x" };
    const error = await failure(poll(pace, transport, new Map(), input({ exchange })));
    expect(error).toBeInstanceOf(ApiError);
    expect(sent).toHaveLength(0);
  });
});
