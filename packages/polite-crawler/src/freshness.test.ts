import { describe, expect, it } from "vitest";
import * as api from "./api.ts";
import type { Reply } from "./api.ts";
import { freshUntil } from "./freshness.ts";

const at = (iso: string): number => Date.parse(iso);
const FETCHED = at("2026-10-07T12:00:00Z");
const DATE = "Wed, 07 Oct 2026 12:00:00 GMT";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CAP = 7 * DAY;
const TEN_YEARS = 10 * 365 * DAY;

/** A header accessor over a map with lowercase names, as a `Reply` gives it. */
const headers =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

const fresh = (
  values: Record<string, string>,
  status = 200,
  lastModified: string | undefined = values["last-modified"],
  capMs = CAP,
): number | undefined => freshUntil(headers(values), status, FETCHED, lastModified, capMs);

describe("freshUntil", () => {
  it("uses max-age first", () => {
    expect(fresh({ "cache-control": "max-age=600", date: DATE })).toBe(FETCHED + 10 * MINUTE);
    // max-age wins over Expires and over the heuristic
    expect(
      fresh({
        "cache-control": "public, max-age=60",
        date: DATE,
        expires: "Wed, 07 Oct 2026 13:00:00 GMT",
        "last-modified": "Wed, 01 Oct 2025 12:00:00 GMT",
      }),
    ).toBe(FETCHED + MINUTE);
    expect(fresh({ "cache-control": "max-age=0" })).toBe(FETCHED);
  });

  it("uses Expires minus Date when max-age is absent", () => {
    expect(fresh({ date: DATE, expires: "Wed, 07 Oct 2026 12:10:00 GMT" })).toBe(
      FETCHED + 10 * MINUTE,
    );
    // the clock of the server is 5 minutes slow: the lifetime is Expires minus Date, from fetchedAt
    expect(
      fresh({ date: "Wed, 07 Oct 2026 11:55:00 GMT", expires: "Wed, 07 Oct 2026 12:05:00 GMT" }),
    ).toBe(FETCHED + 10 * MINUTE);
    // with no Date, the time of the response is the date
    expect(fresh({ expires: "Wed, 07 Oct 2026 12:30:00 GMT" })).toBe(FETCHED + 30 * MINUTE);
    // an Expires in the past is stale at once
    expect(fresh({ date: DATE, expires: "Wed, 07 Oct 2026 11:00:00 GMT" })).toBe(FETCHED);
  });

  it("gives stale at once for an Expires that is not a date", () => {
    expect(fresh({ date: DATE, expires: "0" })).toBe(FETCHED);
    expect(fresh({ date: DATE, expires: "-1" })).toBe(FETCHED);
    // the heuristic does not replace an Expires that is not a date
    expect(fresh({ expires: "never", "last-modified": "Wed, 01 Oct 2025 12:00:00 GMT" })).toBe(
      FETCHED,
    );
  });

  it("subtracts the Age of the response", () => {
    expect(fresh({ "cache-control": "max-age=600", age: "100" })).toBe(FETCHED + 500_000);
    expect(fresh({ "cache-control": "max-age=600", age: " 100 " })).toBe(FETCHED + 500_000);
    // an Age above the lifetime gives stale at once, not a time in the past
    expect(fresh({ "cache-control": "max-age=600", age: "900" })).toBe(FETCHED);
    // an Age that is not a count of seconds is ignored
    expect(fresh({ "cache-control": "max-age=600", age: "1.5" })).toBe(FETCHED + 10 * MINUTE);
    expect(fresh({ "cache-control": "max-age=600", age: "-30" })).toBe(FETCHED + 10 * MINUTE);
  });

  it("gives stale at once for no-store and no-cache", () => {
    expect(fresh({ "cache-control": "no-store" })).toBe(FETCHED);
    expect(fresh({ "cache-control": "no-cache" })).toBe(FETCHED);
    expect(fresh({ "cache-control": "max-age=600, no-store" })).toBe(FETCHED);
    expect(
      fresh({ "cache-control": "no-cache", expires: "Wed, 07 Oct 2026 13:00:00 GMT", date: DATE }),
    ).toBe(FETCHED);
    expect(fresh({ "cache-control": 'private, no-cache="set-cookie"' })).toBe(FETCHED);
  });

  it("uses 10 percent of the age of Last-Modified for a heuristic status", () => {
    const tenDaysBefore = "Sun, 27 Sep 2026 12:00:00 GMT";
    for (const status of [200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]) {
      expect(fresh({ date: DATE, "last-modified": tenDaysBefore }, status), String(status)).toBe(
        FETCHED + DAY,
      );
    }
    // the argument lastModified gives the date, not the header
    expect(fresh({ date: DATE }, 200, tenDaysBefore)).toBe(FETCHED + DAY);
    // a Last-Modified after the Date gives no freshness
    expect(fresh({ date: DATE, "last-modified": "Thu, 08 Oct 2026 12:00:00 GMT" })).toBeUndefined();
    expect(fresh({ date: DATE, "last-modified": "not a date" })).toBeUndefined();
  });

  it("uses no heuristic for a status that is not heuristic", () => {
    const tenDaysBefore = "Sun, 27 Sep 2026 12:00:00 GMT";
    for (const status of [201, 202, 302, 303, 307, 400, 403, 429, 500, 503]) {
      expect(
        fresh({ date: DATE, "last-modified": tenDaysBefore }, status),
        String(status),
      ).toBeUndefined();
    }
    // an explicit freshness applies to each status
    expect(fresh({ "cache-control": "max-age=60" }, 302)).toBe(FETCHED + MINUTE);
  });

  it("caps the heuristic freshness at capMs", () => {
    const longAgo = "Mon, 07 Oct 2024 12:00:00 GMT";
    expect(fresh({ date: DATE, "last-modified": longAgo }, 200, undefined, DAY)).toBe(
      FETCHED + DAY,
    );
    expect(fresh({ date: DATE }, 200, longAgo, 0)).toBe(FETCHED);
    // a permanent redirect with no Last-Modified gets the cap, a temporary redirect gets nothing
    expect(fresh({ date: DATE }, 301)).toBe(FETCHED + CAP);
    expect(fresh({ date: DATE }, 308)).toBe(FETCHED + CAP);
    expect(fresh({ date: DATE }, 302)).toBeUndefined();
    // the cap does not apply to an explicit freshness
    expect(fresh({ "cache-control": "max-age=1209600" }, 200, undefined, DAY)).toBe(
      FETCHED + 14 * DAY,
    );
  });

  it("gives ten years at most", () => {
    expect(fresh({ "cache-control": "max-age=999999999" })).toBe(FETCHED + TEN_YEARS);
    expect(fresh({ date: DATE, expires: "Fri, 07 Oct 2050 12:00:00 GMT" })).toBe(
      FETCHED + TEN_YEARS,
    );
  });

  it("reads quoted values, uppercase names and odd spacing", () => {
    expect(fresh({ "cache-control": '  Public ,  MAX-AGE = "600" ,, ' })).toBe(
      FETCHED + 10 * MINUTE,
    );
    expect(fresh({ "cache-control": "max-age=\t120" })).toBe(FETCHED + 2 * MINUTE);
    expect(fresh({ "cache-control": " No-Store " })).toBe(FETCHED);
    // a max-age that is not a count of seconds is ignored, and Expires applies
    expect(
      fresh({
        "cache-control": "max-age=ten",
        date: DATE,
        expires: "Wed, 07 Oct 2026 12:05:00 GMT",
      }),
    ).toBe(FETCHED + 5 * MINUTE);
    expect(fresh({ "cache-control": "max-age=-60" })).toBeUndefined();
  });

  it("gives undefined when the response has no freshness", () => {
    expect(fresh({})).toBeUndefined();
    expect(fresh({ date: DATE, "cache-control": "public" })).toBeUndefined();
    expect(fresh({ date: DATE }, 500)).toBeUndefined();
  });

  it("is an export of polite-crawler/api that reads the headers of a Reply", () => {
    const reply: Reply = {
      status: 200,
      statusText: "OK",
      headers: { "cache-control": "max-age=300", age: "60", date: DATE },
      body: "{}",
    };
    const fetchedAt = FETCHED;
    expect(
      api.freshUntil(
        (name) => reply.headers[name],
        reply.status,
        fetchedAt,
        reply.headers["last-modified"],
        CAP,
      ),
    ).toBe(FETCHED + 4 * MINUTE);
    expect(api.freshUntil).toBe(freshUntil);
  });
});
