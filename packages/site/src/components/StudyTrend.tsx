/**
 * The trend of the robots.txt study: for each main AI agent, the share of the sites that answered
 * that refuse it, in each monthly run. The page gives the trend at build time, so the chart is in
 * the HTML of the page. In the browser, a reader can point at a run, or move with the arrow keys, to
 * see each value of that run.
 */
import {
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import type { Trend } from "../lib/runs.ts";
import { markOffsets } from "../lib/runs.ts";

/**
 * The shape of the mark of each series, in the sequence of the series. The training crawlers have a
 * solid mark and the agents for a person have an outline, so the series differ without color.
 */
const SHAPES = ["circle", "square", "diamond", "triangle", "ring", "box"] as const;

/** The space in pixels between two near marks of the same run. */
const DODGE = 11;

const share = (value: number | undefined): string =>
  value === undefined ? "–" : `${value.toFixed(1)}%`;

export function TrendChart({ trend }: { readonly trend: Trend }): ReactElement {
  const { runs, series, max } = trend;
  const [at, setAt] = useState<number | undefined>(undefined);
  const top = (value: number): number => 100 - (value / max) * 100;
  const valueAt = (slot: number, run: number): number | undefined =>
    series[slot - 1]?.points.find((point) => point.run === run)?.share;

  /** This function gives the run that is nearest to a position on the axis, from 0 to 100. */
  const nearest = (x: number): number =>
    runs.reduce(
      (best, run, index) =>
        Math.abs(run.x - x) < Math.abs((runs[best]?.x ?? 0) - x) ? index : best,
      0,
    );

  const onMove = (event: PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width > 0) setAt(nearest(((event.clientX - box.left) / box.width) * 100));
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const last = runs.length - 1;
    const now = at ?? last;
    const next: Record<string, number> = {
      ArrowLeft: Math.max(0, now - 1),
      ArrowRight: Math.min(last, now + 1),
      Home: 0,
      End: last,
    };
    if (event.key in next) {
      event.preventDefault();
      setAt(next[event.key]);
    } else if (event.key === "Escape") setAt(undefined);
  };

  // the marks that are near in one run move apart, so that each stays in view
  const offsets = markOffsets(trend);

  const every = Math.max(1, Math.ceil(runs.length / 6));
  const current = at === undefined ? undefined : runs[at];
  const readout =
    current === undefined || at === undefined
      ? ""
      : `${current.day}: ${series.map((entry) => `${entry.token} ${share(valueAt(entry.slot, at))}`).join(", ")}`;
  const anchor =
    current === undefined
      ? ""
      : current.x < 30
        ? " pc-trend-tip-start"
        : current.x > 70
          ? " pc-trend-tip-end"
          : "";

  return (
    <figure className="pc-chart pc-study-chart pc-trend not-content">
      <figcaption>
        The share of the sites that answered that refuse each agent, in each run
        <span className="pc-chart-muted"> in %</span>
      </figcaption>
      <ul className="pc-chart-legend pc-trend-legend">
        {series.map((entry) => (
          <li key={entry.token}>
            <span className={`pc-trend-key pc-trend-s${String(entry.slot)}`} aria-hidden="true">
              <span className={`pc-trend-mark pc-trend-${SHAPES[entry.slot - 1] ?? "circle"}`} />
            </span>
            <code>{entry.token}</code>
            <strong>{share(at === undefined ? entry.latest : valueAt(entry.slot, at))}</strong>
          </li>
        ))}
      </ul>
      <div className="pc-trend-frame">
        <div className="pc-trend-y" aria-hidden="true">
          {trend.ticks.map((tick) => (
            <span key={tick} style={{ bottom: `${String((tick / max) * 100)}%` }}>
              {tick}%
            </span>
          ))}
        </div>
        <div
          className="pc-trend-plot"
          role="group"
          tabIndex={0}
          aria-label={`The share that refuses each agent in ${String(runs.length)} ${runs.length === 1 ? "run" : "runs"}. Use the arrow keys to move from run to run. The table below gives each value.`}
          onPointerMove={onMove}
          onPointerLeave={() => setAt(undefined)}
          onFocus={() => setAt(at ?? runs.length - 1)}
          onBlur={() => setAt(undefined)}
          onKeyDown={onKey}
        >
          <div className="pc-trend-grid" aria-hidden="true">
            {trend.ticks.map((tick) => (
              <span
                key={tick}
                className={tick === 0 ? "pc-trend-base" : undefined}
                style={{ bottom: `${String((tick / max) * 100)}%` }}
              />
            ))}
          </div>
          <svg
            className="pc-trend-lines"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {series.map((entry) =>
              entry.points.length > 1 ? (
                <polyline
                  key={entry.token}
                  className={`pc-trend-line pc-trend-s${String(entry.slot)}`}
                  vectorEffect="non-scaling-stroke"
                  points={entry.points
                    .map(
                      (point) => `${String(runs[point.run]?.x ?? 0)},${String(top(point.share))}`,
                    )
                    .join(" ")}
                />
              ) : null,
            )}
          </svg>
          {current !== undefined ? (
            <span
              className="pc-trend-cross"
              style={{ left: `${String(current.x)}%` }}
              aria-hidden="true"
            />
          ) : null}
          {series.flatMap((entry) =>
            entry.points.map((point) => (
              <span
                key={`${entry.token}:${String(point.run)}`}
                className={`pc-trend-mark pc-trend-${SHAPES[entry.slot - 1] ?? "circle"} pc-trend-s${String(entry.slot)}${point.run === at ? " pc-hover" : ""}`}
                style={
                  {
                    left: `${String(runs[point.run]?.x ?? 0)}%`,
                    top: `${String(top(point.share))}%`,
                    "--dodge": `${String((offsets[`${String(entry.slot)}:${String(point.run)}`] ?? 0) * DODGE)}px`,
                  } as CSSProperties
                }
                aria-hidden="true"
              />
            )),
          )}
          {current !== undefined && at !== undefined ? (
            <div
              className={`pc-tip pc-trend-tip${anchor}`}
              role="tooltip"
              style={{ left: `${String(current.x)}%` }}
            >
              <span className="pc-trend-tip-day">
                {current.day}, {current.answered} sites
              </span>
              {series.map((entry) => (
                <span key={entry.token} className="pc-trend-tip-row">
                  <span
                    className={`pc-trend-tip-key pc-trend-s${String(entry.slot)}`}
                    aria-hidden="true"
                  />
                  <strong>{share(valueAt(entry.slot, at))}</strong>
                  <code>{entry.token}</code>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="pc-trend-x" aria-hidden="true">
          {runs.map((run, index) =>
            index % every === 0 || index === runs.length - 1 ? (
              <span
                key={run.version}
                className={
                  runs.length === 1
                    ? undefined
                    : run.x < 5
                      ? "pc-trend-x-start"
                      : run.x > 95
                        ? "pc-trend-x-end"
                        : undefined
                }
                style={{ left: `${String(run.x)}%` }}
              >
                {run.label}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <p className="pc-sr" aria-live="polite">
        {readout}
      </p>
      {trend.next !== undefined ? (
        <p className="pc-chart-muted pc-trend-note">
          So far, each agent has one point. The trend starts with the next run, in {trend.next}.
        </p>
      ) : null}
      <details className="pc-table-view">
        <summary>Show the numbers as a table</summary>
        <div
          className="pc-table-wrap"
          tabIndex={0}
          role="region"
          aria-label="The share that refuses each agent, in each run"
        >
          <table className="pc-table">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Sites that answered</th>
                {series.map((entry) => (
                  <th key={entry.token} scope="col">
                    <code>{entry.token}</code>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((run, index) => (
                <tr key={run.version}>
                  <th scope="row">{run.day}</th>
                  <td>{run.answered}</td>
                  {series.map((entry) => (
                    <td key={entry.token}>{share(valueAt(entry.slot, index))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
