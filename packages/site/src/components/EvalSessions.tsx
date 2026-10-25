/**
 * The figure of "Real Claude Code sessions", eval part B of polite-crawler. The numbers come from
 * src/data/eval-b.json, the result of the runs of the workflow eval-sessions.yml
 * (scripts/eval-b-data.ts).
 *
 * `ClaimSessions` shows the cost of a session for each claim, with the MCP tools of polite-crawler and
 * with WebFetch. The axis is linear, in USD, and the shortest page is first. A reader selects the model
 * and the version of polite-crawler-mcp. A run with no WebFetch arm shows the WebFetch sessions of the
 * earlier run of the same model.
 *
 * A reader points at a claim, or moves with the arrow keys. Then the panel shows each session of the
 * claim. A table below the figure gives each number.
 */
import { useState, type KeyboardEvent, type ReactElement } from "react";
import data from "../data/eval-b.json";
import type { EvalBData, Run, Series, Session, SessionClaim } from "../lib/eval-b.ts";
import {
  ARMS,
  bySize,
  claimCost,
  costRatio,
  costsLess,
  linearScale,
  linearTicks,
  nextIndex,
  onPageOf,
  ratioText,
  seriesOf,
  sessionsOf,
  usd,
} from "../lib/eval-b.ts";
import "../styles/eval.css";

const EVAL = data as EvalBData;
const RUNS = EVAL.runs;
const BY_SIZE = bySize(EVAL.claims);
const NAMES = [...new Set(RUNS.map((run) => run.name))];
const VERSIONS = EVAL.versions.map((version) => version.mcp);

/** The axis is the same for each run: from $0 to $0.125, with a grid line at each $0.02. */
const AXIS_MAX = 0.125;
const place = linearScale(AXIS_MAX);
const TICKS = linearTicks(AXIS_MAX, 0.02);

const pct = (value: number): string => `${String(value)}%`;
const labelOf = (series: Series): string => ARMS.find((one) => one.id === series.arm)!.label;
const runOf = (id: string): Run => RUNS.find((one) => one.id === id)!;
const versionOf = (series: Series): string => runOf(series.run).mcp;
const isPolite = (series: Series): boolean => series.arm !== "webfetch";

/** The run of a model with a version, or undefined when the eval has no such run. */
const findRun = (name: string, mcp: string): Run | undefined =>
  RUNS.find((one) => one.name === name && one.mcp === mcp);

/** The newest run of a model. */
const newestOf = (name: string): Run => RUNS.findLast((one) => one.name === name)!;

/** The text of the check of one session. */
const checkText = (session: Session): string =>
  session.onPage === true
    ? "the quote is on the page"
    : session.onPage === false
      ? "a quote is not on the page"
      : "no quote";

/** The name of a series in the legend and in the table. */
const seriesName = (series: Series): string =>
  series.earlier
    ? `${labelOf(series)}, from the run of ${versionOf(series)}`
    : series.arm === "webfetch"
      ? `${labelOf(series)}, with its small model`
      : labelOf(series);

/** The sessions of one series of the selected claim, as a list. */
function ArmSessions({
  claim,
  series,
}: {
  readonly claim: SessionClaim;
  readonly series: Series;
}): ReactElement {
  const sessions = sessionsOf(claim, series.run, series.arm);
  return (
    <div className={`pc-evalb-arm pc-evalb-${series.arm}`}>
      <p>
        <span className="pc-evalb-key" aria-hidden="true" />
        <strong>{labelOf(series)}</strong>
        <span>
          {onPageOf(sessions)} of {sessions.length} with the quote on the page
          {series.earlier ? `, from the run of ${versionOf(series)}` : ""}
        </span>
      </p>
      <ul>
        {sessions.map((session, index) => (
          <li key={index}>
            <strong>{usd(session.usd)}</strong>, {session.turns} turns, {checkText(session)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** For each claim: the cost of a session in each arm, for the run that the reader selects. */
export function ClaimSessions(): ReactElement {
  const [runId, setRunId] = useState(newestOf(NAMES[0]!).id);
  const longest = BY_SIZE.length - 1;
  const [at, setAt] = useState(longest);
  const run = RUNS.find((one) => one.id === runId) ?? RUNS[0]!;
  const claim = BY_SIZE[at] ?? BY_SIZE[longest]!;
  const series = seriesOf(run);
  const polite = series.filter(isPolite);
  const webfetch = series.find((one) => !isPolite(one))!;
  const less = BY_SIZE.filter((row) => costsLess(row, run));
  const many = run.repeat > 1;
  const earlier = webfetch.earlier ? `, WebFetch from the run of ${versionOf(webfetch)}` : "";

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = nextIndex(event.key, at, BY_SIZE.length);
    if (next === undefined) return;
    event.preventDefault();
    setAt(next);
  };

  const cost = (row: SessionClaim, one: Series): number => claimCost(row, one.run, one.arm);
  const middle = many ? `the median of ${String(run.repeat)} sessions` : "one session";
  const [first, ...others] = polite;

  return (
    <figure className="pc-chart pc-eval pc-evalb not-content">
      <div className="pc-eval-head">
        <figcaption>
          The cost of a session for each claim, the shortest page first
          <span className="pc-chart-muted">
            {" "}
            on a linear axis in USD, with each model counted. The grid lines are at each $0.02.
          </span>
        </figcaption>
        <div className="pc-evalb-controls">
          <div className="pc-presets" role="group" aria-label="The model of the sessions">
            {NAMES.map((name) => (
              <button
                type="button"
                key={name}
                className="pc-chip"
                aria-pressed={name === run.name}
                onClick={() => setRunId((findRun(name, run.mcp) ?? newestOf(name)).id)}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="pc-presets" role="group" aria-label="The version of polite-crawler-mcp">
            {VERSIONS.map((mcp) => {
              const target = findRun(run.name, mcp);
              return (
                <button
                  type="button"
                  key={mcp}
                  className="pc-chip pc-chip-code"
                  aria-pressed={mcp === run.mcp}
                  disabled={target === undefined}
                  title={target === undefined ? `No run of ${run.name} with ${mcp}` : undefined}
                  onClick={() => target !== undefined && setRunId(target.id)}
                >
                  {mcp}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <ul className="pc-chart-legend">
        {series.map((one) => (
          <li key={one.arm}>
            <span className={`pc-evalb-key pc-evalb-${one.arm}`} aria-hidden="true" />
            {seriesName(one)}
          </li>
        ))}
        {many ? (
          <li>
            {series.map((one) => (
              <span
                key={one.arm}
                className={`pc-evalb-key pc-evalb-one pc-evalb-${one.arm}`}
                aria-hidden="true"
              />
            ))}
            each of the {run.repeat} sessions. The full mark is the median.
          </li>
        ) : null}
        <li>
          <span className="pc-evalb-less-key" aria-hidden="true">
            ▼
          </span>
          polite-crawler costs less ({less.length} claims)
        </li>
      </ul>
      <div
        className="pc-eval-plot pc-evalb-plot"
        role="group"
        tabIndex={0}
        aria-label={`${String(BY_SIZE.length)} claims with ${run.name} and polite-crawler-mcp ${run.mcp}, the shortest page first. Use the arrow keys to move from claim to claim. The table below the figure gives each number.`}
        onKeyDown={onKey}
      >
        <div className="pc-eval-grid" aria-hidden="true">
          {TICKS.map((tick) => (
            <span key={tick} style={{ left: pct(place(tick)) }} />
          ))}
        </div>
        <div className="pc-eval-row pc-eval-axis" aria-hidden="true">
          <span />
          <div className="pc-eval-scale pc-evalb-scale">
            {TICKS.map((tick, index) => (
              <span
                key={tick}
                className={index % 2 === 1 ? "pc-evalb-minor" : undefined}
                style={{ left: pct(place(tick)) }}
              >
                {tick === 0 ? "$0" : usd(tick, 2)}
              </span>
            ))}
          </div>
          <span />
        </div>
        {BY_SIZE.map((row, index) => {
          const places = series.map((one) => place(cost(row, one)));
          const left = Math.min(...places);
          const cheaper = costsLess(row, run);
          return (
            <div
              key={row.id}
              className={`pc-eval-row${index === at ? " pc-selected" : ""}${cheaper ? " pc-evalb-less" : ""}`}
              aria-hidden="true"
              onPointerEnter={() => setAt(index)}
              onClick={() => setAt(index)}
            >
              <span className="pc-eval-name">
                <strong>{row.page}</strong>
                <span>{row.question}</span>
              </span>
              <span className="pc-eval-track">
                <span
                  className="pc-eval-link"
                  style={{ left: pct(left), width: pct(Math.max(...places) - left) }}
                />
                {many
                  ? series.flatMap((one) =>
                      sessionsOf(row, one.run, one.arm).map((session, rep) => (
                        <span
                          key={`${one.arm}-${String(rep)}`}
                          className={`pc-evalb-one pc-evalb-${one.arm}`}
                          style={{ left: pct(place(session.usd)) }}
                        />
                      )),
                    )
                  : null}
                {[...series].reverse().map((one) => (
                  <span
                    key={one.arm}
                    className={`pc-evalb-mark pc-evalb-${one.arm}`}
                    style={{ left: pct(place(cost(row, one))) }}
                  />
                ))}
              </span>
              <span className="pc-eval-ratio">
                {cheaper ? <span aria-hidden="true">▼ </span> : null}
                {ratioText(costRatio(row, run))}
              </span>
            </div>
          );
        })}
      </div>
      <div className="pc-eval-detail" aria-live="polite">
        <p className="pc-eval-detail-head">
          <a href={claim.url}>{claim.page}</a>: {claim.question}
        </p>
        <p>
          With {run.name}, a session with polite-crawler cost{" "}
          <strong>{usd(cost(claim, first!))}</strong>
          {others.map((one) => (
            <span key={one.arm}>
              , with {one.arm === "mcp-quote" ? "the four tools" : labelOf(one)}{" "}
              <strong>{usd(cost(claim, one))}</strong>
            </span>
          ))}
          , and a session with WebFetch <strong>{usd(cost(claim, webfetch))}</strong> ({middle} in
          each arm, polite-crawler-mcp {run.mcp}
          {earlier}). polite-crawler costs {ratioText(costRatio(claim, run))}.
        </p>
        <div className={`pc-evalb-arms${series.length > 2 ? " pc-evalb-arms-3" : ""}`}>
          {series.map((one) => (
            <ArmSessions key={one.arm} claim={claim} series={one} />
          ))}
        </div>
      </div>
      <details className="pc-table-view">
        <summary>Show each claim as a table</summary>
        <div
          className="pc-table-wrap"
          tabIndex={0}
          role="region"
          aria-label={`The cost of a session for each claim, with ${run.name} and polite-crawler-mcp ${run.mcp}`}
        >
          <table className="pc-table pc-evalb-table">
            <thead>
              <tr>
                <th scope="col">Page and question</th>
                {series.map((one) => (
                  <th scope="col" key={one.arm}>
                    {seriesName(one)}
                  </th>
                ))}
                {polite.map((one) => (
                  <th scope="col" key={one.arm}>
                    {labelOf(one)} ÷ WebFetch
                  </th>
                ))}
                {series.map((one) => (
                  <th scope="col" key={one.arm}>
                    On the page: {labelOf(one)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {BY_SIZE.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <a href={row.url}>{row.page}</a>
                    <span className="pc-eval-question">{row.question}</span>
                  </th>
                  {series.map((one) => (
                    <td key={one.arm}>{usd(cost(row, one))}</td>
                  ))}
                  {polite.map((one) => (
                    <td key={one.arm}>
                      {costsLess(row, run, one.arm) ? <span aria-hidden="true">▼ </span> : null}
                      {costRatio(row, run, one.arm).toFixed(2)}
                      {costsLess(row, run, one.arm) ? (
                        <span className="pc-sr"> ({labelOf(one)} costs less)</span>
                      ) : null}
                    </td>
                  ))}
                  {series.map((one) => (
                    <td key={one.arm}>
                      {onPageOf(sessionsOf(row, one.run, one.arm))} of{" "}
                      {sessionsOf(row, one.run, one.arm).length}
                    </td>
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
