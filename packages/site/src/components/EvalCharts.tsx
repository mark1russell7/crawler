/**
 * The figures of "Tokens to prove a claim", eval part A of polite-crawler. The numbers come from
 * src/data/eval-a.json, the result of one run of the eval (scripts/eval-data.ts).
 *
 * - `ClaimCosts`: for each claim, the tokens of the polite-crawler path, the page as Markdown (the
 *   WebFetch proxy) and the visible text, on a log axis. A reader points at a claim, or moves with
 *   the arrow keys. Then the panel shows the four steps of the path.
 * - `SessionCosts`: the running totals of a session that proves 1 to 30 claims, in an order that
 *   the reader selects. The tool definitions count one time, at the start.
 * - `ClaimTable`: each number as a table that sorts by each column.
 */
import { useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
import data from "../data/eval-a.json";
import type { EvalClaim, EvalData, Order } from "../lib/eval-a.ts";
import {
  ORDERS,
  STEPS,
  costsMore,
  logScale,
  logTicks,
  ordered,
  ratioOf,
  ratioText,
  sessionTotals,
  stayAheadFrom,
  tickText,
  tokens,
} from "../lib/eval-a.ts";
import "../styles/eval.css";

const EVAL = data as EvalData;
const CLAIMS = EVAL.claims;
const BY_SIZE = ordered(CLAIMS, "short");

/** The axis of the claims: from 400 to 200,000 tokens. */
const CLAIM_MIN = 400;
const CLAIM_MAX = 200_000;
const claimPlace = logScale(CLAIM_MIN, CLAIM_MAX);
const CLAIM_TICKS = logTicks(CLAIM_MIN, CLAIM_MAX);

const pct = (value: number): string => `${String(value)}%`;
const short = (claim: EvalClaim): string => ratioText(claim).replace(" times ", "× ");

/** The text of the place of the page in the results of `crawl_find`. */
const rankText = (claim: EvalClaim): string =>
  claim.rank === null
    ? "crawl_find does not give the page in its first 10 results"
    : claim.rank === 1
      ? "crawl_find gives the page as its first result"
      : `crawl_find gives the page at place ${String(claim.rank)} of its results`;

/** The text of the read of the claim. */
const windowText = (claim: EvalClaim): string =>
  claim.window === "past-cut"
    ? "The quote is past the cut of the reader (50,000 characters), so the path has no read. The excerpt of crawl_verify shows the text around the quote"
    : `crawl_read gives a window of ${tokens(EVAL.window)} characters at the quote`;

/** The keys that move a selection in a list of `count` items. */
function moveKey(
  event: KeyboardEvent<HTMLElement>,
  now: number,
  count: number,
): number | undefined {
  const last = count - 1;
  const next: Record<string, number> = {
    ArrowUp: Math.max(0, now - 1),
    ArrowLeft: Math.max(0, now - 1),
    ArrowDown: Math.min(last, now + 1),
    ArrowRight: Math.min(last, now + 1),
    Home: 0,
    End: last,
  };
  if (!(event.key in next)) return undefined;
  event.preventDefault();
  return next[event.key];
}

/** The four steps of the polite-crawler path of one claim, on a linear bar of its own. */
function Steps({ claim }: { readonly claim: EvalClaim }): ReactElement {
  return (
    <div className="pc-eval-steps">
      <div className="pc-eval-stepbar" aria-hidden="true">
        {STEPS.map((step) =>
          claim[step.key] > 0 ? (
            <span
              key={step.key}
              className={`pc-eval-step pc-eval-step-${step.key}`}
              style={{ flexGrow: claim[step.key] }}
            />
          ) : null,
        )}
      </div>
      <ul className="pc-eval-steplist">
        {STEPS.map((step) => (
          <li key={step.key}>
            <span className={`pc-eval-swatch pc-eval-step-${step.key}`} aria-hidden="true" />
            <code>{step.tool}</code>
            <strong>{tokens(claim[step.key])}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** For each claim: the polite-crawler path against the page as Markdown and its visible text. */
export function ClaimCosts(): ReactElement {
  const longest = BY_SIZE.length - 1;
  const [at, setAt] = useState(longest);
  const claim = BY_SIZE[at] ?? BY_SIZE[longest]!;
  const more = CLAIMS.filter(costsMore).length;

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = moveKey(event, at, BY_SIZE.length);
    if (next !== undefined) setAt(next);
  };

  return (
    <figure className="pc-chart pc-eval pc-eval-claims not-content">
      <figcaption>
        Tokens to prove each claim, the shortest page first
        <span className="pc-chart-muted">
          {" "}
          on a log axis: each grid line is 2 or 2.5 times the last
        </span>
      </figcaption>
      <ul className="pc-chart-legend">
        <li>
          <span className="pc-eval-key pc-eval-polite" aria-hidden="true" />
          polite-crawler: fetch, find, read and verify
        </li>
        <li>
          <span className="pc-eval-key pc-eval-markdown" aria-hidden="true" />
          WebFetch proxy: the page as Markdown
        </li>
        <li>
          <span className="pc-eval-key pc-eval-text" aria-hidden="true" />
          The visible text of the page
        </li>
        <li>
          <span className="pc-eval-more-key" aria-hidden="true">
            ▲
          </span>
          polite-crawler costs more ({more} claims)
        </li>
      </ul>
      <div
        className="pc-eval-plot"
        role="group"
        tabIndex={0}
        aria-label={`${String(CLAIMS.length)} claims, the shortest page first. Use the arrow keys to move from claim to claim. The table below the figures gives each number.`}
        onKeyDown={onKey}
      >
        <div className="pc-eval-grid" aria-hidden="true">
          {CLAIM_TICKS.map((tick) => (
            <span key={tick} style={{ left: pct(claimPlace(tick)) }} />
          ))}
        </div>
        <div className="pc-eval-row pc-eval-axis" aria-hidden="true">
          <span />
          <div className="pc-eval-scale">
            {CLAIM_TICKS.map((tick) => (
              <span
                key={tick}
                className={
                  tick === 500 || String(tick).startsWith("1") ? undefined : "pc-eval-minor"
                }
                style={{ left: pct(claimPlace(tick)) }}
              >
                {tickText(tick)}
              </span>
            ))}
          </div>
          <span />
        </div>
        {BY_SIZE.map((row, index) => {
          const polite = claimPlace(row.polite);
          const markdown = claimPlace(row.markdown);
          const over = costsMore(row);
          return (
            <div
              key={row.id}
              className={`pc-eval-row${index === at ? " pc-selected" : ""}${over ? " pc-eval-over" : ""}`}
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
                  style={{
                    left: pct(Math.min(polite, markdown)),
                    width: pct(Math.abs(markdown - polite)),
                  }}
                />
                <span
                  className="pc-eval-mark pc-eval-text"
                  style={{ left: pct(claimPlace(row.text)) }}
                />
                <span className="pc-eval-mark pc-eval-markdown" style={{ left: pct(markdown) }} />
                <span className="pc-eval-mark pc-eval-polite" style={{ left: pct(polite) }} />
              </span>
              <span className="pc-eval-ratio">
                {over ? <span aria-hidden="true">▲ </span> : null}
                {short(row)}
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
          polite-crawler reads <strong>{tokens(claim.polite)}</strong> tokens to prove the claim.
          The page as Markdown has <strong>{tokens(claim.markdown)}</strong> tokens, and its visible
          text {tokens(claim.text)}. polite-crawler reads {ratioText(claim)}
          {costsMore(claim)
            ? ": the results of the search and the read window are longer than this page."
            : "."}
        </p>
        <Steps claim={claim} />
        <p className="pc-chart-muted">
          {rankText(claim)}. {windowText(claim)}.
        </p>
      </div>
    </figure>
  );
}

/** The running totals of a session, in the order that the reader selects. */
export function SessionCosts(): ReactElement {
  const [order, setOrder] = useState<Order>("run");
  const [at, setAt] = useState<number | undefined>(undefined);
  const points = useMemo(
    () => sessionTotals(ordered(CLAIMS, order), EVAL.toolDefinitions),
    [order],
  );
  const from = stayAheadFrom(points);
  const last = points.at(-1)!;
  const count = points.length;

  const yMin = 500;
  const yMax = 1_000_000;
  const place = logScale(yMin, yMax);
  const yTicks = logTicks(yMin, yMax).filter((tick) => String(tick).startsWith("1"));
  const x = (n: number): number => ((n - 1) / (count - 1)) * 100;
  const y = (value: number): number => 100 - place(value);
  const line = (key: "polite" | "markdown"): string =>
    points.map((point) => `${String(x(point.n))},${String(y(point[key]))}`).join(" ");

  const onMove = (event: PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const share = (event.clientX - box.left) / box.width;
    setAt(Math.max(0, Math.min(count - 1, Math.round(share * (count - 1)))));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      setAt(undefined);
      return;
    }
    const next = moveKey(event, at ?? count - 1, count);
    if (next !== undefined) setAt(next);
  };

  const point = at === undefined ? undefined : points[at];
  const orderName = ORDERS.find((one) => one.id === order)?.label.toLowerCase() ?? "";
  const anchor =
    point === undefined
      ? ""
      : x(point.n) < 30
        ? " pc-eval-tip-start"
        : x(point.n) > 70
          ? " pc-eval-tip-end"
          : "";

  return (
    <figure className="pc-chart pc-eval pc-eval-session not-content">
      <div className="pc-eval-head">
        <figcaption>
          The tokens of a session that proves 1 to {count} claims
          <span className="pc-chart-muted">
            {" "}
            on a log axis: each grid line is 10 times the last
          </span>
        </figcaption>
        <div className="pc-presets" role="group" aria-label="The order of the claims">
          {ORDERS.map((one) => (
            <button
              type="button"
              key={one.id}
              className="pc-chip"
              aria-pressed={order === one.id}
              onClick={() => setOrder(one.id)}
            >
              {one.label}
            </button>
          ))}
        </div>
      </div>
      <ul className="pc-chart-legend">
        <li>
          <span className="pc-eval-line-key pc-eval-polite" aria-hidden="true" />
          polite-crawler, with the tool definitions ({tokens(EVAL.toolDefinitions)} tokens) one time
          at the start
        </li>
        <li>
          <span className="pc-eval-line-key pc-eval-markdown" aria-hidden="true" />
          WebFetch proxy: each page as Markdown
        </li>
      </ul>
      <div className="pc-eval-frame">
        <div className="pc-eval-y" aria-hidden="true">
          {yTicks.map((tick) => (
            <span key={tick} style={{ top: pct(y(tick)) }}>
              {tickText(tick)}
            </span>
          ))}
        </div>
        <div
          className="pc-eval-lines-plot"
          role="group"
          tabIndex={0}
          aria-label={`The running totals of ${String(count)} claims, ${orderName}. Use the arrow keys to move from claim to claim. The table below this figure gives each total.`}
          onPointerMove={onMove}
          onPointerLeave={() => setAt(undefined)}
          onFocus={() => setAt(at ?? count - 1)}
          onBlur={() => setAt(undefined)}
          onKeyDown={onKey}
        >
          <div className="pc-eval-hgrid" aria-hidden="true">
            {yTicks.map((tick) => (
              <span key={tick} style={{ top: pct(y(tick)) }} />
            ))}
          </div>
          {from !== undefined ? (
            <span className="pc-eval-ahead" style={{ left: pct(x(from)) }} aria-hidden="true">
              <span>from claim {from}</span>
            </span>
          ) : null}
          <svg
            className="pc-eval-lines"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              className="pc-eval-line pc-eval-markdown"
              vectorEffect="non-scaling-stroke"
              points={line("markdown")}
            />
            <polyline
              className="pc-eval-line pc-eval-polite"
              vectorEffect="non-scaling-stroke"
              points={line("polite")}
            />
          </svg>
          {point !== undefined ? (
            <>
              <span
                className="pc-eval-cross"
                style={{ left: pct(x(point.n)) }}
                aria-hidden="true"
              />
              <span
                className="pc-eval-dot pc-eval-markdown"
                style={{ left: pct(x(point.n)), top: pct(y(point.markdown)) }}
                aria-hidden="true"
              />
              <span
                className="pc-eval-dot pc-eval-polite"
                style={{ left: pct(x(point.n)), top: pct(y(point.polite)) }}
                aria-hidden="true"
              />
              <div
                className={`pc-tip pc-eval-tip${anchor}`}
                role="tooltip"
                style={{ left: pct(x(point.n)) }}
              >
                <span>
                  After claim {point.n}: {point.claim.page}
                </span>
                <span className="pc-eval-tip-row">
                  <span className="pc-eval-line-key pc-eval-polite" aria-hidden="true" />
                  <strong>{tokens(point.polite)}</strong> polite-crawler
                </span>
                <span className="pc-eval-tip-row">
                  <span className="pc-eval-line-key pc-eval-markdown" aria-hidden="true" />
                  <strong>{tokens(point.markdown)}</strong> WebFetch proxy
                </span>
              </div>
            </>
          ) : null}
        </div>
        <div className="pc-eval-x" aria-hidden="true">
          {[1, 10, 20, count].map((n) => (
            <span key={n} style={{ left: pct(x(n)) }}>
              {n === 1 ? "1 claim" : String(n)}
            </span>
          ))}
        </div>
      </div>
      <p className="pc-crawl-verdict pc-eval-verdict" aria-live="polite">
        {from === 1
          ? "With the long pages first, polite-crawler is below the proxy from the first claim: the first page alone is longer than the tool definitions and the four calls."
          : `In this order, polite-crawler stays below the proxy from claim ${String(from ?? count)} on. Before that, the one-time tool definitions weigh more than the pages.`}{" "}
        After {count} claims: <strong>{tokens(last.polite)}</strong> against{" "}
        <strong>{tokens(last.markdown)}</strong> tokens.
      </p>
      <details className="pc-table-view">
        <summary>Show the running totals as a table</summary>
        <div
          className="pc-table-wrap"
          tabIndex={0}
          role="region"
          aria-label={`The running totals, ${orderName}`}
        >
          <table className="pc-table">
            <thead>
              <tr>
                <th scope="col">Claims</th>
                <th scope="col">The last page</th>
                <th scope="col">polite-crawler</th>
                <th scope="col">WebFetch proxy</th>
              </tr>
            </thead>
            <tbody>
              {points.map((one) => (
                <tr key={one.claim.id}>
                  <th scope="row">{one.n}</th>
                  <td>{one.claim.page}</td>
                  <td>{tokens(one.polite)}</td>
                  <td>{tokens(one.markdown)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

type SortKey = "run" | "page" | "markdown" | "text" | "polite" | "ratio" | "rank";

const COLUMNS: ReadonlyArray<{ readonly key: SortKey; readonly label: string }> = [
  { key: "page", label: "Page and question" },
  { key: "markdown", label: "Page as Markdown" },
  { key: "text", label: "Visible text" },
  { key: "polite", label: "polite-crawler" },
  { key: "ratio", label: "Markdown ÷ polite-crawler" },
  { key: "rank", label: "Place in crawl_find" },
];

const sortValue = (claim: EvalClaim, key: SortKey): number | string => {
  if (key === "page") return claim.page;
  if (key === "ratio") return ratioOf(claim);
  if (key === "rank") return claim.rank ?? 11;
  if (key === "run") return CLAIMS.indexOf(claim);
  return claim[key];
};

/** Each claim as a row of a table that sorts by each column. */
export function ClaimTable(): ReactElement {
  const [sort, setSort] = useState<{ key: SortKey; up: boolean }>({ key: "run", up: true });
  const rows = useMemo(() => {
    const sorted = [...CLAIMS].sort((a, b) => {
      const left = sortValue(a, sort.key);
      const right = sortValue(b, sort.key);
      const order =
        typeof left === "string" && typeof right === "string"
          ? left.localeCompare(right, "en")
          : Number(left) - Number(right);
      return order || CLAIMS.indexOf(a) - CLAIMS.indexOf(b);
    });
    return sort.up ? sorted : sorted.reverse();
  }, [sort]);

  const onSort = (key: SortKey): void =>
    setSort((now) => (now.key === key ? { key, up: !now.up } : { key, up: key === "page" }));

  return (
    <div className="pc-eval-table not-content">
      <div
        className="pc-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="The tokens of each claim"
      >
        <table className="pc-table">
          <caption className="pc-sr">
            The tokens of each claim. The buttons in the header sort the table.
          </caption>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    sort.key === column.key ? (sort.up ? "ascending" : "descending") : undefined
                  }
                >
                  <button type="button" className="pc-eval-sort" onClick={() => onSort(column.key)}>
                    {column.label}
                    <span aria-hidden="true">
                      {sort.key === column.key ? (sort.up ? " ↑" : " ↓") : ""}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((claim) => (
              <tr key={claim.id} className={costsMore(claim) ? "pc-eval-over" : undefined}>
                <th scope="row">
                  <a href={claim.url}>{claim.page}</a>
                  <span className="pc-eval-question">{claim.question}</span>
                </th>
                <td>{tokens(claim.markdown)}</td>
                <td>{tokens(claim.text)}</td>
                <td>{tokens(claim.polite)}</td>
                <td>
                  {costsMore(claim) ? <span aria-hidden="true">▲ </span> : null}
                  {ratioOf(claim).toFixed(2)}
                  {costsMore(claim) ? (
                    <span className="pc-sr"> (polite-crawler costs more)</span>
                  ) : null}
                </td>
                <td>
                  {claim.rank ?? "not in the first 10"}
                  {claim.window === "past-cut" ? (
                    <span className="pc-eval-question">past the cut: no read</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="pc-button pc-eval-reset"
        disabled={sort.key === "run" && sort.up}
        onClick={() => setSort({ key: "run", up: true })}
      >
        Show the order of the run
      </button>
    </div>
  );
}
