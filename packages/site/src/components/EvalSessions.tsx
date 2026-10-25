/**
 * The figure of "Real Claude Code sessions", eval part B of polite-crawler. The numbers come from
 * src/data/eval-b.json, the result of the runs of the workflow eval-sessions.yml
 * (scripts/eval-b-data.ts).
 *
 * `ClaimSessions` shows the cost of a session for each claim, with the MCP tools of polite-crawler and
 * with WebFetch. The axis is linear, in USD, and the shortest page is first. A reader selects the model. A reader
 * points at a claim, or moves with the arrow keys. Then the panel shows each session of the claim. A
 * table below the figure gives each number.
 */
import { useState, type KeyboardEvent, type ReactElement } from "react";
import data from "../data/eval-b.json";
import type { Arm, EvalBData, Session, SessionClaim } from "../lib/eval-b.ts";
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
  sessionsOf,
  usd,
} from "../lib/eval-b.ts";
import "../styles/eval.css";

const EVAL = data as EvalBData;
const MODELS = EVAL.models;
const BY_SIZE = bySize(EVAL.claims);

/** The axis is the same for each model: from $0 to $0.125, with a grid line at each $0.02. */
const AXIS_MAX = 0.125;
const place = linearScale(AXIS_MAX);
const TICKS = linearTicks(AXIS_MAX, 0.02);

const pct = (value: number): string => `${String(value)}%`;
const labelOf = (arm: Arm): string => ARMS.find((one) => one.id === arm)!.label;

/** The text of the check of one session. */
const checkText = (session: Session): string =>
  session.onPage === true
    ? "the quote is on the page"
    : session.onPage === false
      ? "a quote is not on the page"
      : "no quote";

/** The sessions of one arm of the selected claim, as a list. */
function ArmSessions({
  claim,
  model,
  arm,
}: {
  readonly claim: SessionClaim;
  readonly model: string;
  readonly arm: Arm;
}): ReactElement {
  const sessions = sessionsOf(claim, model, arm);
  return (
    <div className={`pc-evalb-arm pc-evalb-${arm}`}>
      <p>
        <span className="pc-evalb-key" aria-hidden="true" />
        <strong>{labelOf(arm)}</strong>
        <span>
          {onPageOf(sessions)} of {sessions.length} with the quote on the page
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

/** For each claim: the cost of a session in the two arms, for the model that the reader selects. */
export function ClaimSessions(): ReactElement {
  const [modelId, setModelId] = useState(MODELS[0]!.id);
  const longest = BY_SIZE.length - 1;
  const [at, setAt] = useState(longest);
  const model = MODELS.find((one) => one.id === modelId) ?? MODELS[0]!;
  const claim = BY_SIZE[at] ?? BY_SIZE[longest]!;
  const less = BY_SIZE.filter((row) => costsLess(row, model.id));
  const many = model.repeat > 1;

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = nextIndex(event.key, at, BY_SIZE.length);
    if (next === undefined) return;
    event.preventDefault();
    setAt(next);
  };

  const mcp = claimCost(claim, model.id, "mcp");
  const webfetch = claimCost(claim, model.id, "webfetch");
  const ratio = costRatio(claim, model.id);
  const middle = many ? `the median of ${String(model.repeat)} sessions` : "one session";

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
        <div className="pc-presets" role="group" aria-label="The model of the sessions">
          {MODELS.map((one) => (
            <button
              type="button"
              key={one.id}
              className="pc-chip"
              aria-pressed={one.id === model.id}
              onClick={() => setModelId(one.id)}
            >
              {one.name}
            </button>
          ))}
        </div>
      </div>
      <ul className="pc-chart-legend">
        <li>
          <span className="pc-evalb-key pc-evalb-mcp" aria-hidden="true" />
          polite-crawler: the MCP tools
        </li>
        <li>
          <span className="pc-evalb-key pc-evalb-webfetch" aria-hidden="true" />
          WebFetch, with its small model
        </li>
        {many ? (
          <li>
            <span className="pc-evalb-key pc-evalb-one pc-evalb-mcp" aria-hidden="true" />
            <span className="pc-evalb-key pc-evalb-one pc-evalb-webfetch" aria-hidden="true" />
            each of the {model.repeat} sessions. The full mark is the median.
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
        aria-label={`${String(BY_SIZE.length)} claims with ${model.name}, the shortest page first. Use the arrow keys to move from claim to claim. The table below the figure gives each number.`}
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
          const left = place(claimCost(row, model.id, "mcp"));
          const right = place(claimCost(row, model.id, "webfetch"));
          const cheaper = costsLess(row, model.id);
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
                  style={{ left: pct(Math.min(left, right)), width: pct(Math.abs(right - left)) }}
                />
                {many
                  ? ARMS.flatMap(({ id: arm }) =>
                      sessionsOf(row, model.id, arm).map((session, rep) => (
                        <span
                          key={`${arm}-${String(rep)}`}
                          className={`pc-evalb-one pc-evalb-${arm}`}
                          style={{ left: pct(place(session.usd)) }}
                        />
                      )),
                    )
                  : null}
                <span className="pc-evalb-mark pc-evalb-webfetch" style={{ left: pct(right) }} />
                <span className="pc-evalb-mark pc-evalb-mcp" style={{ left: pct(left) }} />
              </span>
              <span className="pc-eval-ratio">
                {cheaper ? <span aria-hidden="true">▼ </span> : null}
                {ratioText(costRatio(row, model.id))}
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
          With {model.name}, a session with polite-crawler cost <strong>{usd(mcp)}</strong>, and a
          session with WebFetch <strong>{usd(webfetch)}</strong> ({middle} in each arm).
          polite-crawler costs {ratioText(ratio)}.
        </p>
        <div className="pc-evalb-arms">
          {ARMS.map(({ id: arm }) => (
            <ArmSessions key={arm} claim={claim} model={model.id} arm={arm} />
          ))}
        </div>
      </div>
      <details className="pc-table-view">
        <summary>Show each claim as a table</summary>
        <div
          className="pc-table-wrap"
          tabIndex={0}
          role="region"
          aria-label={`The cost of a session for each claim, with ${model.name}`}
        >
          <table className="pc-table pc-evalb-table">
            <thead>
              <tr>
                <th scope="col">Page and question</th>
                <th scope="col">polite-crawler</th>
                <th scope="col">WebFetch</th>
                <th scope="col">polite-crawler ÷ WebFetch</th>
                <th scope="col">On the page: polite-crawler</th>
                <th scope="col">On the page: WebFetch</th>
              </tr>
            </thead>
            <tbody>
              {BY_SIZE.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <a href={row.url}>{row.page}</a>
                    <span className="pc-eval-question">{row.question}</span>
                  </th>
                  <td>{usd(claimCost(row, model.id, "mcp"))}</td>
                  <td>{usd(claimCost(row, model.id, "webfetch"))}</td>
                  <td>
                    {costsLess(row, model.id) ? <span aria-hidden="true">▼ </span> : null}
                    {costRatio(row, model.id).toFixed(2)}
                    {costsLess(row, model.id) ? (
                      <span className="pc-sr"> (polite-crawler costs less)</span>
                    ) : null}
                  </td>
                  {ARMS.map(({ id: arm }) => (
                    <td key={arm}>
                      {onPageOf(sessionsOf(row, model.id, arm))} of {model.repeat}
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
