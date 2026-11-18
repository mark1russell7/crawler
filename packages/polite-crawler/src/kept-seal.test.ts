import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KEPT_SEAL_FORMAT, KEPT_SEAL_SECRET_MIN, openKept, sealKept } from "./kept-seal.ts";
import type { Kept } from "./kept.ts";

// Made-up secrets for the tests. Each one is a random key in hex, not a key of any system.
const SECRET = "3f9c2a7e5b1d4c8f0a6e2d9b7c5f1e3a";
const OTHER = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const URL_A = "https://api.example.test/repos/example/lib/contents/package.json";
const JSON_TYPE = "application/json; charset=utf-8";

const kept = (body: string, etag = '"v1"'): Kept => ({
  etag,
  status: 200,
  headers: { "content-type": JSON_TYPE, etag },
  body,
});

const header = new TextEncoder().encode(`${KEPT_SEAL_FORMAT}\n`);

const keptArb: fc.Arbitrary<Kept> = fc.record({
  etag: fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 20 }),
  status: fc.constantFrom(200, 203, 204),
  headers: fc.dictionary(
    fc.stringMatching(/^[a-z][a-z-]{0,15}$/),
    fc.string({ unit: "grapheme", maxLength: 40 }),
    { maxKeys: 4 },
  ),
  body: fc.string({ unit: "grapheme", maxLength: 400 }),
});

describe("sealKept and openKept", () => {
  it("give back the entries of the store", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.webUrl(), keptArb), { maxLength: 6 }),
        fc.string({ maxLength: 12 }),
        async (entries, label) => {
          const sealed = await sealKept(entries, SECRET, { label });
          const opened = await openKept(sealed, SECRET, { label });
          expect(opened.note).toBeUndefined();
          expect(opened.entries).toEqual(entries);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("start the bytes with the format line, and give no text of the body in the bytes", async () => {
    const sealed = await sealKept([[URL_A, kept('{"name":"example-private-lib"}')]], SECRET);
    expect(sealed.slice(0, header.length)).toEqual(header);
    expect(new TextDecoder().decode(sealed)).not.toContain("example-private-lib");
  });

  it("give two different seals for the same entries, with a new salt and IV each time", async () => {
    const entries: [string, Kept][] = [[URL_A, kept("{}")]];
    const one = await sealKept(entries, SECRET);
    const two = await sealKept(entries, SECRET);
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
    expect((await openKept(two, SECRET)).entries).toEqual(entries);
  });

  it("give no entries and a note for another secret or another label", async () => {
    const sealed = await sealKept([[URL_A, kept("{}")]], SECRET, { label: "app-one" });
    const otherSecret = await openKept(sealed, OTHER, { label: "app-one" });
    expect(otherSecret.entries).toEqual([]);
    expect(otherSecret.note).toMatch(/does not open/);
    const otherLabel = await openKept(sealed, SECRET, { label: "app-two" });
    expect(otherLabel.entries).toEqual([]);
    expect(otherLabel.note).toMatch(/does not open/);
  });

  it("give no entries and a note when one byte after the header changes", async () => {
    const sealed = await sealKept([[URL_A, kept("{}")]], SECRET);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: header.length, max: sealed.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        async (at, flip) => {
          const damaged = new Uint8Array(sealed);
          damaged[at] = damaged[at]! ^ flip;
          const opened = await openKept(damaged, SECRET);
          expect(opened.entries).toEqual([]);
          expect(opened.note).toMatch(/does not open/);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("give no entries and a note for data that is not a seal, or a seal that is too short", async () => {
    const plain = await openKept(
      new TextEncoder().encode(JSON.stringify([[URL_A, kept("{}")]])),
      SECRET,
    );
    expect(plain.entries).toEqual([]);
    expect(plain.note).toMatch(/not a sealed store/);
    const empty = await openKept(new Uint8Array(0), SECRET);
    expect(empty.note).toMatch(/not a sealed store/);
    const cut = await openKept(header, SECRET);
    expect(cut.entries).toEqual([]);
    expect(cut.note).toMatch(/too short/);
  });

  it("throw a RangeError for a secret that is too short, as a string or as bytes", async () => {
    const short = "x".repeat(KEPT_SEAL_SECRET_MIN - 1);
    await expect(sealKept([], short)).rejects.toThrow(RangeError);
    await expect(openKept(header, new Uint8Array(KEPT_SEAL_SECRET_MIN - 1))).rejects.toThrow(
      RangeError,
    );
    await expect(sealKept([], new Uint8Array(KEPT_SEAL_SECRET_MIN))).resolves.toBeInstanceOf(
      Uint8Array,
    );
  });

  it("seal an empty store, and open it to no entries and no note", async () => {
    const opened = await openKept(await sealKept([], SECRET), SECRET);
    expect(opened).toEqual({ entries: [] });
  });

  it("compress a body that repeats, so the seal is much smaller than the body", async () => {
    const body = JSON.stringify(
      Array.from({ length: 2000 }, (_, i) => ({ id: i % 10, name: "example" })),
    );
    const sealed = await sealKept([[URL_A, kept(body)]], SECRET);
    expect(sealed.length).toBeLessThan(body.length / 10);
    expect((await openKept(sealed, SECRET)).entries[0]?.[1].body).toBe(body);
  });
});
