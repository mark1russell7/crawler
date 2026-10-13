import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Day, Hours, Interval } from "./hours.ts";
import { DAYS, fromCompact, fromSchemaOrg, fromText, readRange } from "./hours.ts";

/**
 * Properties of the hours reader over generated input: it never throws, its time grows in
 * proportion to its input, and its output keeps its promises.
 */

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
const lengthOf = ([open, close]: Interval): number => {
  const length = (minutes(close) - minutes(open) + 1440) % 1440;
  return length === 0 ? 1440 : length;
};

/** The promises of every reading: days of the week, clocks of a day, and intervals that do not overlap. */
const wellFormed = (readings: readonly Hours[]): void => {
  for (const hours of readings) {
    for (const [day, list] of Object.entries(hours.week)) {
      expect(DAYS).toContain(day);
      expect(list!.length).toBeLessThanOrEqual(8);
      for (const interval of list!) {
        expect(interval[0]).toMatch(CLOCK);
        expect(interval[1]).toMatch(CLOCK);
      }
      const spans = list!
        .map(([open, close]) => {
          const start = minutes(open);
          const end = minutes(close);
          return [start, end <= start ? end + 1440 : end] as const;
        })
        .sort((a, b) => a[0] - b[0]);
      for (let index = 1; index < spans.length; index += 1) {
        expect(spans[index]![0]).toBeGreaterThan(spans[index - 1]![1]);
      }
    }
  }
};

const PIECES = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
  "Monday",
  "Sundays",
  "M-F",
  "Tu-Th",
  "weekdays",
  "weekends",
  "daily",
  "every day",
  "closed",
  "Closed",
  "except",
  "but",
  "Open 24 hours",
  "24/7",
  "-",
  "–",
  "—",
  "−",
  "~",
  " to ",
  " thru ",
  "&",
  ",",
  ":",
  "\n",
  " ",
  "  ",
  " ",
  "​",
  "am",
  "pm",
  "a.m.",
  "noon",
  "midnight",
  "12 midnight",
  "11",
  "5",
  "12",
  "0",
  "24",
  "9:30",
  "10.15",
  "17:00",
  "00:00",
  "24:00",
  "9h",
  "7",
  "6",
  "2",
  "1",
  "(",
  ")",
  "|",
  "/",
  "$",
  "Dec 24",
  "12/25",
  "today",
  "Hours",
  "Summer:",
  "Open",
  "'til",
  "until",
];

const hoursLike: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 24 })
  .chain((pieces) => fc.constantFrom(pieces.join(" "), pieces.join("")));

const RUNS = { numRuns: 2000, seed: 20_261_012 };

describe("the hours reader on generated input", () => {
  it("never throws, and gives well-formed weeks", () => {
    fc.assert(
      fc.property(fc.oneof(hoursLike, fc.string({ maxLength: 200, unit: "grapheme" })), (text) => {
        wellFormed(fromText(text));
        const compact = fromCompact(text);
        if (compact !== undefined) wellFormed([compact]);
      }),
      RUNS,
    );
  });

  it("reads any schema.org value without a throw", () => {
    const value = fc.oneof(
      fc.constantFrom(
        null,
        undefined,
        1,
        true,
        {},
        [],
        "Monday",
        "9",
        "09:00",
        "24:00",
        "9:00 PM",
        "Mo-Fr 09:00-17:00",
      ),
      fc.string({ maxLength: 40 }),
      fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 12 })),
    );
    fc.assert(
      fc.property(value, value, value, value, (dayOfWeek, opens, closes, openingHours) => {
        const read = fromSchemaOrg({
          openingHoursSpecification: [{ dayOfWeek, opens, closes }],
          openingHours,
        });
        if (read !== undefined) wellFormed([read]);
      }),
      RUNS,
    );
  });

  it("never guesses an opening longer than 16 hours, and keeps a long one only when the clocks say it", () => {
    const hour = fc.integer({ min: 0, max: 24 });
    const time = fc
      .tuple(hour, fc.constantFrom("", ":00", ":30"), fc.constantFrom("", "am", "pm", " p.m."))
      .map(([value, minute, meridiem]) => `${String(value)}${minute}${meridiem}`);
    fc.assert(
      fc.property(time, time, (start, end) => {
        const range = readRange(start, end);
        if (range === undefined) return;
        expect(range.interval[0]).toMatch(CLOCK);
        expect(range.interval[1]).toMatch(CLOCK);
        const length = lengthOf(range.interval);
        if (range.inferred) expect(length).toBeLessThanOrEqual(16 * 60);
        if (length > 18 * 60 && length !== 1440) {
          // both ends are stated: a meridiem, or a 24-hour clock
          const stated = (clock: string): boolean => /[ap]\.?m|^0|^(1[3-9]|2\d)/.test(clock);
          expect(stated(start) && stated(end)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("keeps a closed day closed, before, after or inside the schedule", () => {
    const names: Readonly<Record<Day, string>> = {
      mon: "Monday",
      tue: "Tuesday",
      wed: "Wednesday",
      thu: "Thursday",
      fri: "Friday",
      sat: "Saturday",
      sun: "Sunday",
    };
    const schedule = fc.constantFrom(
      "Mon-Sun 9am-5pm",
      "Open daily 11am-9pm",
      "Daily 7:00 AM - 3:00 PM",
      "Every day 5pm-10pm",
      "Mon-Sun 11-9",
      "Sunday - Saturday 8am - 8pm",
    );
    const shape = fc.constantFrom(
      (week: string, day: string) => `Closed ${day}s\n${week}`,
      (week: string, day: string) => `${week}\nClosed ${day}s`,
      (week: string, day: string) => `${week}, closed ${day}`,
      (week: string, day: string) => `${week} except ${day}`,
      (week: string, day: string) => `${day}: Closed\n${week}`,
      (week: string, day: string) => `${week}\n${day}: Closed`,
    );
    fc.assert(
      fc.property(schedule, fc.constantFrom(...DAYS), shape, (week, day, write) => {
        const text = write(week, names[day]);
        const [found] = fromText(text);
        expect(found, text).toBeDefined();
        expect(found!.week[day], text).toEqual([]);
        for (const other of DAYS)
          if (other !== day) expect(found!.week[other]!.length, text).toBe(1);
      }),
      { numRuns: 300, seed: 20_261_012 },
    );
  });
});

describe("the time of the hours reader", () => {
  const time = (run: () => unknown): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  /**
   * The time for 4n stays near four times the time for n: it is not the sixteen of a square. The
   * best of three runs keeps a pause of the collector out, and the floor keeps a busy machine out.
   * A test that uses it tries again two times: a square fails each try, and a busy machine does not.
   */
  const linear = (make: (n: number) => () => unknown): void => {
    make(2000)();
    const best = (n: number): number => Math.min(time(make(n)), time(make(n)), time(make(n)));
    const small = best(20_000);
    const large = best(80_000);
    expect(large).toBeLessThan(Math.max(8 * small, 250));
    expect(large).toBeLessThan(2000);
  };

  it("grows in proportion to the input on hostile text", { retry: 2, timeout: 60_000 }, () => {
    linear((n) => () => fromText(`Hours\n1${" ".repeat(n)}x`));
    linear((n) => () => fromText(`Hours\nMon 1${" ".repeat(n)}x`));
    linear((n) => () => fromText(`Hours\n${"1 ".repeat(n)}x`));
    linear((n) => () => fromText(`Hours\n${"Mon-Fri 11am-9pm\n".repeat(n / 16)}`));
    linear((n) => () => fromText("Mon 9am-5pm ".repeat(n / 12)));
    linear((n) => () => fromCompact(`Mo${" ".repeat(n)}x`));
    linear((n) => () => fromSchemaOrg({ openingHours: `Mo${" ".repeat(n)}#` }));
  });
});
