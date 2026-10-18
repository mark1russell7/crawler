/**
 * A replay of an assistant that uses four of the nine MCP tools. The inputs and the outputs are a real
 * session of polite-crawler 0.1.0 (the outputs are shorter here). The replay marks each step in turn and counts
 * the requests: the fetch sends two, and the next three steps read the store.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";

const DOC = "url:https://www.rfc-editor.org/rfc/rfc9309.html";
const CAPTURE = "fetch.f403dd2770c1";
const QUOTE = "the crawler MUST assume complete disallow";

/** The text of a page comes in an envelope that names its source. The URL and the date are left out here. */
const web = (id: string, body: string): string =>
  `<untrusted-web-content id="${id}" capture="${CAPTURE}">\n${body}\n</untrusted-web-content id="${id}">`;

interface Step {
  readonly kind: "person" | "tool" | "answer";
  readonly name: string;
  readonly input?: string;
  readonly output?: string;
  /** the requests that the step sends to the site */
  readonly requests: number;
  readonly note: string;
}

const STEPS: readonly Step[] = [
  {
    kind: "person",
    name: "Person",
    requests: 0,
    note: "A site gives status 503 for its robots.txt. Can a crawler fetch the pages of the site? Cite the standard.",
  },
  {
    kind: "tool",
    name: "crawl_fetch",
    input: `{ "urls": ["https://www.rfc-editor.org/rfc/rfc9309.html"] }`,
    output: `[{
  "doc": "${DOC}",
  "outcome": "ok",
  "status": 200,
  "chars": 21050,
  "captures": ["${CAPTURE}"],
  "age": "0s"
}]
${web("4f1c09a2", "title: RFC 9309: Robots Exclusion Protocol")}`,
    requests: 2,
    note: "Two requests: the robots.txt of the site, then the page. Each one goes into the capture log. The title is page text, so it comes in an envelope.",
  },
  {
    kind: "tool",
    name: "crawl_find",
    input: `{ "q": "unreachable server error" }`,
    output: `[{ "doc": "${DOC}", "kind": "page", "age": "1m" }]
${web("b83e5d10", `snippet: …2.3.1.4. "[Unreachable]" Status If the robots.txt file is [unreachable] due to [server] or network [errors], this means…`)}`,
    requests: 0,
    note: "No request: a full-text search of the store on the disk.",
  },
  {
    kind: "tool",
    name: "crawl_read",
    input: `{ "doc": "${DOC}", "from": 14315, "length": 420 }`,
    output: `{ "from": 14315, "to": 14735, "total": 21050, "next_from": 14735, "captures": ["${CAPTURE}"] }
${web(
  "70d2a6e4",
  `2.3.1.4. "Unreachable" Status
If the robots.txt file is unreachable due to server or network
errors, this means the robots.txt file is undefined and the crawler
MUST assume complete disallow. …`,
)}`,
    requests: 0,
    note: "No request: the stored copy of the page.",
  },
  {
    kind: "tool",
    name: "crawl_verify",
    input: `{ "doc": "${DOC}", "quote": "${QUOTE}" }`,
    output: `{
  "found": true,
  "start": 14464,
  "end": 14505,
  "captures": ["${CAPTURE}"]
}`,
    requests: 0,
    note: "No request: the quote is in the stored text, at characters 14,464 to 14,505.",
  },
  {
    kind: "answer",
    name: "Assistant",
    requests: 0,
    note: "No. A 503 is a server error, and RFC 9309 (section 2.3.1.4) says that then",
  },
];

const STEP_MS = 1600;

/** The replay. */
export default function AgentReplay(): ReactElement {
  // -1: no step is active, and the replay shows its end state
  const [active, setActive] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const frame = useRef<HTMLElement>(null);
  const played = useRef(false);

  const play = (): void => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setActive(0);
    setPlaying(true);
  };

  useEffect(() => {
    if (!playing) return;
    if (active >= STEPS.length - 1) {
      const end = window.setTimeout(() => {
        setPlaying(false);
        setActive(-1);
      }, STEP_MS * 1.5);
      return () => window.clearTimeout(end);
    }
    const next = window.setTimeout(() => setActive(active + 1), STEP_MS);
    return () => window.clearTimeout(next);
  }, [active, playing]);

  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !played.current) {
          played.current = true;
          play();
        }
      },
      { threshold: 0.45 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const shown = playing ? active : STEPS.length - 1;
  const requests = STEPS.slice(0, shown + 1).reduce((sum, step) => sum + step.requests, 0);
  const fromStore = STEPS.slice(0, shown + 1).filter(
    (step) => step.kind === "tool" && step.requests === 0,
  ).length;

  return (
    <section
      className="pc-replay not-content"
      ref={frame}
      aria-label="An assistant that uses polite-crawler"
    >
      <div className="pc-crawl-head">
        <div className="pc-crawl-title">
          <strong>An assistant cites what it read</strong>
          <span>A real session with four of the nine MCP tools.</span>
        </div>
        <div className="pc-replay-counts" aria-live="polite">
          <span>
            <strong>{requests}</strong> requests to the site
          </span>
          <span>
            <strong>{fromStore}</strong> answers from the store
          </span>
          <button type="button" className="pc-button" onClick={play} disabled={playing}>
            Replay
          </button>
        </div>
      </div>
      <ol className={`pc-replay-steps${playing ? " pc-replay-playing" : ""}`}>
        {STEPS.map((step, index) => (
          <li
            key={step.name}
            className={`pc-replay-step pc-replay-${step.kind}${index === active ? " pc-replay-on" : ""}${playing && index > active ? " pc-replay-later" : ""}`}
          >
            <span className="pc-replay-who">
              {step.kind === "tool" ? <code>{step.name}</code> : step.name}
            </span>
            <div className="pc-replay-body">
              {step.kind === "person" ? <p className="pc-replay-ask">{step.note}</p> : null}
              {step.kind === "tool" ? (
                <>
                  <pre className="pc-replay-input">
                    <code>{step.input}</code>
                  </pre>
                  <pre className="pc-replay-output">
                    <code>{step.output}</code>
                  </pre>
                  <p className={`pc-replay-note${step.requests > 0 ? " pc-replay-net" : ""}`}>
                    {step.note}
                  </p>
                </>
              ) : null}
              {step.kind === "answer" ? (
                <div className="pc-replay-answer">
                  <p>
                    {step.note} <q>{QUOTE}</q>.
                  </p>
                  <p className="pc-replay-cite">
                    <span className="pc-replay-check" aria-hidden="true">
                      ✓
                    </span>
                    <span>
                      The quote is in capture <code>{CAPTURE}</code>, characters 14,464 to 14,505.
                    </span>
                  </p>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
