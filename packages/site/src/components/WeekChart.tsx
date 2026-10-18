/**
 * The week of a reading of the hours: one bar for each interval of each day, from 5 am (or earlier)
 * to the latest close. The opening-hours parser and the recipe reader use it.
 */
import type { ReactElement } from "react";
import type { Interval, Week } from "polite-crawler/hours";
import { DAYS } from "polite-crawler/hours";

export const LABEL: Readonly<Record<string, string>> = {
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
export const WeekChart = ({ week }: { readonly week: Week }): ReactElement => {
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
                transform:
                  share < 0.06 ? "none" : share > 0.94 ? "translateX(-100%)" : "translateX(-50%)",
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
