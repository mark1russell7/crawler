/**
 * The opening-hours playground. It reads the text with `fromText` and `fromCompact`, the hours reader
 * of the crawler, and draws each reading as a week.
 */
import { useState, type ReactElement } from "react";
import type { Hours } from "polite-crawler/hours";
import { describeWeek, fromCompact, fromText } from "polite-crawler/hours";
import { WeekChart } from "./WeekChart.tsx";

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

/** This component shows one reading of the hours. */
const Reading = ({
  title,
  reading,
}: {
  readonly title: string;
  readonly reading: Hours & { readonly label?: string | null };
}): ReactElement => {
  const said = describeWeek(reading.week);
  return (
    <section className="pc-reading">
      <header>
        <strong>{title}</strong>
        {reading.label ? <span className="pc-tag">below “{reading.label}”</span> : null}
        {reading.inferred ? <span className="pc-tag pc-tag-guess">am or pm guessed</span> : null}
        {reading.season !== undefined ? (
          <span className="pc-tag">season: {reading.season}</span>
        ) : null}
        {reading.partial === true ? (
          <span
            className="pc-tag pc-tag-guess"
            title="The reader left out a rule or a line, for example a holiday or a date."
          >
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
        <span>
          Text from a page, with one line for each line of the page. The reader reads English only.
        </span>
        <textarea
          value={text}
          rows={5}
          spellcheck={false}
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </label>
      <div className="pc-readings" aria-live="polite">
        {failure !== undefined ? <p className="pc-empty">The reader stopped: {failure}</p> : null}
        {readings.map((reading, index) => (
          <Reading
            key={index}
            title={readings.length > 1 ? `Page text, reading ${String(index + 1)}` : "Page text"}
            reading={reading}
          />
        ))}
        {compact !== undefined ? (
          <Reading title="OpenStreetMap notation" reading={compact} />
        ) : null}
        {readings.length === 0 && compact === undefined && failure === undefined ? (
          <p className="pc-empty">
            The reader found no hours. It needs a day and a time near each other, or one range below
            an hours heading. It reads English only.
          </p>
        ) : null}
      </div>
    </div>
  );
}
