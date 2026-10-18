/**
 * "An hour of PoliteCrawler on your site", for the page of site owners. The reader gives a
 * robots.txt, a job of the crawler and the answers of the site. The figure shows the hour as a
 * strip to scale, and as the access log of the site with the wait after each request. The parts of
 * polite-crawler operate on a virtual clock, and a small model connects them (`lib/site-visit.ts`).
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { Scenario, ServerAnswer, Visit, VisitRow, Wait } from "../lib/site-visit.ts";
import {
  CRAWL_PAGES,
  VISIT_HOST,
  VISIT_ROBOTS,
  VISIT_SPAN,
  clockText,
  durationText,
  simulateVisit,
  statsOf,
  statusText,
} from "../lib/site-visit.ts";
import "../styles/owner-figures.css";

const MINUTE = 60_000;
/** The wait bar shows up to this time to scale: the longest Crawl-delay that the crawler obeys. */
const BAR_SPAN = 60_000;
/** The animation shows the next row of the log after this time. */
const STEP_MS = 700;
/** A gap of this time or more between two rows gets a line of its own. */
const IDLE_MS = 2 * MINUTE;

const SCENARIOS: ReadonlyArray<{
  readonly id: Scenario;
  readonly name: string;
  readonly about: string;
}> = [
  {
    id: "fetch",
    name: "An assistant asks for pages",
    about:
      "An AI assistant asks for three pages, then asks again during the hour. The crawler obeys the rules for PoliteCrawler and for Claude-User.",
  },
  {
    id: "crawl",
    name: "A small crawl",
    about: `A crawl follows the links of the site, to a limit of ${String(CRAWL_PAGES)} pages and 10 minutes.`,
  },
  {
    id: "watch",
    name: "Watched pages",
    about:
      "The daemon checks four watched pages. Each page is due one time in the hour, and the crawler has a copy of each.",
  },
];

const ANSWERS: ReadonlyArray<{ readonly id: ServerAnswer; readonly name: string }> = [
  { id: "ok", name: "200 OK, as each other page" },
  { id: "429", name: "429 with Retry-After: 120" },
  { id: "429-long", name: "429 with Retry-After: 7200" },
  { id: "503", name: "503 with no Retry-After" },
  { id: "403", name: "403 Forbidden" },
];

const LATENCIES: readonly number[] = [200, 1000, 4000];

const PRESETS: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
  { name: "Crawl-delay: 5", text: VISIT_ROBOTS },
  { name: "No Crawl-delay", text: "User-agent: *\nDisallow: /account/\nDisallow: /search\n" },
  {
    name: "Crawl-delay: 30",
    text: "User-agent: *\nCrawl-delay: 30\nDisallow: /account/\nDisallow: /search\n",
  },
  { name: "Blocks PoliteCrawler", text: "User-agent: PoliteCrawler\nDisallow: /\n" },
];

const pct = (ms: number): string =>
  `${((Math.max(0, Math.min(VISIT_SPAN, ms)) / VISIT_SPAN) * 100).toFixed(3)}%`;

/** This function names the class of an answer, for its color. */
const toneOf = (row: VisitRow): string => {
  if (row.path === "/robots.txt") return "robots";
  if (row.status === 304) return "same";
  if (row.status === 429 || row.status === 503) return "wait";
  if (row.status === 403) return "refused";
  return "ok";
};

/** This function gives the text of a wait, with its reason. */
const waitText = (wait: Wait, at: number): string =>
  wait.kind === "stop"
    ? `no request until ${clockText(at + wait.ms)}: ${wait.text}`
    : `it waits ${durationText(wait.ms)}: ${wait.text}`;

/** This function gives the text of a row that sent no request. */
const localText = (row: VisitRow): string => {
  if (row.kind === "store") return `the store answers with ${row.note}: no request`;
  if (row.kind === "refused") return `robots.txt refuses it (${row.note}): no request`;
  return `${row.note}: no request`;
};

const isReduced = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One row of the log. */
const LogRow = ({ row }: { readonly row: VisitRow }): ReactElement => {
  if (row.kind === "ask" || row.kind === "end") {
    return (
      <li className={`pc-visit-row pc-visit-${row.kind}`}>
        <time>{clockText(row.at)}</time>
        <p>{row.kind === "end" ? `The crawl ends. ${row.note}.` : row.note}</p>
      </li>
    );
  }
  if (row.kind !== "request") {
    return (
      <li className="pc-visit-row pc-visit-local">
        <time>{clockText(row.at)}</time>
        <p>
          <span className="pc-visit-dot" aria-hidden="true" />
          <code>{row.path}</code> <span>{localText(row)}</span>
        </p>
      </li>
    );
  }
  const wait = row.wait;
  const end = row.end ?? row.at;
  const barMs = wait === null ? 0 : Math.min(wait.ms, BAR_SPAN);
  return (
    <li className={`pc-visit-row pc-visit-req pc-visit-${toneOf(row)}`}>
      <time>{clockText(row.at, true)}</time>
      <div className="pc-visit-main">
        <p className="pc-visit-line">
          <span className="pc-visit-mark" aria-hidden="true" />
          <code>GET {row.path}</code>
          <strong>{statusText(row.status ?? 0)}</strong>
          <span className="pc-visit-took">{durationText(end - row.at)}</span>
        </p>
        <p className="pc-visit-note">
          {row.note}
          {row.sent.length > 0 ? `. It sent ${row.sent.join(" and ")}` : ""}.
        </p>
        {wait !== null ? (
          <p className={`pc-visit-wait pc-visit-wait-${wait.kind}`}>
            <span className="pc-visit-bar" aria-hidden="true">
              <span style={{ width: `${((barMs / BAR_SPAN) * 100).toFixed(2)}%` }} />
            </span>
            <span>Then {waitText(wait, end)}</span>
          </p>
        ) : null}
      </div>
    </li>
  );
};

/** The figure. */
export default function SiteVisit(): ReactElement {
  const [robots, setRobots] = useState(VISIT_ROBOTS);
  const [scenario, setScenario] = useState<Scenario>("fetch");
  const [answer, setAnswer] = useState<ServerAnswer>("ok");
  const [latency, setLatency] = useState(200);
  const [visit, setVisit] = useState<Visit | null>(null);
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [seen, setSeen] = useState(false);
  const root = useRef<HTMLElement | null>(null);
  /** The number of the newest simulation: an older one that ends later does not replace it. */
  const run = useRef(0);
  /** With the value true, the next result plays from the start. Otherwise it shows the whole hour. */
  const replay = useRef(true);

  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!seen) return;
    const id = ++run.current;
    void simulateVisit({ robots, scenario, answer, latencyMs: latency }).then((made) => {
      if (id !== run.current) return;
      setVisit(made);
      const play = replay.current && !isReduced();
      replay.current = false;
      setShown(play ? 1 : made.rows.length);
      setPlaying(play);
    });
  }, [seen, robots, scenario, answer, latency]);

  const total = visit?.rows.length ?? 0;
  useEffect(() => {
    if (!playing) return;
    if (shown >= total) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setShown((count) => Math.min(total, count + 1)), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, shown, total]);

  const choose = useCallback((next: () => void) => {
    replay.current = true;
    next();
  }, []);

  const rows = visit?.rows.slice(0, shown) ?? [];
  const now = rows.at(-1)?.at ?? 0;
  const done = visit !== null && shown >= total;
  const stats = statsOf(rows);
  const whole = visit === null ? undefined : statsOf(visit.rows);
  const stop = visit?.stop ?? null;
  const stopShown = stop !== null && stop.at <= now;
  const about = SCENARIOS.find((one) => one.id === scenario)!;

  const summary =
    visit === null || whole === undefined
      ? "The simulation starts when the figure comes into view."
      : [
          `In this hour, PoliteCrawler sends ${String(whole.requests)} ${whole.requests === 1 ? "request" : "requests"} to your site, one at a time.`,
          whole.answeredLocally > 0
            ? `${String(whole.answeredLocally)} ${whole.answeredLocally === 1 ? "answer comes" : "answers come"} with no request.`
            : "",
          whole.shortestGapMs === null
            ? ""
            : `The shortest gap between two requests is ${durationText(whole.shortestGapMs)}.`,
          stop === null
            ? ""
            : `After ${stop.cause}, it sends no request until ${clockText(stop.until)}.`,
        ]
          .filter((part) => part.length > 0)
          .join(" ");

  return (
    <figure
      className="pc-visit not-content"
      ref={root}
      aria-label="An hour of PoliteCrawler on a site"
    >
      <header className="pc-crawl-head">
        <div className="pc-crawl-title">
          <strong>An hour of PoliteCrawler on your site</strong>
          <span>
            The parser, the scheduler, the pace and the status rules of polite-crawler, on a
            simulated clock.
          </span>
        </div>
        <div className="pc-crawl-controls">
          {playing ? (
            <button type="button" className="pc-button" onClick={() => setPlaying(false)}>
              Pause
            </button>
          ) : (
            <button
              type="button"
              className="pc-button"
              disabled={visit === null || done}
              onClick={() => setPlaying(true)}
            >
              Play
            </button>
          )}
          <button
            type="button"
            className="pc-button"
            disabled={visit === null || done}
            onClick={() => {
              setPlaying(false);
              setShown((count) => Math.min(total, count + 1));
            }}
          >
            Step
          </button>
          <button
            type="button"
            className="pc-button"
            disabled={visit === null || done}
            onClick={() => {
              setPlaying(false);
              setShown(total);
            }}
          >
            Show the hour
          </button>
          <button
            type="button"
            className="pc-button"
            disabled={visit === null}
            onClick={() => {
              setShown(1);
              setPlaying(true);
            }}
          >
            Replay
          </button>
        </div>
      </header>

      <div className="pc-visit-inputs">
        <div className="pc-visit-robots">
          <label className="pc-field">
            <span>Your robots.txt</span>
            <textarea
              value={robots}
              rows={6}
              spellcheck={false}
              onInput={(event) => setRobots(event.currentTarget.value)}
            />
          </label>
          <div className="pc-presets" role="group" aria-label="Examples of robots.txt">
            {PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.name}
                className="pc-chip"
                aria-pressed={robots === preset.text}
                onClick={() => setRobots(preset.text)}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </div>
        <div className="pc-visit-job">
          <div className="pc-field">
            <span id="pc-visit-job">What the crawler does</span>
            <div className="pc-presets" role="group" aria-labelledby="pc-visit-job">
              {SCENARIOS.map((one) => (
                <button
                  type="button"
                  key={one.id}
                  className="pc-chip"
                  aria-pressed={scenario === one.id}
                  onClick={() => choose(() => setScenario(one.id))}
                >
                  {one.name}
                </button>
              ))}
            </div>
            <p className="pc-visit-about">{about.about}</p>
          </div>
          <label className="pc-field">
            <span>Your answer to the second page</span>
            <select
              value={answer}
              onChange={(event) =>
                choose(() => setAnswer(event.currentTarget.value as ServerAnswer))
              }
            >
              {ANSWERS.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </select>
          </label>
          <label className="pc-field">
            <span>The time of your server to answer</span>
            <select
              value={String(latency)}
              onChange={(event) => choose(() => setLatency(Number(event.currentTarget.value)))}
            >
              {LATENCIES.map((ms) => (
                <option key={ms} value={String(ms)}>
                  {durationText(ms)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="pc-visit-hour" aria-hidden="true">
        <p className="pc-visit-part">
          The hour, to scale <span>{VISIT_HOST}</span>
        </p>
        <div className="pc-axis-track pc-visit-axis">
          {[0, 10, 20, 30, 40, 50, 60].map((minute) => (
            <span key={minute} style={{ left: pct(minute * MINUTE) }}>
              {minute === 0 ? "0:00" : `${String(minute)} min`}
            </span>
          ))}
        </div>
        <div className="pc-visit-strip">
          {stopShown && stop !== null ? (
            <span
              className="pc-visit-stopband"
              style={{ left: pct(stop.at), width: pct(Math.min(VISIT_SPAN, stop.until) - stop.at) }}
            />
          ) : null}
          {rows.map((row, index) =>
            row.kind === "request" ? (
              <span
                key={index}
                className={`pc-visit-tick pc-visit-${toneOf(row)}`}
                style={{ left: pct(row.at) }}
              />
            ) : row.kind === "store" || row.kind === "refused" || row.kind === "stopped" ? (
              <span
                key={index}
                className={`pc-visit-local-tick pc-visit-local-${row.kind}`}
                style={{ left: pct(row.at) }}
              />
            ) : null,
          )}
          {visit !== null ? <span className="pc-visit-now" style={{ left: pct(now) }} /> : null}
        </div>
      </div>

      <dl className="pc-stats pc-visit-stats">
        <div>
          <dt>Requests</dt>
          <dd>{stats.requests}</dd>
        </div>
        <div>
          <dt>Answers with no request</dt>
          <dd>{stats.answeredLocally}</dd>
        </div>
        <div>
          <dt>Most in one minute</dt>
          <dd>{stats.peakPerMinute}</dd>
        </div>
        <div>
          <dt>At the same time</dt>
          <dd>{stats.mostAtOnce > 1 ? stats.mostAtOnce : "1 at most"}</dd>
        </div>
      </dl>

      <div className="pc-visit-log">
        <p className="pc-visit-part">
          Your access log <span>with the wait after each request</span>
        </p>
        {visit === null ? (
          <p className="pc-empty">The simulation starts when the figure comes into view.</p>
        ) : (
          <ol aria-live="polite">
            {rows.map((row, index) => {
              const later = rows[index + 1];
              const gap = later === undefined ? 0 : later.at - row.at;
              return [
                <LogRow key={`row-${String(index)}`} row={row} />,
                gap >= IDLE_MS ? (
                  <li key={`idle-${String(index)}`} className="pc-visit-idle">
                    <span>{durationText(gap)} with no request</span>
                  </li>
                ) : null,
              ];
            })}
          </ol>
        )}
      </div>

      <p className="pc-crawl-verdict" aria-live="polite">
        {summary}
      </p>

      <footer className="pc-crawl-foot">
        <ul className="pc-legend" aria-label="Legend">
          <li>
            <span className="pc-visit-key pc-visit-robots" />
            robots.txt
          </li>
          <li>
            <span className="pc-visit-key pc-visit-ok" />
            200, a full page
          </li>
          <li>
            <span className="pc-visit-key pc-visit-same" />
            304, no body
          </li>
          <li>
            <span className="pc-visit-key pc-visit-wait" />
            429 or 503
          </li>
          <li>
            <span className="pc-visit-key pc-visit-refused" />
            403
          </li>
          <li>
            <span className="pc-visit-key pc-visit-dotkey" />
            No request
          </li>
          <li>
            <span className="pc-visit-key pc-visit-stopkey" />
            Stopped
          </li>
        </ul>
        <p className="pc-visit-model">
          The robots.txt parser, the scheduler of each site, the rest after each request and the
          meaning of each status are the code of polite-crawler. A small model connects them in
          place of the full crawler, which needs a store on disk. The site is made up, and the
          figure sends no request.
        </p>
      </footer>

      <details className="pc-table-view pc-visit-table">
        <summary>The requests as a table</summary>
        <div className="pc-table-wrap" tabIndex={0} role="region" aria-label="The requests">
          <table className="pc-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Request</th>
                <th scope="col">Answer</th>
                <th scope="col">Then</th>
              </tr>
            </thead>
            <tbody>
              {(visit?.rows ?? []).map((row, index) =>
                row.kind === "ask" || row.kind === "end" ? (
                  <tr key={index}>
                    <td>{clockText(row.at)}</td>
                    <td colSpan={3}>
                      {row.kind === "end" ? `The crawl ends. ${row.note}.` : row.note}
                    </td>
                  </tr>
                ) : row.kind === "request" ? (
                  <tr key={index}>
                    <td>{clockText(row.at, true)}</td>
                    <td>
                      <code>GET {row.path}</code>
                    </td>
                    <td>{statusText(row.status ?? 0)}</td>
                    <td>{row.wait === null ? "" : waitText(row.wait, row.end ?? row.at)}</td>
                  </tr>
                ) : (
                  <tr key={index}>
                    <td>{clockText(row.at)}</td>
                    <td>
                      <code>{row.path}</code>
                    </td>
                    <td colSpan={2}>{localText(row)}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
