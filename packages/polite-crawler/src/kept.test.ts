import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { keptFetch, type FetchLike } from "./api.ts";
import {
  KEPT_BODY_MAX,
  KEPT_STATUSES,
  hasValidator,
  isTextType,
  keepAnswer,
  keptKey,
  keptRequestHeaders,
  keptStore,
  readKept,
  type Kept,
} from "./kept.ts";

const URL_A = "https://api.example.test/repos/example/lib/contents/package.json";
const JSON_TYPE = "application/json; charset=utf-8";

const kept = (body: string, etag = '"v1"'): Kept => ({
  etag,
  status: 200,
  headers: { "content-type": JSON_TYPE, etag },
  body,
});

describe("keptRequestHeaders", () => {
  it("sends the ETag and the date of the kept answer", () => {
    const k: Kept = { ...kept("{}"), lastModified: "Tue, 17 Nov 2026 10:00:00 GMT" };
    expect(keptRequestHeaders(k, { accept: "application/json" })).toEqual({
      accept: "application/json",
      "if-none-match": '"v1"',
      "if-modified-since": "Tue, 17 Nov 2026 10:00:00 GMT",
    });
  });

  it("adds no validator with no kept answer, or to a request with a validator of its own", () => {
    expect(keptRequestHeaders(undefined, { accept: "a" })).toEqual({ accept: "a" });
    expect(keptRequestHeaders(kept("{}"), { "If-None-Match": '"x"' })).toEqual({
      "If-None-Match": '"x"',
    });
    for (const name of [
      "IF-MODIFIED-SINCE",
      "If-Match",
      "if-unmodified-since",
      "If-Range",
      "Range",
    ])
      expect(hasValidator({ [name]: "x" })).toBe(true);
    expect(hasValidator({ accept: "a" })).toBe(false);
  });
});

describe("keptKey and isTextType", () => {
  it("gives a different key to a different accept header, in any case of the name", () => {
    expect(keptKey(URL_A, { Accept: "application/json" })).toBe(`application/json ${URL_A}`);
    expect(keptKey(URL_A, { accept: "text/plain" })).not.toBe(keptKey(URL_A, {}));
  });

  it("tells a text media type from a different one", () => {
    for (const t of [JSON_TYPE, "text/plain", "application/vnd.github+json", "application/xml"])
      expect(isTextType(t)).toBe(true);
    for (const t of ["text/plain; charset=UTF-8", 'application/json; charset="utf8"'])
      expect(isTextType(t)).toBe(true);
    for (const t of ["application/octet-stream", "image/png", "application/jsonx", "", undefined])
      expect(isTextType(t)).toBe(false);
    // fetch reads text() as UTF-8, so a body in a different charset is not kept.
    expect(isTextType("text/plain; charset=iso-8859-1")).toBe(false);
  });
});

describe("keepAnswer", () => {
  it("keeps an answer 2xx with an ETag, then gives it for a 304 with the fields of the 304", () => {
    const store = keptStore();
    const first = keepAnswer(store, "k", {
      status: 200,
      headers: { "Content-Type": JSON_TYPE, ETag: '"v1"', "X-RateLimit-Remaining": "99" },
      body: '{"n":1}',
    });
    expect(first).toEqual({
      status: 200,
      headers: { "content-type": JSON_TYPE, etag: '"v1"', "x-ratelimit-remaining": "99" },
      body: '{"n":1}',
      notModified: false,
    });
    // The store keeps only the kept headers, not the rate limit of one answer.
    expect(store.get("k")).toEqual(kept('{"n":1}'));

    const second = keepAnswer(store, "k", {
      status: 304,
      headers: { etag: '"v1"', "x-ratelimit-remaining": "98", "content-length": "0" },
      body: "",
    });
    expect(second).toEqual({
      status: 200,
      headers: { "content-type": JSON_TYPE, etag: '"v1"', "x-ratelimit-remaining": "98" },
      body: '{"n":1}',
      notModified: true,
    });
    expect(store.get("k")).toEqual(kept('{"n":1}'));
  });

  it("keeps the new ETag of a 304 and the new body of a changed answer", () => {
    const store = keptStore([["k", kept("old")]]);
    keepAnswer(store, "k", { status: 304, headers: { etag: '"v2"' }, body: "" });
    expect(store.get("k")?.etag).toBe('"v2"');
    expect(store.get("k")?.headers["etag"]).toBe('"v2"');
    const changed = keepAnswer(store, "k", {
      status: 200,
      headers: { "content-type": JSON_TYPE, etag: '"v3"' },
      body: "new",
    });
    expect(changed.notModified).toBe(false);
    expect(store.get("k")).toEqual(kept("new", '"v3"'));
  });

  it("keeps no answer with no validator, a different type, a long body or a partial status", () => {
    const store = keptStore();
    const cases = [
      { status: 200, headers: { "content-type": JSON_TYPE }, body: "{}" },
      {
        status: 200,
        headers: { "content-type": "application/octet-stream", etag: '"b"' },
        body: "x",
      },
      { status: 200, headers: { "content-type": JSON_TYPE, etag: '"l"' }, body: "x".repeat(11) },
      { status: 404, headers: { "content-type": JSON_TYPE, etag: '"n"' }, body: "{}" },
      { status: 206, headers: { "content-type": JSON_TYPE, etag: '"p"' }, body: "{" },
      { status: 201, headers: { "content-type": JSON_TYPE, etag: '"c"' }, body: "{}" },
    ];
    for (const answer of cases) {
      const read = keepAnswer(store, "k", answer, { maxBody: 10 });
      expect(read).toMatchObject({ status: answer.status, body: answer.body, notModified: false });
    }
    expect(store.get("k")).toBeUndefined();
    expect(KEPT_BODY_MAX).toBe(1_048_576);
    expect(KEPT_STATUSES).toEqual([200, 203, 204]);
  });

  it("gives a 304 for a key with no kept answer as it is", () => {
    const store = keptStore();
    expect(keepAnswer(store, "k", { status: 304, headers: {}, body: "" })).toEqual({
      status: 304,
      headers: {},
      body: "",
      notModified: false,
    });
    expect(store.used()).toEqual([]);
  });

  it("keeps only the headers of the options", () => {
    const store = keptStore();
    keepAnswer(
      store,
      "k",
      {
        status: 200,
        headers: { "content-type": JSON_TYPE, etag: '"v1"', link: "<x>" },
        body: "{}",
      },
      { headers: ["ETag"] },
    );
    expect(store.get("k")?.headers).toEqual({ etag: '"v1"' });
  });

  it("gives the body of the last kept answer for each 304, after each order of answers", () => {
    // An answer: a status, an ETag or none, and a body.
    const answer = fc.record({
      status: fc.constantFrom(200, 203, 206, 304, 404, 500),
      etag: fc.option(fc.constantFrom('"a"', '"b"', '"c"'), { nil: undefined }),
      body: fc.string({ maxLength: 8 }),
    });
    fc.assert(
      fc.property(fc.array(answer, { maxLength: 20 }), (answers) => {
        const store = keptStore();
        let last: Kept | undefined;
        for (const a of answers) {
          const headers: Record<string, string> = { "content-type": JSON_TYPE };
          if (a.etag !== undefined) headers["etag"] = a.etag;
          const body = a.status === 304 ? "" : a.body;
          const read = keepAnswer(store, "k", { status: a.status, headers, body });
          // The model: a 304 with a kept answer gives the kept answer. Each other answer is as it is.
          const unchanged = a.status === 304 && last !== undefined;
          const want = unchanged
            ? { status: last?.status, body: last?.body, notModified: true }
            : { status: a.status, body, notModified: false };
          expect(read).toMatchObject(want);
          if (a.status === 304 && last !== undefined) last = { ...last, etag: a.etag ?? last.etag };
          else if (KEPT_STATUSES.includes(a.status) && a.etag !== undefined)
            last = {
              etag: a.etag,
              status: a.status,
              headers: { "content-type": JSON_TYPE, etag: a.etag },
              body,
            };
          expect(store.get("k")?.body).toBe(last?.body);
          expect(store.get("k")?.etag).toBe(last?.etag);
        }
      }),
    );
  });
});

describe("keptStore and readKept", () => {
  it("gives only the entries that a run read or wrote, and reads them back from JSON", () => {
    const store = keptStore([
      ["old", kept("o")],
      ["read", kept("r")],
    ]);
    store.get("read");
    store.get("none");
    store.set("new", kept("n"));
    expect(store.used().map(([key]) => key)).toEqual(["read", "new"]);
    const again = keptStore(readKept(JSON.parse(JSON.stringify(store.used()))));
    expect(again.get("read")).toEqual(kept("r"));
    expect(again.get("new")).toEqual(kept("n"));
    expect(again.get("old")).toBeUndefined();
  });

  it("drops each entry of damaged data, and gives no error", () => {
    const good = kept("g");
    const data = [
      ["good", good],
      ["no-validator", { ...good, etag: undefined }],
      ["bad-status", { ...good, status: 304 }],
      ["partial", { ...good, status: 206 }],
      ["bad-body", { ...good, body: 1 }],
      ["bad-header", { ...good, headers: { etag: 1 } }],
      ["bad-etag", { ...good, etag: 7 }],
      [1, good],
      ["short"],
      null,
    ];
    expect(readKept(data)).toEqual([["good", good]]);
    expect(readKept({ good })).toEqual([]);
    expect(readKept(undefined)).toEqual([]);
  });
});

/** A fetch that gives one answer for each call, and records the headers of each call. */
const serverOf = (
  answers: { status: number; headers?: Record<string, string>; body?: string }[],
): { fetch: FetchLike; sent: Record<string, string>[]; reads: string[] } => {
  const sent: Record<string, string>[] = [];
  const reads: string[] = [];
  let n = 0;
  const fetch: FetchLike = (_url, init) => {
    sent.push({ ...init.headers });
    const a = answers[Math.min(n, answers.length - 1)]!;
    n += 1;
    return Promise.resolve({
      status: a.status,
      statusText: a.status === 304 ? "Not Modified" : "OK",
      headers: new Headers(a.headers ?? {}),
      text: () => {
        reads.push("text");
        return Promise.resolve(a.body ?? "");
      },
      arrayBuffer: () => {
        reads.push("bytes");
        return Promise.resolve(new TextEncoder().encode(a.body ?? "").slice().buffer);
      },
    });
  };
  return { fetch, sent, reads };
};

const get = (headers: Record<string, string> = { accept: "application/json" }) => ({
  method: "GET",
  headers,
  redirect: "manual" as const,
  signal: new AbortController().signal,
});

describe("keptFetch", () => {
  it("sends the ETag of the kept answer, and gives the kept body for a 304", async () => {
    const { fetch, sent } = serverOf([
      { status: 200, headers: { "content-type": JSON_TYPE, etag: '"v1"' }, body: '{"n":1}' },
      { status: 304, headers: { etag: '"v1"', "x-ratelimit-remaining": "41" } },
    ]);
    const store = keptStore();
    const kf = keptFetch(fetch, store);
    const first = await kf(URL_A, get());
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('{"n":1}');
    const second = await kf(URL_A, get());
    expect(sent[1]).toMatchObject({ "if-none-match": '"v1"' });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe('{"n":1}');
    const headers: Record<string, string> = {};
    second.headers.forEach((value, name) => {
      headers[name] = value;
    });
    expect(headers).toMatchObject({ etag: '"v1"', "x-ratelimit-remaining": "41" });
    expect(store.used().map(([key]) => key)).toEqual([keptKey(URL_A, get().headers)]);
  });

  it("sends a POST, a request with a validator of its own and a binary GET as they are", async () => {
    const { fetch, sent, reads } = serverOf([
      { status: 304, headers: { etag: '"v1"' } },
      { status: 200, headers: { "content-type": "image/png", etag: '"p"' }, body: "png" },
    ]);
    const store = keptStore([[keptKey(URL_A, get().headers), kept("{}")]]);
    const kf = keptFetch(fetch, store);
    const own = await kf(URL_A, get({ accept: "application/json", "if-none-match": '"mine"' }));
    expect(own.status).toBe(304);
    expect(sent[0]).toEqual({ accept: "application/json", "if-none-match": '"mine"' });
    const png = await kf(`${URL_A}.png`, get());
    expect(reads).toEqual([]);
    expect(new TextDecoder().decode(await png.arrayBuffer!())).toBe("png");
    expect(store.get(keptKey(`${URL_A}.png`, get().headers))).toBeUndefined();
    const post = await kf(URL_A, { ...get(), method: "POST", body: "{}" });
    expect(post.status).toBe(200);
    expect(sent[2]).toEqual({ accept: "application/json" });
    await kf(URL_A, get({ accept: "application/json", range: "bytes=0-1" }));
    expect(sent[3]).toEqual({ accept: "application/json", range: "bytes=0-1" });
  });
});
