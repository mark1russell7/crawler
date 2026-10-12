/**
 * The live crawl of the home page starts the real `HostScheduler` of `polite-crawler` on a virtual
 * clock. Each host is a lane with its requests, its rests, its refusals and its answers from the
 * store. The impolite mode sends the same pages with no scheduler, for comparison.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { Segment, SiteScript } from "../lib/sim.ts";
import { SITES, Timeline, VirtualClock, askAgain, crawlImpolitely, crawlPolitely, endOf, peakOf } from "../lib/sim.ts";

type Mode = "polite" | "impolite";

/** The width of the time axis, in milliseconds of the virtual clock. */
const DOMAIN = 26_000;
/** The animation shows 2 seconds of the crawl in each real second. */
const SPEED = 2;

const pct = (ms: number): string => `${((Math.min(ms, DOMAIN) / DOMAIN) * 100).toFixed(3)}%`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** This function gives the short note under the name of a host. */
const laneNote = (site: SiteScript, lane: readonly Segment[], mode: Mode, done: boolean): string => {
  const sent = lane.filter((segment) => segment.kind === "request").length;
  const refused = lane.find((segment) => segment.kind === "refused");
  if (mode === "impolite") {
    const failed = lane.filter((segment) => segment.kind === "request" && (segment.status ?? 200) >= 400).length;
    if (site.robots === "disallow") return `robots.txt ignored, ${String(sent)} at once`;
    return failed > 0 ? `${String(sent)} at once, ${String(failed)} refused` : `${String(sent)} at once`;
  }
  if (site.robots === "disallow") return "robots.txt refuses: no request";
  if (refused !== undefined) return "a 403: stopped for 1 hour";
  const rest = lane.find((segment) => segment.kind === "rest" && segment.reason !== "pace");
  if (rest !== undefined && rest.kind === "rest") {
    const wait = seconds(rest.end - rest.start);
    if (rest.reason === "slow") return `a slow page: rests ${wait}`;
    if (rest.reason === "retry-after") return `a 429: waits ${wait}`;
    return `crawl-delay: ${wait}`;
  }
  return done ? `${String(sent)} pages, one at a time` : `${String(sent)} of ${String(site.pages.length)} pages`;
};

/** This component draws one mark of a lane. */
const Mark = ({ segment, now }: { readonly segment: Segment; readonly now: number }): ReactElement | null => {
  switch (segment.kind) {
    case "request": {
      const end = segment.end ?? now;
      const status = segment.status;
      const tone = status === undefined || status === 200 ? "ok" : status === 429 ? "wait" : "refused";
      return (
        <span
          className={`pc-req pc-req-${tone}${segment.end === undefined ? " pc-req-live" : ""}`}
          style={{ left: pct(segment.start), width: pct(Math.max(end - segment.start, 120)), top: `${String(4 + segment.row * 9)}px` }}
          title={`${segment.host}: ${status === undefined ? "in progress" : `status ${String(status)}`}, ${seconds(end - segment.start)}`}
        />
      );
    }
    case "rest": {
      if (now <= segment.start) return null;
      const end = Math.min(segment.end, now);
      return (
        <span
          className={`pc-rest pc-rest-${segment.reason}`}
          style={{ left: pct(segment.start), width: pct(end - segment.start) }}
        />
      );
    }
    case "refused":
      return now >= segment.at ? (
        <span className="pc-refused" style={{ left: pct(segment.at) }} title={segment.reason}>
          ×
        </span>
      ) : null;
    case "stored":
      return now >= segment.at ? (
        <span
          className="pc-stored"
          style={{ left: `calc(${pct(segment.at)} + ${String(segment.index * 7)}px)` }}
          title="From the store, with no request"
        />
      ) : null;
  }
};

/** The live crawl. */
export default function LiveCrawl(): ReactElement {
  const [mode, setMode] = useState<Mode>("polite");
  const [, setFrame] = useState(0);
  const [now, setNow] = useState(0);
  const [done, setDone] = useState(false);
  const [asked, setAsked] = useState(false);
  const run = useRef<{ clock: VirtualClock; timeline: Timeline; id: number } | undefined>(undefined);
  const root = useRef<HTMLElement | null>(null);

  const start = useCallback((next: Mode) => {
    const clock = new VirtualClock();
    const timeline = new Timeline();
    const id = (run.current?.id ?? 0) + 1;
    run.current = { clock, timeline, id };
    setMode(next);
    setDone(false);
    setAsked(false);
    setNow(0);
    const finished = (next === "polite" ? crawlPolitely : crawlImpolitely)(SITES, clock, timeline);
    let complete = false;
    void finished.then(() => {
      complete = true;
    });
    const still = () => run.current?.id === id;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      void (async () => {
        for (let t = 0; !complete && t < 120_000; t += 500) await clock.advanceTo(t);
        if (!still()) return;
        setNow(clock.now());
        setDone(true);
        setFrame((frame) => frame + 1);
      })();
      return;
    }
    let last = performance.now();
    let busy = false;
    const tick = (at: number) => {
      if (!still()) return;
      const step = (at - last) * SPEED;
      last = at;
      if (!busy) {
        busy = true;
        void clock.advanceTo(clock.now() + step).then(() => {
          busy = false;
          if (!still()) return;
          setNow(clock.now());
          setFrame((frame) => frame + 1);
          if (complete && !clock.waiting) setDone(true);
        });
      }
      if (!complete || clock.waiting) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && run.current === undefined) start("polite");
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [start]);

  const timeline = run.current?.timeline;
  const segments = timeline?.segments ?? [];
  const end = timeline === undefined ? 0 : endOf(timeline);
  const ticks = Array.from({ length: DOMAIN / 2000 + 1 }, (_, index) => index * 2000);
  // the rows of a lane: an impolite crawl stacks all the pages of a site
  const rows = mode === "impolite" ? Math.max(...SITES.map((site) => site.pages.length)) : 1;
  const peak = peakOf(segments, now);

  const refusals = segments.filter((segment) => segment.kind === "request" && (segment.status ?? 200) >= 400).length;
  const verdict =
    mode === "impolite"
      ? done
        ? `It finished sooner, but it sent ${String(peak)} requests at once to one site, got ${String(refusals)} refusals and ignored robots.txt.`
        : "The same pages, with no scheduler: each site gets all its requests at once."
      : asked
        ? `The second time, ${String(timeline?.stored ?? 0)} answers came from the store, with no request.`
        : done
          ? "Each site got one request at a time. Select Ask again to ask for the same pages again."
          : "Each site gets one request at a time, and the sites run in parallel.";

  const again = () => {
    const current = run.current;
    if (current === undefined || !done || asked) return;
    askAgain(SITES, current.timeline, end + 2000);
    setAsked(true);
    setNow(end + 2000);
    setFrame((frame) => frame + 1);
  };

  return (
    <figure className="pc-crawl" ref={root} aria-label="A live crawl of eight sites, one lane for each site">
      <header className="pc-crawl-head">
        <div className="pc-crawl-title">
          <strong>A crawl of eight sites</strong>
          <span>The real scheduler of the package, on a simulated clock at 2× speed.</span>
        </div>
        <div className="pc-crawl-controls">
          <div className="pc-toggle" role="group" aria-label="How the crawler sends requests">
            <button type="button" aria-pressed={mode === "polite"} onClick={() => start("polite")}>
              Polite
            </button>
            <button type="button" aria-pressed={mode === "impolite"} onClick={() => start("impolite")}>
              Impolite
            </button>
          </div>
          <button type="button" className="pc-button" disabled={!done || asked || mode !== "polite"} onClick={again}>
            Ask again
          </button>
          <button type="button" className="pc-button" onClick={() => start(mode)}>
            Replay
          </button>
        </div>
      </header>

      <div className="pc-lanes">
        <div className="pc-axis" aria-hidden="true">
          <span />
          <div className="pc-axis-track">
            {ticks.map((tick, index) => (
              <span
                key={tick}
                style={{ left: pct(tick) }}
                className={index % 3 === 0 ? undefined : "pc-tick-minor"}
              >
                {tick === 0 ? "0" : `${String(tick / 1000)} s`}
              </span>
            ))}
          </div>
        </div>
        {SITES.map((site) => {
          const lane = segments.filter((segment) => segment.host === site.host);
          return (
            <div className="pc-lane" key={site.host}>
              <div className="pc-lane-label">
                <code>{site.host}</code>
                <span>{laneNote(site, lane, mode, done)}</span>
              </div>
              <div className="pc-track" style={{ height: `${String(10 + rows * 9)}px` }}>
                {lane.map((segment, index) => (
                  <Mark key={index} segment={segment} now={now} />
                ))}
                <span className="pc-now" style={{ left: pct(now) }} aria-hidden="true" />
              </div>
            </div>
          );
        })}
      </div>

      <p className="pc-crawl-verdict" aria-live="polite">{verdict}</p>
      <footer className="pc-crawl-foot">
        <dl className="pc-stats">
          <div>
            <dt>Requests sent</dt>
            <dd>{timeline?.requests ?? 0}</dd>
          </div>
          <div>
            <dt>Answered from the store</dt>
            <dd>{timeline?.stored ?? 0}</dd>
          </div>
          <div>
            <dt>Most requests at once to one site</dt>
            <dd>{peak}</dd>
          </div>
          <div>
            <dt>Time on the clock</dt>
            <dd>{seconds(now)}</dd>
          </div>
        </dl>
        <ul className="pc-legend" aria-label="Legend">
          <li><span className="pc-key pc-key-ok" />A request</li>
          <li><span className="pc-key pc-key-rest" />A rest</li>
          <li><span className="pc-key pc-key-wait" />A 429</li>
          <li><span className="pc-key pc-key-refused" />A refusal</li>
          <li><span className="pc-key pc-key-stored" />From the store</li>
        </ul>
      </footer>
    </figure>
  );
}
