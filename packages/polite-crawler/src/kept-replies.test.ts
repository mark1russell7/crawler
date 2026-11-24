import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Reply } from "./api.ts";
import { keptReplies } from "./kept-replies.ts";

const URL_A = "https://feed.example/a";
const URL_B = "https://feed.example/b";

const reply = (body: string, etag: string): Reply => ({
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json", etag },
  body,
});

describe("keptReplies", () => {
  it("gives the kept reply and its extra value again, with the same body", async () => {
    const store = keptReplies<{ readonly fetched: number }>();
    // The text has letters of 2, 3 and 4 bytes in UTF-8.
    const body = JSON.stringify({
      items: Array.from({ length: 50 }, (_, index) => ({
        id: index,
        text: "Café → \u{1F32A} go.",
      })),
    });
    store.keep(URL_A, reply(body, '"v1"'), { fetched: 7 });
    expect(await store.get(URL_A)).toEqual({ reply: reply(body, '"v1"'), extra: { fetched: 7 } });
  });

  it("gives each text body again", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: "grapheme", maxLength: 2000 }), async (body) => {
        const store = keptReplies<null>();
        store.keep(URL_A, reply(body, '"v1"'), null);
        expect((await store.get(URL_A))?.reply.body).toBe(body);
      }),
      { numRuns: 50 },
    );
  });

  it("keeps only the last reply of a URL, and one reply for each URL", async () => {
    const store = keptReplies<number>();
    store.keep(URL_A, reply("first", '"v1"'), 1);
    store.keep(URL_A, reply("second", '"v2"'), 2);
    store.keep(URL_B, reply("other", '"v9"'), 9);
    expect(await store.get(URL_A)).toEqual({ reply: reply("second", '"v2"'), extra: 2 });
    expect(await store.get(URL_B)).toEqual({ reply: reply("other", '"v9"'), extra: 9 });
  });

  it("gives undefined for a URL with no reply, and after the delete of its reply", async () => {
    const store = keptReplies<number>();
    expect(await store.get(URL_A)).toBeUndefined();
    store.keep(URL_A, reply("first", '"v1"'), 1);
    store.delete(URL_A);
    expect(await store.get(URL_A)).toBeUndefined();
  });

  it("gives an empty body again", async () => {
    const store = keptReplies<number>();
    store.keep(URL_A, reply("", '"v1"'), 1);
    expect((await store.get(URL_A))?.reply.body).toBe("");
  });

  it("keeps the bytes of a reply as they are", async () => {
    const store = keptReplies<number>();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    store.keep(URL_A, { ...reply("", '"v1"'), bytes }, 1);
    const kept = await store.get(URL_A);
    expect(kept?.reply.bytes).toEqual(bytes);
    expect(kept?.reply.body).toBe("");
  });
});
