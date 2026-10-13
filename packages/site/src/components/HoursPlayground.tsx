/**
 * The opening-hours playground. It reads the text with `fromText` and `fromCompact`, the hours reader
 * of the crawler, and draws each reading as a week.
 */
import { useState, type ReactElement } from "react";
import type { Hours, Interval, Week } from "polite-crawler/hours";
import { DAYS, describeWeek, fromCompact, fromText } from "polite-crawler/hours";

const SAMPLES: readonly string[] = [
  "Mon, Tue, Wed, Thur\n4:30 PM - 9:00 PM",
  "11am-9pm Mon-Thu, 11am-10pm Fri-Sat",
  "Tue-Sun 5-10pm\nClosed Mondays",
  "HOURS OF OPERATION:\n7:00am -10:30pm",
  "Lunch\nMon-Fri 11:30-2:30\nDinner\nMon-Sat 5-10",
  "Sunday\nMonday\nTuesday\nWednesday\nThursday\nFriday\nSaturday\n11:00 am – 10:00 pm\n11:00 am – 11:00 pm\n11:00 am – 11:00 pm\n11:00 am – 11:00 pm\n11:00 am – 11:00 pm\n11:00 am – 1:00 am\n11:00 am – 1:00 am",
  "Mo-Fr 11:00-21:00, Sa-Su 12:00-20:00; PH off",
  "Summer (June to August)\nDaily 11am-10pm\nWinter\nDaily 11am-8pm",
  "Tue-Sun 5-10pm\nClosed Mondays\nClosed on holidays",
];

const LABEL: Readonly<Record<string, string>> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const minutesOf = (clock: string): number => {
  const [hours = 0, minutes = 0] = clock.split(":").map(Number);
  return hours * 60 + minutes;
};

/** An interval as minutes from midnight. A close at or before the open is on the next day. */
const span = ([open, close]: Interval): readonly [number, number] => {
  const from = minutesOf(open);
  const to = minutesOf(close);
  return [from, to <= from ? to + 1440 : to];
};

const clock12 = (minutes: number): string => {
  const hour = Math.floor(minutes / 60) % 24;
  return `${String(hour % 12 === 0 ? 12 : hour % 12)}${hour < 12 ? "a" : "p"}`;
};

/** This component draws one week, from 5 am (or earlier) to the latest close. */
const WeekChart = ({ week }: { readonly week: Week }): ReactElement => {
  let start = 5 * 60;
  let end = 24 * 60;
  for (const day of DAYS) {
    for (const interval of week[day] ?? []) {
      const [from, to] = span(interval);
      start = Math.min(start, Math.floor(from / 60) * 60);
      end = Math.max(end, Math.ceil(to / 60) * 60);
    }
  }
  const width = end - start;
  const at = (minutes: number): string => `${String(((minutes - start) / width) * 100)}%`;
  const ticks: number[] = [];
  for (let tick = Math.ceil(start / 180) * 180; tick <= end; tick += 180) ticks.push(tick);
  return (
    <div className="pc-week">
      {DAYS.map((day) => {
        const value = week[day];
        return (
          <div className="pc-week-row" key={day}>
            <span className="pc-week-day">{LABEL[day]}</span>
            <span className={`pc-week-track${value === undefined ? " pc-week-unknown" : ""}`}>
              {value === undefined ? (
                <span className="pc-week-note">not stated</span>
              ) : value.length === 0 ? (
                <span className="pc-week-note">closed</span>
              ) : (
                value.map((interval) => {
                  const [from, to] = span(interval);
                  return (
                    <span
                      key={`${interval[0]}-${interval[1]}`}
                      className="pc-week-bar"
                      style={{ left: at(from), width: `${String(((to - from) / width) * 100)}%` }}
                      title={`${LABEL[day] ?? day} ${interval[0]}–${interval[1]}`}
                    />
                  );
                })
              )}
            </span>
          </div>
        );
      })}
      <div className="pc-week-axis" aria-hidden="true">
        {ticks.map((tick) => {
          const share = (tick - start) / width;
          return (
            <span
              key={tick}
              style={{
                left: `${String(share * 100)}%`,
                transform: share < 0.06 ? "none" : share > 0.94 ? "translateX(-100%)" : "translateX(-50%)",
              }}
            >
              {clock12(tick)}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** This component shows one reading of the hours. */
const Reading = ({ title, reading }: { readonly title: string; readonly reading: Hours & { readonly label?: string | null } }): ReactElement => {
  const said = describeWeek(reading.week);
  return (
    <section className="pc-reading">
      <header>
        <strong>{title}</strong>
        {reading.label ? <span className="pc-tag">below “{reading.label}”</span> : null}
        {reading.inferred ? <span className="pc-tag pc-tag-guess">am or pm guessed</span> : null}
        {reading.season !== undefined ? <span className="pc-tag">season: {reading.season}</span> : null}
        {reading.partial === true ? (
          <span className="pc-tag pc-tag-guess" title="The reader left out a rule or a line, for example a holiday or a date.">
            a rule left out
          </span>
        ) : null}
      </header>
      <p className="pc-reading-says">{said === "" ? "no days" : said}</p>
      <WeekChart week={reading.week} />
    </section>
  );
};

/** The playground. */
export default function HoursPlayground(): ReactElement {
  const [text, setText] = useState(SAMPLES[0]!);
  let readings: Array<Hours & { readonly label: string | null }> = [];
  let failure: string | undefined;
  try {
    readings = fromText(text);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  let compact: Hours | undefined;
  try {
    compact = fromCompact(text.trim());
  } catch {
    compact = undefined;
  }
  return (
    <div className="pc-tool not-content">
      <div className="pc-presets" role="group" aria-label="Examples">
        {SAMPLES.map((sample) => (
          <button
            key={sample}
            type="button"
            className="pc-chip pc-chip-code"
            aria-pressed={text === sample}
            onClick={() => setText(sample)}
          >
            {sample.split("\n").slice(0, 2).join(" ⏎ ")}
            {sample.split("\n").length > 2 ? " …" : ""}
          </button>
        ))}
      </div>
      <label className="pc-field">
        <span>Text from a page, with one line for each line of the page. The reader reads English only.</span>
        <textarea value={text} rows={5} spellcheck={false} onChange={(event) => setText(event.currentTarget.value)} />
      </label>
      <div className="pc-readings" aria-live="polite">
        {failure !== undefined ? <p className="pc-empty">The reader stopped: {failure}</p> : null}
        {readings.map((reading, index) => (
          <Reading key={index} title={readings.length > 1 ? `Page text, reading ${String(index + 1)}` : "Page text"} reading={reading} />
        ))}
        {compact !== undefined ? <Reading title="OpenStreetMap notation" reading={compact} /> : null}
        {readings.length === 0 && compact === undefined && failure === undefined ? (
          <p className="pc-empty">
            The reader found no hours. It needs a day and a time near each other, or one range below an hours heading. It reads English only.
          </p>
        ) : null}
      </div>
    </div>
  );
}
