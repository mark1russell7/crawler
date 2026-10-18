/**
 * "The daemon, tick by tick" animates the real `scheduleWatches` of polite-crawler on a virtual
 * clock, over a model of the watch list (`lib/daemon-sim.ts`). The top part is the schedule of a
 * made-up watch list over three and a half hours. The lower part shows one tick: its checks, the
 * rests of each host, the budget and the drain at a stop. A confirmed change becomes one JSON line.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { CheckMark, DaemonView, TickMark } from "../lib/daemon-sim.ts";
import {
  DAEMON_MS,
  DAEMON_SETTINGS,
  DAEMON_START,
  DaemonSim,
  SIM_PAGES,
} from "../lib/daemon-sim.ts";

const MINUTE = 60_000;
/** The schedule shows this time from the start. */
const WINDOW = 210 * MINUTE;
/** The view of one tick shows this time from its start. */
const ZOOM = 45_000;
/** Between two ticks, the animation shows 10 minutes in each real second. */
const IDLE_SPEED = (10 * MINUTE) / 1000;
/** During a tick, the animation shows 4 seconds in each real second. */
const RUN_SPEED = 4;

const HOSTS = [...new Set(SIM_PAGES.map((page) => page.host))];

const EMPTY: DaemonView = {
  now: DAEMON_START,
  ticks: [],
  checks: [],
  due: [],
  lines: [],
  running: false,
  stoppedAt: null,
  done: false,
};

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const pct = (share: number): string => `${(Math.max(0, Math.min(1, share)) * 100).toFixed(3)}%`;
const at = (ms: number): string => pct((ms - DAEMON_START) / WINDOW);
const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

const KIND: Readonly<Record<string, string>> = {
  new: "the first version",
  unchanged: "unchanged",
  changed: "changed",
  deferred: "deferred",
};

/** This function names the kind of a check, as its mark shows it. */
const kindOf = (check: CheckMark): string =>
  check.confirmed ? "confirmed" : check.suspected ? "suspected" : check.kind;

const describe = (check: CheckMark): string => {
  const what = check.confirmed
    ? "a change, confirmed by a second check"
    : check.suspected
      ? "a change, seen one time: the next check confirms it"
      : (KIND[check.kind] ?? check.kind);
  return `${check.url} at ${clock(check.end)}: ${what}${check.note === null ? "" : `. ${check.note}`}`;
};

/** The figure. */
export default function DaemonTicks(): ReactElement {
  const [view, setView] = useState<DaemonView>(EMPTY);
  const [playing, setPlaying] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const sim = useRef<DaemonSim | undefined>(undefined);
  const busy = useRef(false);
  const play = useRef(false);
  const root = useRef<HTMLElement | null>(null);

  const refresh = useCallback(() => {
    const current = sim.current;
    if (current !== undefined) setView(current.view());
  }, []);

  /** This function makes a new daemon and starts its schedule. */
  const reset = useCallback(async (): Promise<DaemonSim> => {
    play.current = false;
    setPlaying(false);
    setPicked(null);
    const next = new DaemonSim();
    sim.current = next;
    next.start();
    await next.advanceTo(next.clock.now());
    refresh();
    return next;
  }, [refresh]);

  const loop = useCallback(() => {
    let last = performance.now();
    const frame = (time: number): void => {
      const current = sim.current;
      if (!play.current || current === undefined) return;
      const step = Math.min(time - last, 100);
      last = time;
      if (!busy.current) {
        busy.current = true;
        const running = current.view().running;
        let target = current.clock.now() + step * (running ? RUN_SPEED : IDLE_SPEED);
        // between two ticks, the animation stops at the start of the next tick, then slows down
        const next = current.nextAt;
        if (!running && next !== undefined && next < target) target = next;
        void current.advanceTo(target).then(() => {
          busy.current = false;
          if (sim.current !== current) return;
          refresh();
          if (current.done) {
            play.current = false;
            setPlaying(false);
          }
        });
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, [refresh]);

  const start = useCallback(() => {
    if (sim.current?.done === true) return;
    play.current = true;
    setPlaying(true);
    setPicked(null);
    loop();
  }, [loop]);

  const pause = (): void => {
    play.current = false;
    setPlaying(false);
  };

  const stepOnce = async (): Promise<void> => {
    const current = sim.current;
    if (current === undefined || current.done) return;
    pause();
    setPicked(null);
    const next = current.nextAt;
    await current.advanceTo(next ?? current.clock.now());
    refresh();
  };

  const toEnd = async (): Promise<void> => {
    const current = sim.current;
    if (current === undefined) return;
    pause();
    await current.finish();
    refresh();
  };

  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let first = true;
    const observer = new IntersectionObserver((entries) => {
      if (!first || !entries.some((entry) => entry.isIntersecting)) return;
      first = false;
      void reset().then(async (made) => {
        // with reduced motion, the figure shows the whole schedule at once, with no animation
        if (still) {
          await made.finish();
          refresh();
        } else start();
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      play.current = false;
    };
  }, [reset, start, refresh]);

  const ticks = view.ticks;
  const latest = ticks.at(-1);
  const shown: TickMark | undefined = picked === null ? latest : ticks[picked];
  const tickChecks =
    shown === undefined ? [] : view.checks.filter((one) => one.tick === shown.index);
  const started = tickChecks.filter((one) => one.start !== null).length;
  const stopInTick =
    shown !== undefined &&
    view.stoppedAt !== null &&
    view.stoppedAt >= shown.start &&
    (shown.end === null || view.stoppedAt <= shown.end);
  const zoomAt = (ms: number): string => pct((ms - (shown?.start ?? DAEMON_START)) / ZOOM);
  const zoomNow = shown !== undefined && (shown.end === null || picked === null) ? view.now : null;
  const lastLine = view.lines.at(-1);
  const change =
    lastLine === undefined ? undefined : (JSON.parse(lastLine) as Record<string, unknown>);

  const status = view.done
    ? "The daemon stopped. The check in progress ended and wrote its state, and the run started no new check."
    : view.stoppedAt !== null
      ? "The stop signal came. The run starts no new check, and the checks in progress end."
      : view.running
        ? `Tick ${String((latest?.index ?? 0) + 1)} runs its checks.`
        : latest?.next !== null && latest?.next !== undefined
          ? `The daemon waits for the next tick, at ${clock(latest.next)}.`
          : "Select Play to start the daemon.";

  const hourTicks = [0, 30, 60, 90, 120, 150, 180, 210].map((minutes) => minutes * MINUTE);

  return (
    <figure
      className="pc-dm not-content"
      ref={root}
      aria-label="A daemon checks a watch list, tick by tick"
    >
      <header className="pc-crawl-head">
        <div className="pc-crawl-title">
          <strong>A daemon with six watched pages</strong>
          <span>
            The real <code>scheduleWatches</code> on a simulated clock, with{" "}
            <code>--tick {DAEMON_SETTINGS.tick}</code>,{" "}
            <code>--jitter {DAEMON_SETTINGS.jitter}</code>,{" "}
            <code>--tick-budget {DAEMON_SETTINGS.budget}</code> and{" "}
            <code>--tick-pages {DAEMON_SETTINGS.maxPages}</code>.
          </span>
        </div>
        <div className="pc-crawl-controls">
          {playing ? (
            <button type="button" className="pc-button" onClick={pause}>
              Pause
            </button>
          ) : (
            <button type="button" className="pc-button" disabled={view.done} onClick={start}>
              Play
            </button>
          )}
          <button
            type="button"
            className="pc-button"
            disabled={view.done}
            onClick={() => void stepOnce()}
          >
            Step
          </button>
          <button
            type="button"
            className="pc-button"
            disabled={view.done || view.stoppedAt !== null || ticks.length === 0}
            onClick={() => {
              sim.current?.stop();
              refresh();
            }}
          >
            Send the stop signal
          </button>
          <button
            type="button"
            className="pc-button"
            disabled={view.done}
            onClick={() => void toEnd()}
          >
            Skip to the end
          </button>
          <button
            type="button"
            className="pc-button"
            onClick={() => void reset().then(() => start())}
          >
            Replay
          </button>
        </div>
      </header>

      <div className="pc-dm-body">
        <p className="pc-dm-part">
          The schedule <span>{clock(view.now)} UTC</span>
        </p>
        <div className="pc-lanes pc-dm-lanes">
          <div className="pc-axis" aria-hidden="true">
            <span />
            <div className="pc-axis-track pc-dm-axis">
              {hourTicks.map((tick) => (
                <span key={tick} style={{ left: at(DAEMON_START + tick) }}>
                  {clock(DAEMON_START + tick).slice(0, 5)}
                </span>
              ))}
            </div>
          </div>
          <div className="pc-lane pc-dm-ticks" aria-hidden="true">
            <div className="pc-lane-label">
              <span>ticks and jitter</span>
            </div>
            <div className="pc-track pc-dm-tickband">
              {ticks.map((tick) => (
                <span
                  key={tick.index}
                  className={`pc-dm-tick${shown?.index === tick.index ? " pc-dm-tick-on" : ""}`}
                  style={{ left: at(tick.start) }}
                />
              ))}
              {ticks.map((tick) =>
                tick.next !== null && tick.jitter !== null && tick.jitter > 0 ? (
                  <span
                    key={`jitter-${String(tick.index)}`}
                    className="pc-dm-jitter"
                    style={{
                      left: at(tick.next - tick.jitter),
                      width: pct(tick.jitter / WINDOW),
                    }}
                  />
                ) : null,
              )}
              {view.stoppedAt !== null ? (
                <span className="pc-dm-stop" style={{ left: at(view.stoppedAt) }}>
                  stop
                </span>
              ) : null}
              <span className="pc-now" style={{ left: at(view.now) }} />
            </div>
          </div>
          {SIM_PAGES.map((page) => {
            const checks = view.checks.filter((one) => one.url === page.url);
            const dues = view.due.filter((one) => one.url === page.url);
            const last = checks.at(-1);
            return (
              <div className="pc-lane" key={page.url}>
                <div className="pc-lane-label">
                  <code>{page.label}</code>
                  <span>
                    each {page.everyMs / MINUTE / 60} h
                    {last === undefined ? "" : `, last: ${kindOf(last)}`}
                  </span>
                </div>
                <div className="pc-track pc-dm-track">
                  {dues.map((due, index) => {
                    // the wait from the due time to the check of the next tick
                    const check = checks.find((one) => one.start !== null && one.claimed >= due.at);
                    const end = check?.claimed ?? (due.at <= view.now ? view.now : due.at);
                    return due.at - DAEMON_START <= WINDOW ? (
                      <span key={`due-${String(index)}`}>
                        <span className="pc-dm-due" style={{ left: at(due.at) }} />
                        {end > due.at ? (
                          <span
                            className="pc-dm-wait"
                            style={{ left: at(due.at), width: pct((end - due.at) / WINDOW) }}
                          />
                        ) : null}
                      </span>
                    ) : null;
                  })}
                  {checks.map((check, index) => (
                    <span
                      key={`check-${String(index)}`}
                      className={`pc-dm-check pc-dm-${kindOf(check)}`}
                      style={{ left: at(check.end) }}
                      title={describe(check)}
                    >
                      {check.confirmed
                        ? "!"
                        : check.suspected
                          ? "?"
                          : check.kind === "deferred"
                            ? "×"
                            : ""}
                    </span>
                  ))}
                  <span className="pc-now" style={{ left: at(view.now) }} aria-hidden="true" />
                </div>
              </div>
            );
          })}
        </div>

        <p className="pc-crawl-verdict" aria-live="polite">
          {status}
        </p>

        <div className="pc-dm-zoomhead">
          <p className="pc-dm-part">
            {shown === undefined
              ? "One tick"
              : `Tick ${String(shown.index + 1)} of ${String(ticks.length)}, from ${clock(shown.start)}`}
          </p>
          <div className="pc-dm-pick" role="group" aria-label="The tick to show">
            <button
              type="button"
              className="pc-button"
              disabled={shown === undefined || shown.index === 0}
              onClick={() => setPicked(Math.max(0, (shown?.index ?? 0) - 1))}
            >
              Earlier tick
            </button>
            <button
              type="button"
              className="pc-button"
              disabled={shown === undefined || shown.index >= ticks.length - 1}
              onClick={() => {
                const next = (shown?.index ?? 0) + 1;
                setPicked(next >= ticks.length - 1 ? null : next);
              }}
            >
              Later tick
            </button>
          </div>
        </div>
        <div className="pc-lanes pc-dm-zoom">
          <div className="pc-axis" aria-hidden="true">
            <span />
            <div className="pc-axis-track">
              {[0, 10_000, 20_000, 30_000, 40_000].map((ms) => (
                <span key={ms} style={{ left: pct(ms / ZOOM) }}>
                  {ms === 0 ? "0" : `${String(ms / 1000)} s`}
                </span>
              ))}
            </div>
          </div>
          {HOSTS.map((host, row) => {
            const lane = tickChecks.filter((one) => one.host === host);
            return (
              <div className="pc-lane" key={host}>
                <div className="pc-lane-label">
                  <code>{host}</code>
                  <span>
                    {lane.length === 0
                      ? "nothing due"
                      : lane
                          .map((one) => (one.start === null ? "deferred" : kindOf(one)))
                          .join(", ")}
                  </span>
                </div>
                <div className="pc-track pc-dm-ztrack">
                  {shown !== undefined ? (
                    <span className="pc-dm-budget" style={{ left: pct(DAEMON_MS.budget / ZOOM) }}>
                      {row === 0 ? <span>budget</span> : null}
                    </span>
                  ) : null}
                  {lane.map((check, index) =>
                    check.start === null ? (
                      <span
                        key={index}
                        className="pc-dm-deferred-mark"
                        style={{ left: zoomAt(check.claimed) }}
                        title={check.note ?? "deferred"}
                      >
                        ×
                      </span>
                    ) : (
                      <span key={index}>
                        <span
                          className={`pc-req pc-dm-req${zoomNow !== null && zoomNow < check.end ? " pc-req-live" : ""}`}
                          style={{
                            left: zoomAt(check.start),
                            width: pct(
                              (Math.min(check.end, zoomNow ?? check.end) - check.start) / ZOOM,
                            ),
                          }}
                          title={describe(check)}
                        />
                        {check.restUntil !== null && (zoomNow === null || zoomNow > check.end) ? (
                          <span
                            className="pc-rest pc-rest-slow pc-dm-rest"
                            style={{
                              left: zoomAt(check.end),
                              width: pct(
                                (Math.min(check.restUntil, zoomNow ?? check.restUntil) -
                                  check.end) /
                                  ZOOM,
                              ),
                            }}
                          />
                        ) : null}
                      </span>
                    ),
                  )}
                  {stopInTick && view.stoppedAt !== null ? (
                    <span className="pc-dm-zstop" style={{ left: zoomAt(view.stoppedAt) }} />
                  ) : null}
                  {zoomNow !== null && shown !== undefined && zoomNow - shown.start <= ZOOM ? (
                    <span className="pc-now" style={{ left: zoomAt(zoomNow) }} aria-hidden="true" />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <dl className="pc-stats pc-dm-stats">
          <div>
            <dt>Checks of the tick</dt>
            <dd>
              {started} of <code>maxPages</code> {DAEMON_SETTINGS.maxPages}
            </dd>
          </div>
          <div>
            <dt>The run stopped</dt>
            <dd>
              {shown?.summary === null || shown?.summary === undefined
                ? "not yet"
                : shown.summary.stopped}
            </dd>
          </div>
          <div>
            <dt>Next tick</dt>
            <dd>
              {shown === undefined || shown.end === null
                ? "after the run"
                : shown.next === null
                  ? "none: the daemon stopped"
                  : `${clock(shown.next)}, with ${seconds(shown.jitter ?? 0)} of jitter`}
            </dd>
          </div>
        </dl>
        {shown?.summary !== null && shown?.summary !== undefined ? (
          <p className="pc-dm-reason">
            <code>{shown.summary.stopped}</code>: {shown.summary.reason}.
            {shown.summary.due > 0
              ? ` ${String(shown.summary.due)} due ${shown.summary.due === 1 ? "entry waits" : "entries wait"} for the next tick.`
              : ""}
          </p>
        ) : null}
        {tickChecks.some((one) => one.start === null) ? (
          <p className="pc-dm-reason">
            × The host rests after its last page, past the budget of the tick. No request starts at
            or after the deadline, so the entry stays due.
          </p>
        ) : null}

        <div className="pc-dm-out">
          <p className="pc-dm-part">
            The change lines <span>standard output, one JSON line for each confirmed change</span>
          </p>
          {view.lines.length === 0 ? (
            <p className="pc-empty">
              No change is confirmed yet. The daemon writes a line only when a second check sees the
              same new version.
            </p>
          ) : (
            <>
              {view.lines.map((line) => (
                <pre key={line} tabIndex={0}>
                  {line}
                </pre>
              ))}
              {change !== undefined ? (
                <p className="pc-dm-reason">
                  The check at {clock(Date.parse(String(change["fetched_at"])))} saw the same new
                  version as the check before it. Thus <code>confirmed</code> is true, and{" "}
                  <code>previous</code> names the capture of the old version.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>

      <footer className="pc-crawl-foot">
        <ul className="pc-legend pc-dm-legend" aria-label="Legend">
          <li>
            <span className="pc-dm-key pc-dm-due-key" />
            Due
          </li>
          <li>
            <span className="pc-dm-key pc-dm-wait-key" />
            Waits for a tick
          </li>
          <li>
            <span className="pc-dm-key pc-dm-new" />A first check
          </li>
          <li>
            <span className="pc-dm-key pc-dm-unchanged" />
            Unchanged
          </li>
          <li>
            <span className="pc-dm-key pc-dm-suspected">?</span>A change seen one time
          </li>
          <li>
            <span className="pc-dm-key pc-dm-confirmed">!</span>A confirmed change
          </li>
          <li>
            <span className="pc-dm-key pc-dm-jitter-key" />
            Jitter
          </li>
          <li>
            <span className="pc-key pc-key-rest" />
            The rest of a host
          </li>
        </ul>
      </footer>

      <details className="pc-table-view pc-dm-table">
        <summary>The ticks as a table</summary>
        <div className="pc-table-wrap">
          <table className="pc-table">
            <thead>
              <tr>
                <th scope="col">Tick</th>
                <th scope="col">Start (UTC)</th>
                <th scope="col">Checks</th>
                <th scope="col">Stopped</th>
                <th scope="col">Next tick</th>
              </tr>
            </thead>
            <tbody>
              {ticks.map((tick) => (
                <tr key={tick.index}>
                  <td>{tick.index + 1}</td>
                  <td>{clock(tick.start)}</td>
                  <td>
                    {view.checks
                      .filter((one) => one.tick === tick.index)
                      .map(
                        (one) =>
                          `${SIM_PAGES.find((page) => page.url === one.url)?.label ?? one.url}: ${kindOf(one)}`,
                      )
                      .join(", ") || "none"}
                  </td>
                  <td>{tick.summary?.stopped ?? "not yet"}</td>
                  <td>
                    {tick.next === null
                      ? tick.end === null
                        ? "after the run"
                        : "none"
                      : `${clock(tick.next)} (jitter ${seconds(tick.jitter ?? 0)})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
