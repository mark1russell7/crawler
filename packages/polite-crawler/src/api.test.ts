import { describe, expect, it } from "vitest";
import {
  ApiError,
  TOKEN_MARGIN_MS,
  readGrant,
  send,
  sendWithToken,
  statusLine,
  tokenStore,
  type Exchange,
  type Grant,
  type Pace,
  type Redact,
  type Reply,
  type Send,
  type Tokens,
  type Transport,
} from "./api.ts";
import { HostScheduler, type Clock } from "./politeness.ts";
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
