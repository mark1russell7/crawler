/**
 * This diagram shows the path of a request through the crawler. Select a stage to read what it does
 * and where its code is. The dashed paths are the branches. A fresh copy answers from the store, and
 * a refusal makes a record with no request. A page that needs JavaScript goes through the browser.
 * On a narrow screen, the stages are a numbered list, and each branch is a line of text.
 */
import { useState, type ReactElement } from "react";

interface Stage {
  readonly name: string;
  readonly file: string;
  readonly text: string;
}

const STAGES: readonly Stage[] = [
  {
    name: "Ask",
    file: "open.ts",
    text: "A caller names a URL and the maximum age of a stored copy, for example 24 hours. The caller can be the command line, the MCP server or your code.",
  },
  {
    name: "Store first",
    file: "crawler.ts",
    text: "When the store holds a copy younger than the maximum age, the answer comes from the disk. The crawler sends no request, so a repeated question costs nothing.",
  },
  {
    name: "robots.txt",
    file: "robots.ts",
    text: "For a web page, the robots.txt of the site decides, as RFC 9309 specifies. When the crawler cannot read robots.txt, it fetches nothing, and the record tells why.",
  },
  {
    name: "Host queue",
    file: "politeness.ts",
    text: "Each host gets one request at a time, with a rest between two requests. Many hosts run in parallel, so a crawl is fast across sites and gentle on each one.",
  },
  {
    name: "Fetch",
    file: "crawler.ts",
    text: "The request has an honest User-Agent. When the store has an ETag or a date, the request is conditional, and a 304 uses the stored body. The crawler follows five redirects, at most.",
  },
  {
    name: "Classify",
    file: "classify.ts",
    text: "The status and the headers become an outcome. A 401 or a 403 stops the host for 1 hour, and a challenge or a 402 stops it for 24 hours. A 429 or a 503 makes the host wait.",
  },
  {
    name: "Capture",
    file: "log.ts",
    text: "Each decision becomes a record in the capture log, and a declined fetch does too. The body goes into the blob store, under its SHA-256 hash.",
  },
  {
    name: "Extract",
    file: "html.ts",
    text: "The extractor turns the body into documents: the text, the JSON-LD and the links of a page, or the text of a PDF.",
  },
  {
    name: "Render",
    file: "render.ts",
    text: "Only for a page that shows almost nothing without its scripts. A headless browser opens it with images and fonts blocked, and the crawler captures the result like any other page.",
  },
  {
    name: "Index",
    file: "docs.ts",
    text: "The documents go into a SQLite FTS5 index. The index is a projection: reindex builds it again from the capture log and the blobs, with no request.",
  },
  {
    name: "Read",
    file: "open.ts",
    text: "find gives ranked passages, read gives a range of a document, and verify finds the exact span of a quote, with the capture to cite.",
  },
];

/** The branches of each stage, as the list on a narrow screen tells them. */
const BRANCH_TEXT: Readonly<Record<number, string>> = {
  1: "A fresh copy goes to Read, with no request.",
  2: "A refusal goes to Capture, with no request.",
  7: "A page that needs JavaScript goes to Render, and then to Capture.",
};

/** The branches that leave the main path. */
const BRANCHES = [
  { from: 1, to: 10, label: "fresh copy" },
  { from: 2, to: 6, label: "refused" },
] as const;

const W = 430;
const ROW = 46;
const NODE_W = 190;
const NODE_H = 32;
const X = 6;

/** The diagram. */
export default function Pipeline(): ReactElement {
  const [selected, setSelected] = useState(0);
  // the render stage is a detour beside extract, so the main column skips it
  const spine = STAGES.map((_, index) => index).filter((index) => index !== 8);
  const rowOf = (index: number): number => (index === 8 ? spine.indexOf(7) : spine.indexOf(index));
  const top = (index: number): number => 12 + rowOf(index) * ROW;
  const mid = (index: number): number => top(index) + NODE_H / 2;
  const right = X + NODE_W;
  const detourX = right + 50;
  const height = 12 + spine.length * ROW;
  const stage = STAGES[selected]!;
  return (
    <div className="pc-pipe not-content">
      <ol className="pc-pipe-list" aria-label="The path of a request through the crawler">
        {STAGES.map((item, index) => (
          <li key={item.name} className={index === 8 ? "pc-pipe-list-detour" : undefined}>
            <button
              type="button"
              className="pc-pipe-list-stage"
              aria-pressed={index === selected}
              onClick={() => setSelected(index)}
            >
              {item.name}
            </button>
            {BRANCH_TEXT[index] !== undefined ? (
              <span className="pc-pipe-list-branch">{BRANCH_TEXT[index]}</span>
            ) : null}
          </li>
        ))}
      </ol>
      <svg
        viewBox={`0 0 ${String(W)} ${String(height)}`}
        role="group"
        aria-label="The path of a request through the crawler"
      >
        <defs>
          <marker
            id="pc-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
          </marker>
        </defs>
        {spine.slice(1).map((index, at) => {
          const before = spine[at]!;
          return (
            <line
              key={`spine-${String(index)}`}
              className="pc-edge"
              x1={X + NODE_W / 2}
              y1={top(before) + NODE_H}
              x2={X + NODE_W / 2}
              y2={top(index) - 2}
              markerEnd="url(#pc-arrow)"
            />
          );
        })}
        {BRANCHES.map((branch, lane) => {
          const laneX = W - 8 - lane * 26;
          return (
            <g key={branch.label}>
              <path
                className="pc-edge pc-edge-branch"
                d={`M${String(right)} ${String(mid(branch.from))} H${String(laneX)} V${String(mid(branch.to) + (lane === 0 ? 0 : -6))} H${String(right + 2)}`}
                markerEnd="url(#pc-arrow)"
              />
              <text className="pc-edge-label" x={right + 10} y={mid(branch.from) - 6}>
                {branch.label}
              </text>
            </g>
          );
        })}
        <path
          className="pc-edge pc-edge-branch"
          d={`M${String(right)} ${String(mid(7))} H${String(detourX - 2)}`}
          markerEnd="url(#pc-arrow)"
        />
        <text
          className="pc-edge-label"
          x={detourX + 55}
          y={top(7) + NODE_H + 14}
          textAnchor="middle"
        >
          needs JavaScript
        </text>
        <path
          className="pc-edge pc-edge-branch"
          d={`M${String(detourX + 55)} ${String(top(8))} V${String(mid(6) + 6)} H${String(right + 2)}`}
          markerEnd="url(#pc-arrow)"
        />
        {STAGES.map((item, index) => {
          const detour = index === 8;
          const x = detour ? detourX : X;
          const w = detour ? 110 : NODE_W;
          return (
            <g
              key={item.name}
              className={`pc-node${detour ? " pc-node-detour" : ""}${index === selected ? " pc-node-on" : ""}`}
              tabIndex={0}
              role="button"
              aria-label={item.name}
              aria-pressed={index === selected}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelected(index);
                }
              }}
            >
              <rect x={x} y={top(index)} width={w} height={NODE_H} rx={6} />
              <text x={x + w / 2} y={top(index) + NODE_H / 2 + 5} textAnchor="middle">
                {item.name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="pc-pipe-panel" aria-live="polite">
        <p className="pc-pipe-step">
          Stage {selected + 1} of {STAGES.length}
        </p>
        <p className="pc-pipe-name">{stage.name}</p>
        <p>{stage.text}</p>
        <p className="pc-pipe-file">
          The code:{" "}
          <a
            href={`https://github.com/mark1russell7/crawler/blob/main/packages/polite-crawler/src/${stage.file}`}
          >
            <code>{stage.file}</code>
          </a>
        </p>
        <div className="pc-pipe-walk">
          <button
            type="button"
            className="pc-button"
            disabled={selected === 0}
            onClick={() => setSelected(selected - 1)}
          >
            Previous stage
          </button>
          <button
            type="button"
            className="pc-button"
            disabled={selected === STAGES.length - 1}
            onClick={() => setSelected(selected + 1)}
          >
            Next stage
          </button>
        </div>
      </div>
    </div>
  );
}
