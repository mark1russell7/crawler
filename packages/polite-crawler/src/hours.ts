/**
 * The hours reader reads opening hours from the three places where they occur:
 *
 * - schema.org JSON-LD: the `openingHours` strings or `openingHoursSpecification`.
 * - The `opening_hours` tag of OpenStreetMap, in its common subset. For a rule that the parser
 *   cannot fully read (holidays, months, sunrise), it gives no result. It does not guess.
 * - The text of the page: "Mon–Thu 11am–10pm, Fri–Sat 11am–1am", "Lunch Mon-Fri 11:30-2:30 /
 *   Dinner 5-10", "Sunday: Closed".
 *
 * A day can have more than one interval (lunch and dinner). A day that is not in a week is
 * unknown, not closed. When a time has no am or pm, the parser guesses it and the result says so
 * (`inferred`). Thus a guess does not look like a fact.
 */

export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const DAYS: readonly Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** An interval is [open, close] as HH:MM. A close at or before the open is after midnight. */
export type Interval = readonly [string, string];
/** A week gives the intervals of each day, and [] for a closed day. A day that is not there is unknown. */
export type Week = Partial<Record<Day, readonly Interval[]>>;

export interface Hours {
  readonly week: Week;
  readonly from: "jsonld" | "osm" | "text";
  /** This text is the words that the hours came from. */
  readonly raw: string;
  /** This value is true when the parser guessed an am or a pm ("11-9"). */
  readonly inferred: boolean;
}

const DAY_WORDS: Readonly<Record<string, Day>> = {
  mo: "mon",
  mon: "mon",
  monday: "mon",
  mondays: "mon",
  tu: "tue",
  tue: "tue",
  tues: "tue",
  tuesday: "tue",
  tuesdays: "tue",
  we: "wed",
  wed: "wed",
  weds: "wed",
  wednesday: "wed",
  wednesdays: "wed",
  th: "thu",
  thu: "thu",
  thur: "thu",
  thurs: "thu",
  thursday: "thu",
  thursdays: "thu",
  fr: "fri",
  fri: "fri",
  friday: "fri",
  fridays: "fri",
  sa: "sat",
  sat: "sat",
  saturday: "sat",
  saturdays: "sat",
  su: "sun",
  sun: "sun",
  sunday: "sun",
  sundays: "sun",
};

const dayOf = (word: string): Day | undefined => DAY_WORDS[word.toLowerCase().replace(/\.$/, "")];

/** This function gives the days from one day to another, with the two days. It continues past Sunday (Fri-Mon). */
export const dayRange = (from: Day, to: Day): Day[] => {
  const out: Day[] = [];
  for (let index = DAYS.indexOf(from); ; index = (index + 1) % 7) {
    out.push(DAYS[index]!);
    if (DAYS[index] === to || out.length === 7) return out;
  }
};

const pad = (value: number): string => String(value).padStart(2, "0");
const hhmm = (hour: number, minute: number): string => `${pad(hour % 24)}:${pad(minute)}`;

const minutesOf = (clock: string): number =>
  Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
/** This function gives the minutes from the start of the day. A close at or before the open is on the next day ("17:00-02:00" ends at 26:00). */
const spanOf = ([open, close]: Interval): readonly [number, number] => {
  const start = minutesOf(open);
  const end = minutesOf(close);
  return [start, end <= start ? end + 1440 : end];
};
const fromMinutes = (minutes: number): string => hhmm(Math.floor(minutes / 60), minutes % 60);

const addInterval = (
  week: Record<string, Interval[]>,
  days: readonly Day[],
  interval: Interval,
): void => {
  for (const day of days) {
    let list = week[day] ?? [];
    if (!list.some(([open, close]) => open === interval[0] && close === interval[1])) {
      // intervals that overlap are one opening ("open 6:30-3, delivery 8-2"
      // is open 6:30-3; "11-10:15pm, 11-1am" is open 11-1am); lunch and
      // dinner with a gap stay two
      const [start, end] = spanOf(interval);
      const overlaps = (other: Interval): boolean => {
        const [otherStart, otherEnd] = spanOf(other);
        return otherStart <= end && start <= otherEnd;
      };
      const [first, last] = list.filter(overlaps).reduce<readonly [number, number]>(
        ([low, high], other) => {
          const [otherStart, otherEnd] = spanOf(other);
          return [Math.min(low, otherStart), Math.max(high, otherEnd)];
        },
        [start, end],
      );
      // a union of a whole day or more is open around the clock
      const merged: Interval = [
        fromMinutes(first),
        fromMinutes(last - first >= 1440 ? first : last),
      ];
      list = [...list.filter((other) => !overlaps(other)), merged];
    }
    list.sort((a, b) => a[0].localeCompare(b[0]));
    week[day] = list;
  }
};

const closeDays = (week: Record<string, Interval[]>, days: readonly Day[]): void => {
  for (const day of days) if (week[day] === undefined) week[day] = [];
};

// ── the OSM / schema.org compact syntax ─────────────────────────────────────

const OSM_DAYS = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/;
const OSM_TIME = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\+?$/;

/**
 * This function reads the `opening_hours` notation of OpenStreetMap, for example
 * "Mo-Th 11:00-23:00; Fr,Sa 11:00-01:00; Su off". The `openingHours` of schema.org uses the same
 * notation. A later rule replaces an earlier rule for the same days, as OpenStreetMap specifies.
 */
export const fromCompact = (value: string, from: "osm" | "jsonld" = "osm"): Hours | undefined => {
  const text = value.trim();
  if (text.length === 0) return undefined;
  const week: Record<string, Interval[]> = {};
  if (text === "24/7") {
    addInterval(week, DAYS, ["00:00", "00:00"]);
    return { week, from, raw: value, inferred: false };
  }
  // a quoted comment ("breakfast", "kitchen closes at 10") says nothing a
  // parser can use. ";" starts a rule that replaces what earlier rules said
  // about its days; "," after a time starts an additional rule, which adds to
  // them ("Mo-Fr 11:00-21:00, Sa-Su 12:00-20:00", a common shape in OSM)
  const rules = text
    .replace(/"[^"]*"/g, " ")
    .split(/\s*;\s*/)
    .flatMap((rule) =>
      rule
        .split(/(?<=\d:\d{2}\+?)\s*,\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b)/)
        .map((part, index) => ({ part, additional: index > 0 })),
    );
  for (const { part: rule, additional } of rules.filter(({ part }) => part.trim().length > 0)) {
    const match =
      /^([A-Za-z,\- ]*?)\s*((?:\d{1,2}:\d{2}-\d{1,2}:\d{2}\+?(?:\s*,\s*)?)+|off|closed)?$/i.exec(
        rule.trim(),
      );
    if (match === null) return undefined;
    const dayPart = (match[1] ?? "").replace(/\s+/g, "");
    const timePart = match[2];
    let days: Day[] = [...DAYS];
    if (dayPart.length > 0) {
      days = [];
      let holidays = false;
      // empty pieces too: Squarespace writes ", Tu 16:00-21:00, ... Sa 16:00-21:00, "
      for (const piece of dayPart.split(",").filter((part) => part.length > 0)) {
        // public and school holidays are not part of a week: "PH off" says
        // nothing about a Tuesday, and "Su,PH 11:00-18:00" still says Sunday
        if (/^(PH|SH)$/i.test(piece)) {
          holidays = true;
          continue;
        }
        const range = OSM_DAYS.exec(piece);
        if (range === null) return undefined; // months, weeks, offsets: not read, not guessed
        days.push(...dayRange(dayOf(range[1]!)!, dayOf(range[2] ?? range[1]!)!));
      }
      if (days.length === 0 && holidays) continue;
    }
    if (timePart === undefined) return undefined;
    // a later rule replaces what earlier ones said about these days
    if (!additional) for (const day of days) delete week[day];
    if (/^(off|closed)$/i.test(timePart)) {
      closeDays(week, days);
      continue;
    }
    for (const span of timePart.split(/\s*,\s*/).filter((part) => part.length > 0)) {
      const time = OSM_TIME.exec(span);
      if (time === null) return undefined;
      const close = Number(time[3]) === 24 ? "00:00" : hhmm(Number(time[3]), Number(time[4]));
      addInterval(week, days, [hhmm(Number(time[1]), Number(time[2])), close]);
    }
  }
  return Object.keys(week).length === 0 ? undefined : { week, from, raw: value, inferred: false };
};

// ── schema.org JSON-LD ──────────────────────────────────────────────────────

const SCHEMA_DAY = /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i;

const clockOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  return match === null ? undefined : hhmm(Number(match[1]), Number(match[2]));
};

/**
 * This function reads the hours of one JSON-LD object, for example a `Restaurant`. It reads the
 * `openingHoursSpecification` first, and the `openingHours` when there is no specification. In
 * schema.org, a closed day has the same opening and closing time, 00:00.
 */
export const fromSchemaOrg = (record: Readonly<Record<string, unknown>>): Hours | undefined => {
  const specs = record["openingHoursSpecification"];
  const list = Array.isArray(specs) ? specs : specs !== undefined && specs !== null ? [specs] : [];
  if (list.length > 0) {
    const week: Record<string, Interval[]> = {};
    for (const spec of list) {
      if (spec === null || typeof spec !== "object") continue;
      const entry = spec as Record<string, unknown>;
      const raw = entry["dayOfWeek"];
      const names = (Array.isArray(raw) ? raw : [raw]).filter(
        (value): value is string => typeof value === "string",
      );
      const days = names.flatMap((name) => {
        const day = SCHEMA_DAY.exec(name.trim());
        return day === null ? [] : [dayOf(day[1]!)!];
      });
      const opens = clockOf(entry["opens"]);
      const closes = clockOf(entry["closes"]);
      if (days.length === 0 || opens === undefined || closes === undefined) continue;
      if (opens === "00:00" && closes === "00:00") closeDays(week, days);
      else addInterval(week, days, [opens, closes === "24:00" ? "00:00" : closes]);
    }
    if (Object.keys(week).length > 0) {
      return { week, from: "jsonld", raw: JSON.stringify(list).slice(0, 500), inferred: false };
    }
  }
  const compact = record["openingHours"];
  const strings = (Array.isArray(compact) ? compact : [compact]).filter(
    (value): value is string => typeof value === "string",
  );
  if (strings.length === 0) return undefined;
  // schema.org writes one rule per string; a comma inside one is a day list
  // ("Tu,Th 16:00-20:00") or, after a time, another rule, as in OSM
  const parsed = fromCompact(strings.join("; "), "jsonld");
  return parsed === undefined ? undefined : { ...parsed, raw: strings.join(", ") };
};

// ── free text ───────────────────────────────────────────────────────────────

const DAY_WORD =
  "(?:mon(?:day)?s?|tue(?:s(?:day)?)?s?|wed(?:s|nesday)?s?|thu(?:r(?:s(?:day)?)?)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?)\\.?";
const RANGE_SEP = "\\s*(?:-|–|—|to|thru|through|until|till|'til|til)\\s*";
const TIME = "(?:(?:\\d{1,2})(?::\\d{2}|\\.\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?|noon|midnight)";
/** This pattern is one time with am or pm: "7:00 am". */
const CLOCK = "(?:\\d{1,2}(?::\\d{2}|\\.\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)|noon|midnight)";

const TOKEN = new RegExp(
  [
    `(?<every>\\b(?:daily|every\\s*day|7\\s*days(?:\\s*a\\s*week)?|seven\\s*days)\\b)`,
    `(?<weekdays>\\bweekdays\\b)`,
    `(?<weekends>\\bweekends\\b)`,
    `(?<span>\\b${DAY_WORD}${RANGE_SEP}${DAY_WORD}(?![a-z]))`,
    `(?<day>\\b${DAY_WORD}(?![a-z]))`,
    `(?<times>(?<![\\d:])${TIME}${RANGE_SEP}${TIME}(?![\\d]))`,
    // a meridiem ends its word: "73 Ames St" is no clock
    `(?<clock>(?<![\\d:.])${CLOCK}(?![a-z\\d]))`,
    `(?<closed>\\bclosed\\b)`,
  ].join("|"),
  "gi",
);

interface Clock {
  readonly hour: number;
  readonly minute: number;
  readonly meridiem: "am" | "pm" | undefined;
  /** This value is true when the time uses the 24-hour clock ("17:00", "09:30"). */
  readonly h24: boolean;
}

const readClock = (value: string): Clock | undefined => {
  const text = value.trim().toLowerCase();
  if (text === "noon") return { hour: 12, minute: 0, meridiem: "pm", h24: false };
  if (text === "midnight") return { hour: 12, minute: 0, meridiem: "am", h24: false };
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/.exec(text);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 24 || minute > 59) return undefined;
  const meridiem = match[3] === undefined ? undefined : match[3].startsWith("a") ? "am" : "pm";
  return {
    hour,
    minute,
    meridiem,
    h24: meridiem === undefined && (hour > 12 || hour === 0 || match[1]!.startsWith("0")),
  };
};

const to24 = (clock: Clock, meridiem: "am" | "pm"): number =>
  meridiem === "am"
    ? clock.hour === 12
      ? 0
      : clock.hour
    : clock.hour === 12
      ? 12
      : clock.hour + 12;

/**
 * This function reads a range of two times, as a restaurant writes it:
 *
 * - "5-10pm" is 17:00-22:00, and "11-3pm" is 11:00-15:00. The opening gets the am or pm of the
 *   close, but not when that puts the opening after the close.
 * - "11am-10" closes at 22:00.
 * - With no am, pm or 24-hour time ("11-9"), an opening before 7 is pm. A close at or before the
 *   opening is pm too. The result is then `inferred`.
 */
export const readRange = (
  start: string,
  end: string,
): { readonly interval: Interval; readonly inferred: boolean } | undefined => {
  const a = readClock(start);
  const b = readClock(end);
  if (a === undefined || b === undefined) return undefined;
  if (a.h24 || b.h24) {
    const close = b.hour === 24 ? 0 : b.hour;
    return { interval: [hhmm(a.hour, a.minute), hhmm(close, b.minute)], inferred: false };
  }
  let open: number;
  let close: number;
  let inferred = false;
  if (a.meridiem !== undefined && b.meridiem !== undefined) {
    open = to24(a, a.meridiem);
    close = to24(b, b.meridiem);
  } else if (b.meridiem !== undefined) {
    // the opening shares the close's meridiem unless that puts it after the
    // close: "5-10pm" opens at 5pm, "11-3pm" at 11am, "10-2am" at 10pm
    close = to24(b, b.meridiem);
    const same = to24(a, b.meridiem);
    open = same <= close ? same : to24(a, b.meridiem === "pm" ? "am" : "pm");
  } else if (a.meridiem !== undefined) {
    open = to24(a, a.meridiem);
    const same = to24(b, a.meridiem);
    close = same > open ? same : to24(b, a.meridiem === "am" ? "pm" : "am");
  } else {
    // no meridiem anywhere: read as a restaurant would mean it, and say so.
    // An opening before 7 is evening ("5-10"); a close at or before the
    // opening, after an evening opening, or within three hours of a morning
    // one ("10-11") is pm.
    inferred = true;
    open = a.hour === 12 ? 12 : a.hour < 7 ? a.hour + 12 : a.hour;
    close =
      b.hour === 12
        ? 0
        : b.hour <= a.hour || open >= 12 || b.hour - open < 3
          ? b.hour + 12
          : b.hour;
  }
  return { interval: [hhmm(open, a.minute), hhmm(close, b.minute)], inferred };
};

const splitRange = (value: string): [string, string] | undefined => {
  const match = new RegExp(`^(${TIME})${RANGE_SEP}(${TIME})$`, "i").exec(value.trim());
  return match === null ? undefined : [match[1]!, match[2]!];
};

const daysOfToken = (groups: Record<string, string | undefined>): Day[] | undefined => {
  if (groups["every"] !== undefined) return [...DAYS];
  if (groups["weekdays"] !== undefined) return ["mon", "tue", "wed", "thu", "fri"];
  if (groups["weekends"] !== undefined) return ["sat", "sun"];
  if (groups["span"] !== undefined) {
    const [from, to] = groups["span"].split(new RegExp(RANGE_SEP, "i"));
    const a = dayOf(from!.replace(/s$/i, "").slice(0, 4));
    const b = dayOf(to!.replace(/s$/i, "").slice(0, 4));
    const first = a ?? dayOf(from!);
    const last = b ?? dayOf(to!);
    return first === undefined || last === undefined ? undefined : dayRange(first, last);
  }
  if (groups["day"] !== undefined) {
    const word = groups["day"].replace(/\.$/, "").toLowerCase();
    const day = dayOf(word) ?? dayOf(word.replace(/s$/, "")) ?? dayOf(word.slice(0, 3));
    return day === undefined ? undefined : [day];
  }
  return undefined;
};

/**
 * This function reads the hours in the text of a page. It reads the lines with days and times as
 * one stream. Thus "Monday – Thursday" on one line and "11:30am – 9pm" on the next line go
 * together. A list of days ("Mon, Wed & Fri") waits for a time or for "closed".
 *
 * Each group of these lines is a candidate. Its label is the short line above it ("Hours",
 * "Dinner", "Happy hour"). A page often shows more than one schedule, and the choice between them
 * is a judgment, not a parse.
 */
export const fromText = (text: string): Array<Hours & { readonly label: string | null }> => {
  const lines = text.split(/\n+/).map((line) => line.trim());
  const out: Array<Hours & { readonly label: string | null }> = [];
  let block: { start: number; lines: string[] } | undefined;
  const flush = (): void => {
    if (block === undefined) return;
    const week: Record<string, Interval[]> = {};
    let inferred = false;
    const tokens = block.lines.flatMap((line, at) =>
      [...line.matchAll(TOKEN)].map((match) => ({ groups: match.groups ?? {}, line: at })),
    );
    const isDays = (token: (typeof tokens)[number] | undefined): boolean =>
      token !== undefined && daysOfToken(token.groups) !== undefined;
    const isValue = (token: (typeof tokens)[number]): boolean =>
      token.groups["times"] !== undefined || token.groups["closed"] !== undefined;
    // a line that starts with a value and names its days after it ("11am-9pm
    // Mon-Thu, 11am-10pm Fri-Sat", "10 AM - 8 PM daily", "Closed Mondays")
    // gives each value to the days that follow it, not the days before
    const valueFirst = new Set<number>();
    block.lines.forEach((_, at) => {
      const onLine = tokens.filter((token) => token.line === at);
      const first = onLine.find((token) => isDays(token) || isValue(token));
      if (first !== undefined && isValue(first) && onLine.some(isDays)) valueFirst.add(at);
    });
    const apply = (value: Interval | "closed", days: readonly Day[]): void => {
      if (value === "closed") closeDays(week, days);
      else addInterval(week, days, value);
    };
    const valueOf = (token: (typeof tokens)[number]): Interval | "closed" | undefined => {
      if (token.groups["closed"] !== undefined) return "closed";
      const parts =
        token.groups["times"] === undefined ? undefined : splitRange(token.groups["times"]);
      const range = parts === undefined ? undefined : readRange(parts[0], parts[1]);
      if (range === undefined) return undefined;
      inferred ||= range.inferred;
      return range.interval;
    };
    /** This function gives the tokens of one kind in sequence from `start`, each on a separate line. */
    const runOf = (start: number, kind: (token: (typeof tokens)[number]) => boolean): number => {
      let end = start;
      while (
        tokens[end + 1] !== undefined &&
        kind(tokens[end + 1]!) &&
        tokens[end + 1]!.line !== tokens[end]!.line
      ) {
        end += 1;
      }
      return end;
    };
    let current: Day[] = [];
    let lastWasDay = false;
    let pending: Array<Interval | "closed"> = [];
    for (let at = 0; at < tokens.length; at += 1) {
      const token = tokens[at]!;
      const days = daysOfToken(token.groups);
      if (days !== undefined && !lastWasDay && pending.length === 0) {
        // a column of days beside a column of hours (Sunday to
        // Saturday, then seven ranges): the n-th range is the n-th day's.
        // Columns of different lengths say nothing certain, so nothing is read
        const lastDay = runOf(at, isDays);
        const firstValue = tokens[lastDay + 1];
        if (
          lastDay > at &&
          firstValue !== undefined &&
          isValue(firstValue) &&
          firstValue.line !== tokens[lastDay]!.line
        ) {
          const lastValue = runOf(lastDay + 1, isValue);
          const dayRun = tokens.slice(at, lastDay + 1);
          const valueRun = tokens.slice(lastDay + 1, lastValue + 1);
          if (valueRun.length >= 2) {
            if (valueRun.length === dayRun.length) {
              dayRun.forEach((dayToken, index) => {
                const value = valueOf(valueRun[index]!);
                if (value !== undefined) apply(value, daysOfToken(dayToken.groups)!);
              });
            }
            at = lastValue;
            continue;
          }
        }
      }
      if (days !== undefined) {
        current = lastWasDay ? [...new Set([...current, ...days])] : days;
        lastWasDay = true;
        const next = tokens[at + 1];
        // the list of days ends where the next token is not a day on this line
        if (pending.length > 0 && !(isDays(next) && next!.line === token.line)) {
          for (const value of pending) apply(value, current);
          pending = [];
        }
        continue;
      }
      const wasDay = lastWasDay;
      lastWasDay = false;
      let value = valueOf(token);
      if (value === undefined && token.groups["clock"] !== undefined && wasDay) {
        // a widget that writes a day, its opening and its closing on three
        // lines; a lone time anywhere else (a booking slot) is no schedule
        const close = tokens[at + 1]?.groups["clock"];
        const range = close === undefined ? undefined : readRange(token.groups["clock"], close);
        if (range !== undefined) {
          inferred ||= range.inferred;
          value = range.interval;
          at += 1;
        }
      }
      if (value === undefined) continue;
      const next = tokens[at + 1];
      const daysFollow = isDays(next) && next!.line === tokens[at]!.line;
      // a value before its days, or "..., closed Fri" after a schedule
      if (daysFollow && (valueFirst.has(token.line) || (value === "closed" && !wasDay))) {
        pending.push(value);
        continue;
      }
      if (current.length > 0) apply(value, current);
    }
    // one range under an hours heading, or after "Open", with no day named
    // ("HOURS OF OPERATION: 7:00am - 10:30pm", "Open 7am-10:30pm") is every
    // day, and says it was a guess; two ranges with no days (mini golf 7-10:30,
    // batting cages 9-10) say nothing certain
    if (Object.keys(week).length === 0 && !tokens.some(isDays)) {
      const ranges = tokens.filter((token) => token.groups["times"] !== undefined);
      const above = lines[block.start - 1] ?? "";
      // "Today's Hours" are one day's ("Now open" is an exhibition's)
      const oneDay = /\b(today|tonight|now)\b/i.test(`${above} ${block.lines.join(" ")}`);
      const heading =
        !oneDay && (/hour|open/i.test(above) || /^open\b/i.test(block.lines[0] ?? ""));
      const said = new Set(ranges.map((token) => token.groups["times"]!.replace(/\s+/g, "")));
      const value = ranges[0] === undefined ? undefined : valueOf(ranges[0]);
      if (heading && said.size === 1 && value !== undefined && value !== "closed") {
        addInterval(week, DAYS, value);
        inferred = true;
      }
    }
    if (Object.keys(week).length > 0) {
      const above = lines[block.start - 1];
      out.push({
        week,
        from: "text",
        raw: block.lines.join("\n"),
        inferred,
        label: above !== undefined && above.length > 0 && above.length <= 40 ? above : null,
      });
    }
    block = undefined;
  };
  lines.forEach((line, index) => {
    const tokens = [...line.matchAll(TOKEN)].map((match) => match.groups ?? {});
    const names = tokens.some(
      (groups) => daysOfToken(groups) !== undefined || groups["closed"] !== undefined,
    );
    // a clock with am/pm or minutes reads as hours on its own line; a bare
    // range ("12-14 Main St") only beside a day
    const clock = tokens.some(
      (groups) =>
        groups["clock"] !== undefined ||
        (groups["times"] !== undefined &&
          /[ap]\.?m|[:.]\d{2}|noon|midnight/i.test(groups["times"])),
    );
    const hoursish = names || clock;
    // a long sentence that happens to mention a day is prose, not a schedule;
    // a long line with several time ranges is a schedule written as one
    // paragraph ("Dinner: Tuesday, Wednesday and Thursday 5pm to 9pm / ...")
    const ranges = tokens.filter((groups) => groups["times"] !== undefined).length;
    if (hoursish && (line.length <= 160 || ranges >= 2)) {
      block ??= { start: index, lines: [] };
      block.lines.push(line);
    } else {
      flush();
    }
  });
  flush();
  return out;
};

// ── what the place keeps ────────────────────────────────────────────────────

const LABEL: Readonly<Record<Day, string>> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const sameDay = (a: readonly Interval[] | undefined, b: readonly Interval[] | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** This function writes a week as text, for example `Mon–Thu 11:00–22:00, Fri–Sat 11:00–23:00`. */
export const describeWeek = (week: Week): string => {
  const parts: string[] = [];
  let index = 0;
  while (index < 7) {
    const day = DAYS[index]!;
    const value = week[day];
    let end = index;
    while (end + 1 < 7 && sameDay(week[DAYS[end + 1]!], value)) end += 1;
    const span = end === index ? LABEL[day] : `${LABEL[day]}–${LABEL[DAYS[end]!]}`;
    if (value !== undefined) {
      parts.push(
        value.length === 0
          ? `${span} closed`
          : `${span} ${value.map(([open, close]) => `${open}–${close}`).join(", ")}`,
      );
    }
    index = end + 1;
  }
  return parts.join("; ");
};

/**
 * This function gives one interval for each day (`hours_week`), and null for a closed day. One
 * interval cannot show a day with two intervals and a gap between them. Thus such a day is not in
 * `hours_week`, and `split` names it.
 */
export const toHoursWeek = (
  week: Week,
): {
  readonly hours_week: Partial<Record<Day, readonly [string, string] | null>>;
  readonly split: readonly Day[];
} => {
  const hoursWeek: Partial<Record<Day, readonly [string, string] | null>> = {};
  const split: Day[] = [];
  for (const day of DAYS) {
    const value = week[day];
    if (value === undefined) continue;
    if (value.length === 0) hoursWeek[day] = null;
    else if (value.length === 1) hoursWeek[day] = value[0]!;
    else split.push(day);
  }
  return { hours_week: hoursWeek, split };
};

/** This function gives the days where two readings disagree, from the days that the two readings state. */
export const disagreements = (a: Week, b: Week): Day[] =>
  DAYS.filter((day) => a[day] !== undefined && b[day] !== undefined && !sameDay(a[day], b[day]));
