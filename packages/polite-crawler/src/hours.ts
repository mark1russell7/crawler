/**
 * The hours reader reads opening hours from the three places where they occur:
 *
 * - schema.org JSON-LD: the `openingHours` strings or `openingHoursSpecification`.
 * - The `opening_hours` tag of OpenStreetMap, in its common subset. It does not guess a rule
 *   that it cannot fully read (holidays, months, sunrise). It leaves that rule out and says so.
 * - The text of the page: "Mon–Thu 11am–10pm, Fri–Sat 11am–1am", "Lunch Mon-Fri 11:30-2:30 /
 *   Dinner 5-10", "Sunday: Closed". The text reader reads English.
 *
 * A day can have more than one interval (lunch and dinner). A day that is not in a week is
 * unknown, not closed. When a time has no am or pm, the parser guesses it and the result says so
 * (`inferred`). Thus a guess does not look like a fact. A guess is not longer than 16 hours.
 *
 * The time of each reader grows in proportion to the length of its input.
 */

export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const DAYS: readonly Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * An interval is [open, close] as HH:MM. A close at or before the open is after midnight, and
 * ["00:00", "00:00"] is open 24 hours.
 */
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
  /**
   * This value is true when the reader left out a rule or a line. The rule is not about the week (a
   * holiday, a date) or the reader cannot read it ("sunrise").
   */
  readonly partial?: boolean;
  /** This text names the season or the dates of the hours, for example "Summer" or "2026-06-01/2026-08-31". */
  readonly season?: string;
}

const DAY_WORDS: Readonly<Record<string, Day>> = {
  m: "mon",
  mo: "mon",
  mon: "mon",
  monday: "mon",
  mondays: "mon",
  tu: "tue",
  tue: "tue",
  tues: "tue",
  tuesday: "tue",
  tuesdays: "tue",
  w: "wed",
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
  f: "fri",
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

const dayOf = (word: string): Day | undefined => {
  const clean = word.toLowerCase().replace(/\.$/, "");
  return DAY_WORDS[clean] ?? DAY_WORDS[clean.replace(/s$/, "")] ?? DAY_WORDS[clean.slice(0, 3)];
};

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
/** This function gives the length of an interval in minutes: 1440 for open 24 hours. */
const lengthOf = (open: number, close: number): number => {
  const length = (close - open + 1440) % 1440;
  return length === 0 ? 1440 : length;
};

const ALL_DAY: Interval = ["00:00", "00:00"];
/** No real day has more intervals than this. More is a list of something else, and the reader stops. */
const MAX_INTERVALS = 8;

const addInterval = (
  week: Record<string, Interval[]>,
  days: readonly Day[],
  interval: Interval,
): void => {
  for (const day of days) {
    let list = week[day] ?? [];
    if (list.length >= MAX_INTERVALS) continue;
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

/** This function closes the days that nothing has stated. */
const closeDays = (week: Record<string, Interval[]>, days: readonly Day[]): void => {
  for (const day of days) if (week[day] === undefined) week[day] = [];
};

/** These words name a month. */
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";

// ── the OSM / schema.org compact syntax ─────────────────────────────────────

const OSM_DAYS = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/i;
const NAMED_DAYS = /^([a-z]{2,9})(?:-([a-z]{2,9}))?$/i;
const OSM_TIME = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\+?$/;
/** A rule for dates, not for a week: months, weeks, a year, an nth weekday, Easter. */
const DATED_RULE = new RegExp(`\\b${MONTH}(?![a-z])|\\bweek\\b|\\[|\\beaster\\b|\\b\\d{4}\\b`, "i");
const MAX_COMPACT_CHARS = 2000;

/** This function reads one OSM interval, "09:00-17:00", or gives undefined. A close past 24:00 is on the next day. */
const osmInterval = (span: string): Interval | undefined => {
  const time = OSM_TIME.exec(span);
  if (time === null) return undefined;
  const [openHour, openMinute, closeHour, closeMinute] = [time[1], time[2], time[3], time[4]].map(Number);
  if (openMinute! > 59 || closeMinute! > 59 || openHour! > 24 || closeHour! > 48) return undefined;
  return [hhmm(openHour!, openMinute!), hhmm(closeHour!, closeMinute!)];
};

/**
 * This function reads the `opening_hours` notation of OpenStreetMap, for example
 * "Mo-Th 11:00-23:00; Fr,Sa 11:00-01:00; Su off". The `openingHours` of schema.org uses the same
 * notation. A later rule replaces an earlier rule for the same days, as OpenStreetMap specifies.
 * The reader leaves out a rule for dates or holidays, and the days of a rule that it cannot read
 * stay unknown. In both cases the result is `partial`.
 */
export const fromCompact = (value: string, from: "osm" | "jsonld" = "osm"): Hours | undefined => {
  if (value.length > MAX_COMPACT_CHARS) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  const week: Record<string, Interval[]> = {};
  if (text === "24/7") {
    addInterval(week, DAYS, ALL_DAY);
    return { week, from, raw: value, inferred: false };
  }
  let partial = false;
  let inferred = false;
  // a quoted comment ("breakfast", "kitchen closes at 10") says nothing a
  // parser can use. ";" and "||" start a rule that replaces what earlier
  // rules said about its days; "," after a time starts an additional rule,
  // which adds to them ("Mo-Fr 11:00-21:00, Sa-Su 12:00-20:00", a common
  // shape in OSM); a day after a time starts a rule too ("Mo-Fr 09:00-17:00 Sa 10:00-14:00")
  const rules = text
    .replace(/"[^"]*"/g, " ")
    .replace(/(\d) (?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b)/gi, "$1; ")
    .split(/ ?(?:;|\|\|) ?/)
    .flatMap((rule) =>
      rule
        .split(/(?<=\d:\d{2}\+?) ?, ?(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b)/i)
        .map((part, index) => ({ part: part.trim(), additional: index > 0 })),
    )
    .filter(({ part }) => part.length > 0);
  let read = false;
  for (const { part: rule, additional } of rules) {
    if (DATED_RULE.test(rule)) {
      // an exception for dates ("Dec 25 off") or a season is not the week
      partial = true;
      continue;
    }
    // the days ("Mo-Fr", "Tu,Th", "Monday-Friday", ", Tu"), then the times
    const parts = /^[\s,]*([A-Za-z]{1,9}(?:-[A-Za-z]{1,9})?(?: ?, ?[A-Za-z]{1,9}(?:-[A-Za-z]{1,9})?)*)? ?:? ?(.*)$/s.exec(
      rule,
    );
    let dayPart = (parts?.[1] ?? "").replace(/\s/g, "");
    let timePart = (parts?.[2] ?? "").trim();
    if (timePart.length === 0 && /^(off|closed|open)$/i.test(dayPart)) {
      timePart = dayPart;
      dayPart = "";
    }
    let days: Day[] = [...DAYS];
    if (dayPart.length > 0) {
      days = [];
      let holidays = false;
      let unreadable = false;
      // empty pieces too: Squarespace writes ", Tu 16:00-21:00, ... Sa 16:00-21:00, "
      for (const piece of dayPart.split(",").filter((part) => part.length > 0)) {
        // public and school holidays are not part of a week: "PH off" says
        // nothing about a Tuesday, and "Su,PH 11:00-18:00" still says Sunday
        if (/^(PH|SH)$/i.test(piece)) {
          holidays = true;
          continue;
        }
        const range = OSM_DAYS.exec(piece) ?? NAMED_DAYS.exec(piece);
        const first = range === null ? undefined : dayOf(range[1]!);
        const last = range === null ? undefined : dayOf(range[2] ?? range[1]!);
        if (first === undefined || last === undefined) {
          unreadable = true;
          break;
        }
        days.push(...dayRange(first, last));
      }
      if (unreadable) {
        partial = true;
        continue;
      }
      if (days.length === 0) {
        if (holidays) partial = true;
        continue;
      }
    }
    if (timePart.length === 0 || /^open$/i.test(timePart)) {
      partial = true;
      continue;
    }
    // a later rule replaces what earlier ones said about these days
    if (!additional) for (const day of days) delete week[day];
    if (/^(off|closed)$/i.test(timePart)) {
      // an additional "off" closes its days too ("Mo-Fr 09:00-17:00, We off")
      for (const day of days) delete week[day];
      closeDays(week, days);
      read = true;
      continue;
    }
    const intervals: Interval[] = [];
    for (const span of timePart.split(/ ?, ?/).filter((part) => part.length > 0)) {
      const interval = osmInterval(span);
      if (interval !== undefined) {
        intervals.push(interval);
        continue;
      }
      // "9am-5pm" in a field that wants "09:00-17:00"
      const parts = splitRange(span);
      const range = parts === undefined ? undefined : readRange(parts[0], parts[1]);
      if (range === undefined) {
        intervals.length = 0;
        break;
      }
      inferred ||= range.inferred;
      intervals.push(range.interval);
    }
    if (intervals.length === 0) {
      // "sunrise-sunset", "25:99": these days stay unknown, never guessed
      for (const day of days) delete week[day];
      partial = true;
      continue;
    }
    for (const interval of intervals) addInterval(week, days, interval);
    read = true;
  }
  if (!read || Object.keys(week).length === 0) return undefined;
  return { week, from, raw: value, inferred, ...(partial ? { partial } : {}) };
};

// ── schema.org JSON-LD ──────────────────────────────────────────────────────

const SCHEMA_DAY = /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i;

/** This function reads a schema.org time: "17:00", "17:00:00", "17:00:00-05:00" or "5:00 PM". */
const clockOf = (value: unknown): { readonly minutes: number; readonly raw: string } | undefined => {
  if (typeof value !== "string") return undefined;
  const raw = value.trim().slice(0, 40);
  const match =
    /^(\d{1,2})(?::(\d{2}))?(?::\d{2}(?:\.\d+)?)?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:z|[+-]\d{2}:?\d{2})?$/i.exec(raw);
  if (match === null) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (minute > 59 || hour > 24 || (hour === 24 && minute > 0)) return undefined;
  const meridiem = match[3]?.toLowerCase().startsWith("p") === true ? "pm" : match[3] === undefined ? undefined : "am";
  if (meridiem !== undefined) {
    if (hour === 0 || hour > 12) return undefined;
    hour = meridiem === "am" ? hour % 12 : (hour % 12) + 12;
  }
  return { minutes: hour * 60 + minute, raw };
};

/** This function gives the days of a `dayOfWeek`: a name, a URL, an `@id` or a short name. */
const daysOfSpec = (raw: unknown): { readonly days: Day[]; readonly holidays: boolean } => {
  const values = Array.isArray(raw) ? raw : [raw];
  const days: Day[] = [];
  let holidays = false;
  for (const value of values) {
    const name =
      typeof value === "string"
        ? value
        : value !== null && typeof value === "object"
          ? (value as Record<string, unknown>)["@id"]
          : undefined;
    if (typeof name !== "string") continue;
    if (/PublicHolidays$/i.test(name.trim())) {
      holidays = true;
      continue;
    }
    const full = SCHEMA_DAY.exec(name.trim());
    const day = full === null ? dayOf(name.trim().replace(/^.*[/#:]/, "")) : dayOf(full[1]!);
    if (day !== undefined) days.push(day);
  }
  return { days, holidays };
};

/** The text of a date of schema.org, or an empty string for a value that is not text. */
const dateText = (value: unknown): string => (typeof value === "string" ? value : "");

const dateOf = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value.trim().slice(0, 40));
  return Number.isNaN(time) ? undefined : time;
};

/**
 * This function reads the hours of one JSON-LD object, for example a `Restaurant`. It reads the
 * `openingHoursSpecification` first, and the `openingHours` when there is no specification. In
 * schema.org, a closed day has the same opening and closing time, 00:00, and 00:00 to 24:00 is
 * open 24 hours.
 *
 * A specification for less than a week (`validFrom` to `validThrough`) is a holiday: the reader
 * leaves it out. When specifications hold for different seasons, the option `at` picks the
 * season of that date. With no date, the reader keeps the specifications with no season, or else
 * the first season, and it names the season.
 */
export const fromSchemaOrg = (
  record: Readonly<Record<string, unknown>>,
  options: { readonly at?: string | Date | undefined } = {},
): Hours | undefined => {
  const specs = record["openingHoursSpecification"];
  const list = (Array.isArray(specs) ? specs : specs !== undefined && specs !== null ? [specs] : [])
    .slice(0, 200)
    .filter((spec): spec is Record<string, unknown> => spec !== null && typeof spec === "object");
  if (list.length > 0) {
    let partial = false;
    const at = options.at === undefined ? undefined : new Date(options.at).getTime();
    const windowed = list.map((entry) => {
      const fromDate = dateOf(entry["validFrom"]);
      const throughDate = dateOf(entry["validThrough"]);
      const key =
        fromDate === undefined && throughDate === undefined
          ? undefined
          : `${dateText(entry["validFrom"])}/${dateText(entry["validThrough"])}`;
      const short =
        fromDate !== undefined && throughDate !== undefined && throughDate - fromDate < 7 * 86_400_000;
      return { entry, key, fromDate, throughDate, short };
    });
    if (windowed.some(({ short }) => short)) partial = true;
    const seasonal = windowed.filter(({ short }) => !short);
    let season: string | undefined;
    let chosen = seasonal.filter(({ key }) => key === undefined);
    if (at !== undefined && !Number.isNaN(at)) {
      const now = seasonal.filter(
        ({ key, fromDate, throughDate }) =>
          key !== undefined && (fromDate ?? -Infinity) <= at && at <= (throughDate ?? Infinity) + 86_399_999,
      );
      if (now.length > 0) {
        season = now[0]!.key;
        chosen = [...chosen, ...now.filter(({ key }) => key === season)];
      }
    } else if (chosen.length === 0) {
      season = seasonal.find(({ key }) => key !== undefined)?.key;
      chosen = seasonal.filter(({ key }) => key === season);
    }
    if (seasonal.some(({ key }) => key !== undefined && key !== season)) partial = true;
    const week: Record<string, Interval[]> = {};
    for (const { entry } of chosen) {
      const { days, holidays } = daysOfSpec(entry["dayOfWeek"]);
      if (holidays) partial = true;
      const opens = clockOf(entry["opens"]);
      const closes = clockOf(entry["closes"]);
      if (days.length === 0 || opens === undefined || closes === undefined) {
        if (days.length > 0) partial = true;
        continue;
      }
      const allDay =
        opens.minutes === 0 && (closes.raw.startsWith("24:00") || closes.minutes === 23 * 60 + 59);
      if (allDay) {
        addInterval(week, days, ALL_DAY);
      } else if (opens.minutes === closes.minutes) {
        // 00:00 to 00:00 is closed; 09:00 to 09:00 says nothing certain
        if (opens.minutes === 0) {
          for (const day of days) delete week[day];
          closeDays(week, days);
        } else {
          partial = true;
        }
      } else {
        addInterval(week, days, [fromMinutes(opens.minutes), fromMinutes(closes.minutes % 1440)]);
      }
    }
    if (Object.keys(week).length > 0) {
      return {
        week,
        from: "jsonld",
        raw: JSON.stringify(list).slice(0, 500),
        inferred: false,
        ...(partial ? { partial } : {}),
        ...(season !== undefined ? { season } : {}),
      };
    }
  }
  const compact = record["openingHours"];
  const strings = (Array.isArray(compact) ? compact : [compact])
    .filter((value): value is string => typeof value === "string")
    .slice(0, 50);
  if (strings.length === 0) return undefined;
  // schema.org writes one rule per string; a comma inside one is a day list
  // ("Tu,Th 16:00-20:00") or, after a time, another rule, as in OSM
  const joined = strings.join("; ");
  const parsed = fromCompact(joined, "jsonld") ?? textFallback(joined);
  return parsed === undefined ? undefined : { ...parsed, raw: strings.join(", ") };
};

/** This function reads an `openingHours` value that is not in the compact notation ("Monday-Friday 9am-5pm"). */
const textFallback = (value: string): Hours | undefined => {
  const [found] = fromText(value.replace(/;/g, "\n"));
  if (found === undefined) return undefined;
  const { label: _label, ...hours } = found;
  return { ...hours, from: "jsonld" };
};

// ── free text ───────────────────────────────────────────────────────────────

const DAY_WORD =
  "(?:mon(?:day)?s?|tue(?:s(?:day)?)?s?|wed(?:s|nesday)?s?|thu(?:r(?:s(?:day)?)?)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?)\\.?";
/** These short day names count only in a span with a dash ("M-F", "Tu-Th", "Mo-Fr"). */
const SHORT_DAY = "(?:mo|tu|we|th|fr|sa|su|m|w|f)";
/** A dash of any kind joins a range. U+FFFD is a dash that a wrong decoder lost. */
const DASH = "[-\\u2010-\\u2015\\u2212~\\u301c\\ufffd]";
const RANGE_SEP = `\\s?(?:${DASH}|to|thru|through|until|till|['’]til|til)\\s?`;
const TIME =
  "(?:12\\s?(?:midnight|noon|mn|nn)\\b|\\d{1,2}(?:[:.]\\d{2}|h(?:\\d{2})?(?![a-z]))?(?:\\s?(?:a\\.?m\\.?|p\\.?m\\.?))?|noon|midnight)";
/** This pattern is one time with am or pm: "7:00 am". */
const CLOCK = "(?:12\\s?(?:midnight|noon)\\b|\\d{1,2}(?:[:.]\\d{2})?\\s?(?:a\\.?m\\.?|p\\.?m\\.?)|noon|midnight)";
/** "Open 24 hours", "24/7": open all day. "Within 24 hours" and "24 hours notice" are not. */
const ALL_DAY_WORDS =
  "(?:open\\s)?(?<!(?:within|in|for|last|past|next|every|after|than)\\s)(?:24\\s?(?:hours|hrs?|h)\\b(?!\\s?(?:notice|in advance|advance|prior|before|ahead|later|turnaround|delivery|of|to|from))|24\\s?\\/\\s?7\\b|around the clock)";

const TOKEN = new RegExp(
  [
    `(?<allday>\\b${ALL_DAY_WORDS})`,
    `(?<every>\\b(?:daily|every\\s?day|everyday|7\\s?days(?:\\s?a\\s?week)?|seven\\s?days(?:\\s?a\\s?week)?)\\b)`,
    `(?<weekdays>\\bweekdays?\\b)`,
    `(?<weekends>\\bweekends?\\b)`,
    // "except Monday", "but Sunday": the days after it are closed
    `(?<except>\\b(?:except(?:\\s(?:on|for))?|but(?:\\snot)?(?:\\son)?|excluding|other\\sthan|apart\\sfrom)(?=\\s(?:${DAY_WORD}|weekends?|weekdays?)(?![a-z])))`,
    `(?<span>\\b(?:${DAY_WORD}${RANGE_SEP}${DAY_WORD}|(?:${DAY_WORD}|${SHORT_DAY})\\s?${DASH}\\s?(?:${DAY_WORD}|${SHORT_DAY}))(?![a-z]))`,
    // "Sun-dried tomato" and "Sunday's game" name no day
    `(?<day>\\b${DAY_WORD}(?![a-z])(?!-(?!closed)[a-z])(?!['’]s\\b))`,
    `(?<times>(?<![\\d:.$€£¥])${TIME}${RANGE_SEP}${TIME}(?!\\d))`,
    // a meridiem ends its word: "73 Ames St" is no clock
    `(?<clock>(?<![\\d:.$€£¥])${CLOCK}(?![a-z\\d]))`,
    `(?<closed>\\bclosed\\b)`,
  ].join("|"),
  "gi",
);

interface Clock {
  readonly hour: number;
  readonly minute: number;
  readonly meridiem: "am" | "pm" | undefined;
  /** This value is true when the time uses the 24-hour clock ("17:00", "09:30", "9h"). */
  readonly h24: boolean;
}

const readClock = (value: string): Clock | undefined => {
  const text = value.trim().toLowerCase();
  if (/^(?:12\s?)?(?:noon|nn)$/.test(text)) return { hour: 12, minute: 0, meridiem: "pm", h24: false };
  if (/^(?:12\s?)?(?:midnight|mn)$/.test(text)) {
    return { hour: 12, minute: 0, meridiem: "am", h24: false };
  }
  const match = /^(\d{1,2})(?:[:.](\d{2})|(h)(\d{2})?)?\s?(a\.?m\.?|p\.?m\.?)?$/.exec(text);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? match[4] ?? 0);
  if (hour > 24 || minute > 59 || (hour === 24 && minute > 0)) return undefined;
  let meridiem: "am" | "pm" | undefined =
    match[5] === undefined ? undefined : match[5].startsWith("a") ? "am" : "pm";
  // "17:00 pm" is written in haste: the clock says it all
  if (meridiem !== undefined && (hour === 0 || hour > 12)) meridiem = undefined;
  return {
    hour,
    minute,
    meridiem,
    h24:
      meridiem === undefined &&
      (hour > 12 || hour === 0 || match[1]!.startsWith("0") || match[3] !== undefined),
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

const flip = (meridiem: "am" | "pm"): "am" | "pm" => (meridiem === "am" ? "pm" : "am");

/** The longest opening that a guess can give, in minutes. */
const MAX_GUESS_MINUTES = 16 * 60;

/** This function reads a range with a 24-hour time. A bare number on the other side is the reading that makes sense. */
const read24 = (
  a: Clock,
  b: Clock,
): { readonly interval: Interval; readonly inferred: boolean } | undefined => {
  const options = (clock: Clock): number[] =>
    clock.h24 || clock.meridiem !== undefined
      ? [clock.meridiem === undefined ? clock.hour % 24 : to24(clock, clock.meridiem)]
      : clock.hour === 12
        ? [12, 0]
        : [clock.hour, clock.hour + 12];
  const candidates: Array<{ open: number; close: number; length: number; written: boolean }> = [];
  for (const [aIndex, openHour] of options(a).entries()) {
    for (const [bIndex, closeHour] of options(b).entries()) {
      const open = openHour * 60 + a.minute;
      const close = closeHour * 60 + b.minute;
      candidates.push({ open, close, length: lengthOf(open, close), written: aIndex === 0 && bIndex === 0 });
    }
  }
  const stated = a.h24 && b.h24;
  if (stated) {
    const [only] = candidates;
    // "21-14" is a score, not a night: an opening past midnight ends in the morning
    if (only === undefined || (only.close <= only.open && only.close > 12 * 60)) return undefined;
    return { interval: [fromMinutes(only.open), fromMinutes(only.close)], inferred: false };
  }
  // the reading as written first, then: within the day and three hours or
  // more, three hours or more, within the day, anything sensible
  const sensible = candidates
    .filter(({ length }) => length >= 60 && length <= MAX_GUESS_MINUTES)
    .sort((x, y) => Number(y.written) - Number(x.written));
  const best =
    sensible.find(({ close, open, length }) => close > open && length >= 180) ??
    sensible.find(({ length }) => length >= 180) ??
    sensible.find(({ close, open }) => close > open) ??
    sensible[0];
  if (best === undefined) return undefined;
  return { interval: [fromMinutes(best.open), fromMinutes(best.close)], inferred: !best.written };
};

/**
 * This function reads a range of two times, as a restaurant writes it:
 *
 * - "5-10pm" is 17:00-22:00, and "11-3pm" is 11:00-15:00. The opening gets the am or pm of the
 *   close, but not when that puts the opening after the close.
 * - "11-1am" is 11:00-01:00, because 23:00-01:00 is too short to be the meaning. The result is
 *   then `inferred`.
 * - "11am-10" closes at 22:00.
 * - With no am, pm or 24-hour time ("11-9"), an opening before 7 is pm, but "6-2" is 06:00-14:00.
 *   A close at or before the opening is pm, and "7-12" closes at noon. The result is then
 *   `inferred`, and it is not longer than 16 hours.
 * - "21-14" is no range: a 24-hour opening past midnight does not end after noon.
 */
export const readRange = (
  start: string,
  end: string,
): { readonly interval: Interval; readonly inferred: boolean } | undefined => {
  const a = readClock(start);
  const b = readClock(end);
  if (a === undefined || b === undefined) return undefined;
  if (a.h24 || b.h24) return read24(a, b);
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
    const other = to24(a, flip(b.meridiem));
    const closeAt = close * 60 + b.minute;
    if (same * 60 + a.minute < closeAt) {
      open = same;
      // "12-1am" opens at noon: an hour from midnight is no opening
      if (a.hour === 12 && b.meridiem === "am" && lengthOf(same * 60 + a.minute, closeAt) <= 120) {
        open = 12;
        inferred = true;
      }
    } else if (
      lengthOf(other * 60 + a.minute, closeAt) <= 180 &&
      lengthOf(same * 60 + a.minute, closeAt) <= 18 * 60
    ) {
      // "11-1am": a bar open from 11am, not for two hours from 11pm
      open = same;
      inferred = true;
    } else {
      open = other;
    }
  } else if (a.meridiem !== undefined) {
    open = to24(a, a.meridiem);
    const same = to24(b, a.meridiem);
    close = same > open ? same : to24(b, flip(a.meridiem));
  } else {
    // no meridiem anywhere: read as a restaurant would mean it, and say so.
    // An opening before 7 is evening ("5-10"), but a diner's "6-2" is
    // daytime. A close at or before the opening, or within three hours of a
    // morning one ("10-11"), is pm; a close of 12 after a morning opening is noon
    inferred = true;
    open =
      a.hour === 12 ? 12 : a.hour >= 7 || (a.hour >= 5 && b.hour >= 1 && b.hour <= 3) ? a.hour : a.hour + 12;
    if (b.hour === 12) close = open < 12 ? 12 : 0;
    else if (open < 12) close = b.hour <= a.hour || b.hour - open < 3 ? b.hour + 12 : b.hour;
    else close = b.hour + 12 > open ? b.hour + 12 : b.hour;
  }
  const openAt = open * 60 + a.minute;
  const closeAt = close * 60 + b.minute;
  if (inferred && lengthOf(openAt, closeAt) > MAX_GUESS_MINUTES) return undefined;
  return { interval: [fromMinutes(openAt % 1440), fromMinutes(closeAt % 1440)], inferred };
};

const splitRange = (value: string): [string, string] | undefined => {
  const match = new RegExp(`^(${TIME})${RANGE_SEP}(${TIME})$`, "i").exec(
    value.replace(/\s+/g, " ").trim().slice(0, 80),
  );
  return match === null ? undefined : [match[1]!, match[2]!];
};

/** This function gives the days of a token and how specific it is: 0 for "daily", 1 for a span, 2 for one day. */
const daysOfToken = (
  groups: Record<string, string | undefined>,
): { readonly days: Day[]; readonly spec: number } | undefined => {
  if (groups["every"] !== undefined) return { days: [...DAYS], spec: 0 };
  if (groups["weekdays"] !== undefined) return { days: ["mon", "tue", "wed", "thu", "fri"], spec: 0 };
  if (groups["weekends"] !== undefined) return { days: ["sat", "sun"], spec: 0 };
  if (groups["span"] !== undefined) {
    const [from, to] = groups["span"].split(new RegExp(RANGE_SEP, "i"));
    const first = from === undefined ? undefined : dayOf(from.trim());
    const last = to === undefined ? undefined : dayOf(to.trim());
    return first === undefined || last === undefined ? undefined : { days: dayRange(first, last), spec: 1 };
  }
  if (groups["day"] !== undefined) {
    const day = dayOf(groups["day"]);
    return day === undefined ? undefined : { days: [day], spec: 2 };
  }
  return undefined;
};

/** A date names one day of the year, not a day of the week: "Dec 24", "24 December", "12/24", "2026-12-24". */
const DATE = new RegExp(
  `\\b${MONTH}\\s?\\d{1,2}(?:st|nd|rd|th)?\\b(?!:\\d|\\s?[ap]\\.?m\\b)|\\b\\d{1,2}(?:st|nd|rd|th)?\\s(?:of\\s)?${MONTH}(?![a-z])|(?<![\\d/])\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?(?![\\d/])|\\b\\d{4}-\\d{2}-\\d{2}\\b`,
  "i",
);
const DATE_RANGE = new RegExp(
  `\\b${MONTH}(?:\\s?\\d{1,2}(?:st|nd|rd|th)?)?${RANGE_SEP}${MONTH}(?:\\s?\\d{1,2}(?:st|nd|rd|th)?)?(?![a-z])`,
  "i",
);
/** These words tell that a line is for one occasion, not for the week. */
const OCCASION =
  /\b(?:holidays?|christmas|xmas|thanksgiving|easter|hanukkah|new year['’]?s?|nye|memorial day|labou?r day|independence day|valentine['’]?s|mother['’]?s day|father['’]?s day|private (?:events?|parties|party|hire|dining)|special events?|events? only|today|tonight)\b/i;
const SEASON =
  /^(?:summer|winter|spring|autumn|fall|off[- ]?season|high season|low season|peak season)\b|\b(?:summer|winter|spring|autumn|fall|off[- ]?season)(?=\s?(?:hours|schedule|season|:|\())/i;

/** This function names the season of a line ("Summer", "June-August"), or gives undefined. */
const seasonOf = (line: string): string | undefined =>
  (SEASON.exec(line) ?? DATE_RANGE.exec(line))?.[0].trim();

/** The longest line that can hold hours. A longer line is prose, and the reader does not read it. */
const MAX_LINE = 1000;
/** A block of hours longer than this is a list of something else. */
const MAX_BLOCK_LINES = 100;

const normalize = (line: string): string =>
  line
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "")
    .replace(/\s+/g, " ")
    .trim();

interface Token {
  readonly groups: Record<string, string | undefined>;
  /** This is the line of the token in its block. */
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly days: Day[] | undefined;
  readonly spec: number;
}

const tokensOf = (line: string, at: number): Token[] =>
  line.length > MAX_LINE
    ? []
    : [...line.matchAll(TOKEN)].map((match) => {
        const groups = match.groups ?? {};
        const days = daysOfToken(groups);
        return {
          groups,
          line: at,
          start: match.index ?? 0,
          end: (match.index ?? 0) + match[0].length,
          days: days?.days,
          spec: days?.spec ?? 2,
        };
      });

/** A range with no am, pm, minutes or "h" is a bare range ("5-10"): it can be a price, an age or a score. */
const isStrong = (times: string): boolean => /[ap]\.?m|[:.]\d{2}|noon|midnight|\dh/i.test(times);

/** The words that join days or a day and its hours, and say nothing more. */
const JOINERS = /^(?:[\s,&/:;.()|–—-]|\band\b|\bor\b|\bfrom\b|\bopen\b|\bhours\b)*$/i;

/**
 * This function reads the hours in the text of a page. It reads the lines with days and times as
 * one stream. Thus "Monday – Thursday" on one line and "11:30am – 9pm" on the next line go
 * together. A list of days ("Mon, Wed & Fri") waits for a time or for "closed".
 *
 * Each group of these lines is a candidate. Its label is the short line above it ("Hours",
 * "Dinner", "Happy hour"). A page often shows more than one schedule, and the choice between them
 * is a judgment, not a parse. A season ("Summer:", "June-August") starts a new candidate.
 *
 * A line about a date or an occasion ("Dec 24: 9am-2pm", "New Year's Eve 8pm-1am", "Private events
 * 11am-3pm") is not the week. The reader leaves it out, and the candidate is `partial`.
 */
export const fromText = (text: string): Array<Hours & { readonly label: string | null }> => {
  const original = text.split(/\n+/).map((line) => line.trim());
  const lines = original.map((line) => (line.length > MAX_LINE ? line : normalize(line)));
  const out: Array<Hours & { readonly label: string | null }> = [];
  let block: { start: number; lines: number[]; season: string | undefined } | undefined;
  const flush = (): void => {
    if (block === undefined) return;
    const current = block;
    block = undefined;
    const above = lines[current.start - 1] ?? "";
    const label = original[current.start - 1];
    const week: Record<string, Interval[]> = {};
    let inferred = false;
    let partial = false;
    // the most specific selector that opened or closed each day: a closed
    // Monday stays closed under "daily", but "Monday 9-12" reopens "Mon-Fri closed"
    const closedBy = new Map<Day, number>();
    const openedBy = new Map<Day, number>();
    const heading = /hour|open/i.test(above);

    const perLine = current.lines.map((index, at) => tokensOf(lines[index]!, at));
    const oneOff = current.lines.map((index, at) => {
      const line = lines[index]!.replace(/\b24 ?\/ ?7\b/g, "    ");
      const onLine = perLine[at]!;
      const weekly = onLine.some((token) => token.days !== undefined);
      // a date before the hours names the day they are for ("Dec 24: 9am-2pm");
      // one after them is a note ("Mon-Fri 9-5 (closed 12/25)")
      const date = DATE_RANGE.test(line) ? null : DATE.exec(line);
      const value = onLine.find(
        (token) => token.groups["times"] !== undefined || token.groups["clock"] !== undefined,
      );
      return (
        (date !== null && (value === undefined || date.index < value.start)) ||
        (!weekly && OCCASION.test(line))
      );
    });
    const tokens: Token[] = [];
    const breaks = new Set<number>();
    perLine.forEach((onLine, at) => {
      if (oneOff[at]) {
        // a date or an occasion: not the week, and the days above it do not reach past it
        partial = true;
        breaks.add(at);
        return;
      }
      const line = lines[current.lines[at]!]!;
      const dayTokens = onLine.filter((token) => token.days !== undefined);
      const broad =
        dayTokens.length >= 2 || dayTokens.some((token) => token.spec < 2) || heading || /^(?:hours|open)\b/i.test(line);
      const daysOnlyAbove =
        at > 0 &&
        !breaks.has(at - 1) &&
        perLine[at - 1]!.length > 0 &&
        perLine[at - 1]!.every((token) => token.days !== undefined);
      onLine.forEach((token, index) => {
        const times = token.groups["times"];
        if (times !== undefined && !isStrong(times) && !broad) {
          // a bare range counts only beside its day ("Sunday 12-9"), not
          // after other words ("Kids Club Saturdays, ages 5-10")
          const before = onLine[index - 1];
          const after = onLine[index + 1];
          const beside =
            (before?.days !== undefined && JOINERS.test(line.slice(before.end, token.start))) ||
            (after?.days !== undefined && JOINERS.test(line.slice(token.end, after.start))) ||
            (index === 0 && daysOnlyAbove && JOINERS.test(line.slice(0, token.start)));
          if (!beside) return;
        }
        tokens.push(token);
      });
    });
    const isDays = (token: Token | undefined): boolean => token?.days !== undefined;
    const isValue = (token: Token): boolean =>
      token.groups["times"] !== undefined ||
      token.groups["closed"] !== undefined ||
      token.groups["allday"] !== undefined;
    // a line whose days are followed by other words ("Monday: By appointment")
    // ends its list of days there: the next line's days do not join it
    const dangling = new Set<number>();
    perLine.forEach((onLine, at) => {
      const last = onLine.at(-1);
      if (last?.days === undefined) return;
      const line = lines[current.lines[at]!]!;
      if (!JOINERS.test(line.slice(last.end))) dangling.add(at);
    });
    // a line that starts with a value and names its days after it ("11am-9pm
    // Mon-Thu, 11am-10pm Fri-Sat", "10 AM - 8 PM daily", "Closed Mondays")
    // gives each value to the days that follow it, not the days before
    const valueFirst = new Set<number>();
    const firstOnLine = new Map<number, Token>();
    const lineHasDays = new Set<number>();
    for (const token of tokens) {
      if (isDays(token)) lineHasDays.add(token.line);
      if (!firstOnLine.has(token.line) && (isDays(token) || isValue(token))) firstOnLine.set(token.line, token);
    }
    for (const [line, first] of firstOnLine) if (isValue(first) && lineHasDays.has(line)) valueFirst.add(line);

    const apply = (value: Interval | "closed", days: readonly Day[], spec: number, explicit: boolean): void => {
      for (const day of days) {
        if (value === "closed") {
          if (!explicit) {
            // "closed" with no days of its own: only the days nothing has stated
            if (week[day] === undefined) {
              week[day] = [];
              closedBy.set(day, -1);
            }
            continue;
          }
          if ((openedBy.get(day) ?? -1) > spec) continue;
          week[day] = [];
          openedBy.delete(day);
          closedBy.set(day, Math.max(closedBy.get(day) ?? -1, spec));
          continue;
        }
        const closed = closedBy.get(day);
        // a closed day stays closed, unless the opening names it more closely
        if (closed !== undefined && closed >= spec) continue;
        if (closed !== undefined) {
          week[day] = [];
          closedBy.delete(day);
        }
        addInterval(week, [day], value);
        openedBy.set(day, Math.max(openedBy.get(day) ?? -1, spec));
      }
    };
    const valueOf = (token: Token): { value: Interval | "closed"; inferred: boolean } | undefined => {
      if (token.groups["closed"] !== undefined) return { value: "closed", inferred: false };
      if (token.groups["allday"] !== undefined) return { value: ALL_DAY, inferred: false };
      const parts = token.groups["times"] === undefined ? undefined : splitRange(token.groups["times"]);
      const range = parts === undefined ? undefined : readRange(parts[0], parts[1]);
      return range === undefined ? undefined : { value: range.interval, inferred: range.inferred };
    };
    /** This function gives the tokens of one kind in sequence from `start`, each on a separate line. */
    const runOf = (start: number, kind: (token: Token) => boolean): number => {
      let end = start;
      while (
        tokens[end + 1] !== undefined &&
        kind(tokens[end + 1]!) &&
        tokens[end + 1]!.line !== tokens[end]!.line &&
        !breaks.has(tokens[end + 1]!.line - 1)
      ) {
        end += 1;
      }
      return end;
    };

    let currentDays: Day[] = [];
    let currentSpec = 2;
    let lastWasDay = false;
    let pending: Array<{ value: Interval | "closed"; inferred: boolean }> = [];
    let excepting = false;
    let previous: Token | undefined;
    for (let at = 0; at < tokens.length; at += 1) {
      const token = tokens[at]!;
      if (previous !== undefined && token.line !== previous.line) {
        excepting = false;
        let broken = dangling.has(previous.line) && lastWasDay;
        for (let line = previous.line; line < token.line && !broken; line += 1) broken = breaks.has(line);
        if (broken) {
          currentDays = [];
          lastWasDay = false;
          pending = [];
        }
      }
      previous = token;
      if (token.groups["except"] !== undefined) {
        excepting = true;
        continue;
      }
      const days = token.days;
      if (days !== undefined) {
        if (excepting) {
          // "daily except Monday": Monday is closed, and the days to come leave it out
          apply("closed", days, 2, true);
          currentDays = currentDays.filter((day) => !days.includes(day));
          continue;
        }
        if (!lastWasDay && pending.length === 0) {
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
                  const read = valueOf(valueRun[index]!);
                  if (read === undefined) return;
                  inferred ||= read.inferred;
                  apply(read.value, dayToken.days!, dayToken.spec, true);
                });
              }
              at = lastValue;
              previous = tokens[at];
              continue;
            }
          }
        }
        currentDays = lastWasDay ? [...new Set([...currentDays, ...days])] : [...days];
        currentSpec = lastWasDay ? Math.min(currentSpec, token.spec) : token.spec;
        lastWasDay = true;
        const next = tokens[at + 1];
        // the list of days ends where the next token is not a day on this line
        if (pending.length > 0 && !(isDays(next) && next!.line === token.line)) {
          for (const read of pending) {
            inferred ||= read.inferred;
            apply(read.value, currentDays, currentSpec, true);
          }
          pending = [];
          // the list is used: the next line's days start a new one
          lastWasDay = false;
        }
        continue;
      }
      excepting = false;
      const wasDay = lastWasDay;
      lastWasDay = false;
      let read = isValue(token) ? valueOf(token) : undefined;
      if (read === undefined && token.groups["clock"] !== undefined && wasDay) {
        // a widget that writes a day, its opening and its closing on three
        // lines; a lone time anywhere else (a booking slot) is no schedule
        const close = tokens[at + 1]?.groups["clock"];
        const range = close === undefined ? undefined : readRange(token.groups["clock"], close);
        if (range !== undefined) {
          read = { value: range.interval, inferred: range.inferred };
          at += 1;
          previous = tokens[at];
        }
      }
      if (read === undefined) continue;
      const next = tokens[at + 1];
      const daysFollow = isDays(next) && next!.line === tokens[at]!.line;
      // a value before its days, or "..., closed Fri" after a schedule
      if (daysFollow && (valueFirst.has(token.line) || (read.value === "closed" && !wasDay))) {
        pending.push(read);
        continue;
      }
      if (currentDays.length > 0) {
        inferred ||= read.inferred;
        apply(read.value, currentDays, currentSpec, wasDay);
      }
    }
    // one range under an hours heading, or after "Open", with no day named
    // ("HOURS OF OPERATION: 7:00am - 10:30pm", "Open 7am-10:30pm") is every
    // day, and says it was a guess; two ranges with no days (mini golf 7-10:30,
    // batting cages 9-10) say nothing certain
    if (Object.keys(week).length === 0 && !tokens.some(isDays)) {
      const ranges = tokens.filter(
        (token) => token.groups["times"] !== undefined || token.groups["allday"] !== undefined,
      );
      const body = current.lines.map((index) => lines[index]!);
      // "Today's Hours" are one day's ("Now open" is an exhibition's)
      const oneDay = /\b(today|tonight|now)\b/i.test(`${above} ${body.join(" ")}`);
      const opens = !oneDay && (heading || /^open\b/i.test(body[0] ?? ""));
      const said = new Set(ranges.map((token) => (token.groups["times"] ?? "24h").replace(/\s+/g, "")));
      const first = ranges[0] === undefined ? undefined : valueOf(ranges[0]);
      if (opens && said.size === 1 && first !== undefined && first.value !== "closed") {
        addInterval(week, DAYS, first.value);
        // "Open 24/7" says the days itself
        inferred = !/24 ?\/ ?7/.test(ranges[0]!.groups["allday"] ?? "");
      }
    }
    if (Object.keys(week).length === 0) return;
    const season = current.season ?? (label !== undefined ? seasonOf(above) : undefined);
    out.push({
      week,
      from: "text",
      raw: current.lines.map((index) => original[index]!).join("\n"),
      inferred,
      ...(partial ? { partial } : {}),
      ...(season !== undefined ? { season } : {}),
      label: label !== undefined && label.length > 0 && label.length <= 40 ? label : null,
    });
  };
  lines.forEach((line, index) => {
    const tokens = tokensOf(line, 0);
    const names = tokens.some(
      (token) =>
        token.days !== undefined || token.groups["closed"] !== undefined || token.groups["allday"] !== undefined,
    );
    // a clock with am/pm or minutes reads as hours on its own line; a bare
    // range ("12-14 Main St") only beside a day
    const clock = tokens.some(
      (token) =>
        token.groups["clock"] !== undefined ||
        (token.groups["times"] !== undefined && isStrong(token.groups["times"])),
    );
    // a long sentence that happens to mention a day is prose, not a schedule;
    // a long line with several time ranges is a schedule written as one
    // paragraph ("Dinner: Tuesday, Wednesday and Thursday 5pm to 9pm / ...")
    const ranges = tokens.filter((token) => token.groups["times"] !== undefined).length;
    if ((names || clock) && (line.length <= 160 || ranges >= 2)) {
      // a season starts a schedule of its own ("Summer: Mon-Sun 10am-8pm")
      const season = seasonOf(line);
      if (season !== undefined || (block !== undefined && block.lines.length >= MAX_BLOCK_LINES)) flush();
      block ??= { start: index, lines: [], season };
      block.lines.push(index);
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
          : `${span} ${value
              .map(([open, close]) => (open === "00:00" && close === "00:00" ? "open 24 hours" : `${open}–${close}`))
              .join(", ")}`,
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
