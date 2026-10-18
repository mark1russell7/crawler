/**
 * The request timeline of "Compare the crawlers": one site for 3 minutes, one row for each tool,
 * each with its default pace. The rest of polite-crawler is its real `restAfter`. The other rows are
 * models of the documented defaults (`lib/pace-compare.ts`), and the figure names the sources.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { PaceLane } from "../lib/pace-compare.ts";
import { PACE_SPAN, PACE_TOOLS, PACE_ZOOM, simulatePace } from "../lib/pace-compare.ts";
import "../styles/owner-figures.css";

/** The animation shows the 3 minutes in this real time. */
const PLAY_MS = 9000;
const LATENCIES: readonly number[] = [200, 500, 2000];
const WIDTH = 1000;

const seconds = (ms: number): string => {
  const value = ms / 1000;
  return `${Number.isInteger(value) ? String(value) : value.toFixed(1)} s`;
};
const pct = (ms: number, span: number): string =>
  `${((Math.max(0, Math.min(span, ms)) / span) * 100).toFixed(3)}%`;
const rate = (lane: PaceLane): string => `${String(Math.round(lane.perMinute))} a minute`;

/** This function gives the path of the marks of the requests of one lane, to the time `until`. */
const pathOf = (lane: PaceLane): string =>
  lane.requests
    .map((request) => {
      const x = (request.start / PACE_SPAN) * WIDTH;
      // a gap of the surface between two requests in sequence, so that each request stays a mark
      const width = Math.max(1, ((request.end - request.start) / PACE_SPAN) * WIDTH - 2.5);
      return `M${x.toFixed(2)} 0h${width.toFixed(2)}v20h-${width.toFixed(2)}z`;
    })
    .join("");

const isReduced = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The figure. */
export default function PaceTimeline(): ReactElement {
  const [latency, setLatency] = useState(200);
  const [now, setNow] = useState(PACE_SPAN);
  const [playing, setPlaying] = useState(false);
  const root = useRef<HTMLElement | null>(null);
  const frame = useRef(0);
  const lanes = useMemo(() => simulatePace(latency), [latency]);
  const paths = useMemo(() => lanes.map(pathOf), [lanes]);

  /** This function plays the timeline from the time `from`. With reduced motion, it shows the end. */
  const play = useCallback((from = 0) => {
    if (isReduced()) {
      setNow(PACE_SPAN);
      return;
    }
    cancelAnimationFrame(frame.current);
    const started = performance.now() - (from / PACE_SPAN) * PLAY_MS;
    setPlaying(true);
    const step = (time: number): void => {
      const at = Math.min(PACE_SPAN, ((time - started) / PLAY_MS) * PACE_SPAN);
      setNow(at);
      if (at < PACE_SPAN) frame.current = requestAnimationFrame(step);
      else setPlaying(false);
    };
    setNow(from);
    frame.current = requestAnimationFrame(step);
  }, []);

  const pause = (): void => {
    cancelAnimationFrame(frame.current);
    setPlaying(false);
  };

  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      play(0);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [play]);

  const countAt = (lane: PaceLane, at: number): number =>
    lane.requests.filter((request) => request.start <= at).length;
  const polite = lanes.find((lane) => lane.tool === "polite")!;
  const fastest = lanes.reduce((best, lane) => (lane.perMinute > best.perMinute ? lane : best));
  const fastestName = PACE_TOOLS.find((tool) => tool.id === fastest.tool)?.name ?? "";
  const zoomNow = Math.min(now, PACE_ZOOM);

  return (
    <figure
      className="pc-pace not-content"
      ref={root}
      aria-label="The requests of four crawlers to one site in 3 minutes"
    >
      <header className="pc-crawl-head">
        <div className="pc-crawl-title">
          <strong>One site, 3 minutes, the default pace of each tool</strong>
          <span>
            Each row sends one request at a time. The site answers each request in{" "}
            {seconds(latency)}.
          </span>
        </div>
        <div className="pc-crawl-controls">
          <div className="pc-presets" role="group" aria-label="The time of the site to answer">
            {LATENCIES.map((ms) => (
              <button
                type="button"
                key={ms}
                className="pc-chip"
                aria-pressed={latency === ms}
                onClick={() => {
                  setLatency(ms);
                  play(0);
                }}
              >
                {ms === 2000 ? "A slow site: 2 s" : seconds(ms)}
              </button>
            ))}
          </div>
          {playing ? (
            <button type="button" className="pc-button" onClick={pause}>
              Pause
            </button>
          ) : (
            <button
              type="button"
              className="pc-button"
              disabled={now >= PACE_SPAN}
              onClick={() => play(now)}
            >
              Play
            </button>
          )}
          <button type="button" className="pc-button" onClick={() => play(0)}>
            Replay
          </button>
        </div>
      </header>

      <div className="pc-pace-body">
        <div className="pc-pace-row pc-pace-axis" aria-hidden="true">
          <span />
          <div className="pc-axis-track">
            {[0, 60, 120, 180].map((at) => (
              <span key={at} style={{ left: pct(at * 1000, PACE_SPAN) }}>
                {at === 0 ? "0" : `${String(at / 60)} min`}
              </span>
            ))}
          </div>
          <span />
        </div>
        {lanes.map((lane, index) => {
          const tool = PACE_TOOLS.find((one) => one.id === lane.tool)!;
          return (
            <div className={`pc-pace-row pc-pace-lane pc-pace-${lane.tool}`} key={lane.tool}>
              <div className="pc-lane-label">
                <strong>{tool.name}</strong>
                <span>{tool.rule}</span>
              </div>
              <div className="pc-track pc-pace-track">
                <svg
                  viewBox={`0 0 ${String(WIDTH)} 20`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <clipPath id={`pc-pace-clip-${lane.tool}`}>
                    <rect x="0" y="0" width={(now / PACE_SPAN) * WIDTH} height="20" />
                  </clipPath>
                  <path d={paths[index] ?? ""} clipPath={`url(#pc-pace-clip-${lane.tool})`} />
                </svg>
                <span className="pc-pace-now" style={{ left: pct(now, PACE_SPAN) }} />
              </div>
              <p className="pc-pace-rate">
                <strong>{Math.round(lane.perMinute)}</strong>
                <span>a minute</span>
                <span>
                  {countAt(lane, now)} {now >= PACE_SPAN ? "in 3 min" : "so far"}
                </span>
              </p>
            </div>
          );
        })}

        <p className="pc-pace-part">
          The first 20 seconds <span>each mark is one request, as long as the answer</span>
        </p>
        <div className="pc-pace-row pc-pace-axis" aria-hidden="true">
          <span />
          <div className="pc-axis-track">
            {[0, 5000, 10_000, 15_000, 20_000].map((at) => (
              <span key={at} style={{ left: pct(at, PACE_ZOOM) }}>
                {at === 0 ? "0" : seconds(at)}
              </span>
            ))}
          </div>
          <span />
        </div>
        {lanes.map((lane) => {
          const tool = PACE_TOOLS.find((one) => one.id === lane.tool)!;
          const shown = lane.requests.filter((request) => request.start < zoomNow);
          return (
            <div className={`pc-pace-row pc-pace-lane pc-pace-${lane.tool}`} key={lane.tool}>
              <div className="pc-lane-label">
                <strong>{tool.name}</strong>
              </div>
              <div className="pc-track pc-pace-ztrack" aria-hidden="true">
                {shown.map((request, index) => {
                  const nextStart = lane.requests[index + 1]?.start;
                  return (
                    <span key={index}>
                      <span
                        className="pc-req pc-pace-req"
                        style={{
                          left: pct(request.start, PACE_ZOOM),
                          width: pct(Math.min(request.end, zoomNow) - request.start, PACE_ZOOM),
                        }}
                      />
                      {lane.tool === "polite" &&
                      nextStart !== undefined &&
                      request.end < zoomNow &&
                      request.end < PACE_ZOOM ? (
                        <span
                          className="pc-rest pc-pace-rest"
                          style={{
                            left: pct(request.end, PACE_ZOOM),
                            width: pct(Math.min(nextStart, zoomNow) - request.end, PACE_ZOOM),
                          }}
                        >
                          {index === 0 ? (
                            <span>{seconds(nextStart - request.end)} rest</span>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                  );
                })}
              </div>
              <span />
            </div>
          );
        })}
      </div>

      <p className="pc-crawl-verdict" aria-live="polite">
        With a site that answers in {seconds(latency)}, polite-crawler sends {rate(polite)}, and{" "}
        {fastestName} sends {rate(fastest)}.{" "}
        {latency >= 2000
          ? "A slow answer gives polite-crawler a longer rest, 5 times the time of the answer. The other tools wait for the answer, and then send the next request."
          : "polite-crawler waits after the end of each request. The other tools count their delay from the start of a request, or have no delay."}
      </p>

      <footer className="pc-crawl-foot pc-pace-foot">
        <ul className="pc-pace-notes">
          <li>
            Each row sends one request at a time. Crawlee can also send more at the same time: its
            pool starts at <code>minConcurrency</code> 1 and grows to <code>maxConcurrency</code>{" "}
            200. Crawl4AI starts up to <code>semaphore_count</code> 5 crawls at the same time. Thus
            their real load can be higher than these rows.
          </li>
          <li>
            The values of Scrapy are the values of a project of <code>scrapy startproject</code>.
            With no project, Scrapy has no delay and sends up to 8 requests at a time to a domain.
          </li>
          <li>
            A <code>RateLimiter</code> that you give to Crawl4AI waits 1 to 3 s by default. The row
            shows the limiter that <code>arun_many</code> makes when you give none.
          </li>
          <li>
            Each tool has a setting for a slower pace. polite-crawler has no setting for a faster
            pace.
          </li>
        </ul>
        <p className="pc-pace-sources">
          Sources:{" "}
          {PACE_TOOLS.map((tool, index) => (
            <span key={tool.id}>
              {index > 0 ? "; " : ""}
              {tool.name}:{" "}
              {tool.sources.map((source, at) => (
                <span key={source.href}>
                  {at > 0 ? ", " : ""}
                  <a href={source.href}>{source.label}</a>
                </span>
              ))}
            </span>
          ))}
          . The values are from October 2026.
        </p>
      </footer>

      <details className="pc-table-view pc-pace-table">
        <summary>The pace as a table</summary>
        <div
          className="pc-table-wrap"
          tabIndex={0}
          role="region"
          aria-label="The pace of each tool"
        >
          <table className="pc-table">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">The default wait</th>
                <th scope="col">The setting</th>
                <th scope="col">Requests in 3 minutes</th>
                <th scope="col">Each minute</th>
              </tr>
            </thead>
            <tbody>
              {lanes.map((lane) => {
                const tool = PACE_TOOLS.find((one) => one.id === lane.tool)!;
                return (
                  <tr key={lane.tool}>
                    <th scope="row">{tool.name}</th>
                    <td>{tool.rule}</td>
                    <td>
                      <code>{tool.setting}</code>
                    </td>
                    <td>{lane.requests.length}</td>
                    <td>{Math.round(lane.perMinute)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
