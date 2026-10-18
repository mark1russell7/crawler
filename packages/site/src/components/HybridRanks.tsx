/**
 * The figure "How hybrid search ranks". For one question over a small made-up corpus, it shows the
 * full-text ranking, the vector ranking and the fused ranking side by side. A line goes from each
 * rank that counts to the fused list. The fusion is the real `fuseRanks` of polite-crawler. The
 * full-text ranks come from the real index, and the vector ranks from a run of the real model in CI.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import data from "../data/search-figure.json";
import { QUESTIONS, corpusDoc } from "../lib/search-corpus.ts";
import type { FigureData, FigureQuestion, FusedRow } from "../lib/search-figure.ts";
import { fuseQuestion } from "../lib/search-figure.ts";

const figure = data as unknown as FigureData;
const DEFAULTS = figure.defaults;
/** The pages of the corpus. A slider at this value and one more stands for the default of 50. */
const PAGES = figure.questions[0]?.vector.length ?? 14;

/** What each question shows. The test of the figure checks each fact of these notes. */
const NOTES: Readonly<Record<string, string>> = {
  pizza:
    "No word of the question is on the page of Forno Esempio, so the full text misses it. The word “after” even gives a water filter. The vectors rank Forno Esempio first.",
  entrance:
    "No page has the words of the question, so the full text gives nothing. The vectors always give a ranking. The museum page with the ramp is second, very near the first: weak matches get similar scores.",
  gtin: "A barcode has no meaning for the model, so the vectors put a water filter first. The full text finds the exact number, and the fusion puts the oil first.",
  access:
    "The full text matches the word “access” on the archive page. Only the vectors find the page with the ramp, so it is fourth when k is 60. Set k to 0: a first place in one list then counts more, and the page goes up to second.",
  rye: "The two lists find the same pages near the top, in a different order. A page that is high in the two lists wins, so the fused scores of the first three pages are almost equal.",
};

const ROW = 30;
const PILL = 24;
const TOP = 6;

interface Layout {
  readonly wide: boolean;
  readonly width: number;
  readonly side: number;
  readonly midX: number;
  readonly midW: number;
  readonly rightX: number;
}

/** This function gives the columns for a width. A narrow figure shows only the ranks at the sides. */
const layoutOf = (width: number): Layout => {
  if (width >= 560) {
    const side = Math.min(214, Math.floor((width - 96) / 3));
    const gap = Math.floor((width - 3 * side) / 2);
    return { wide: true, width, side, midX: side + gap, midW: side, rightX: 2 * side + 2 * gap };
  }
  const side = 30;
  const gap = 30;
  return {
    wide: false,
    width,
    side,
    midX: side + gap,
    midW: width - 2 * (side + gap),
    rightX: width - side,
  };
};

const labelOf = (doc: string): string => corpusDoc(doc)?.label ?? doc;
const fixed = (value: number, digits: number): string => value.toFixed(digits);

/** The slider stands for a count from 1 to the corpus, and its last step for the default. */
const sliderOf = (count: number): number => Math.min(count, PAGES + 1);
const countOf = (slider: number, fallback: number): number => (slider > PAGES ? fallback : slider);
const countText = (count: number): string =>
  count > PAGES ? `${String(count)} (default)` : String(count);

/** This hook moves each value to its new target in a short time, or at once with reduced motion. */
const useTween = (target: ReadonlyMap<string, number>, still: boolean): Map<string, number> => {
  const [shown, setShown] = useState(() => new Map(target));
  const from = useRef(new Map(target));
  useEffect(() => {
    if (still) {
      from.current = new Map(target);
      setShown(new Map(target));
      return;
    }
    const begin = new Map(from.current);
    const started = performance.now();
    let frame = 0;
    const step = (now: number): void => {
      const t = Math.min(1, (now - started) / 420);
      const eased = 1 - (1 - t) ** 3;
      const next = new Map<string, number>();
      for (const [key, to] of target) {
        const was = begin.get(key) ?? to;
        next.set(key, was + (to - was) * eased);
      }
      from.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, still]);
  return shown;
};

/** This function gives the text of the readout for one page. */
const readoutOf = (
  doc: string,
  question: FigureQuestion,
  fused: readonly FusedRow[],
  k: number,
  candidates: number,
  neighbors: number,
): { readonly lines: readonly string[]; readonly sum: string | null } => {
  const lexAt = question.lexical.findIndex((hit) => hit.doc === doc);
  const vecAt = question.vector.findIndex((hit) => hit.doc === doc);
  const at = fused.findIndex((row) => row.doc === doc);
  const row = fused[at];
  const lines: string[] = [];
  if (lexAt === -1)
    lines.push("Full text: not in the list. No word of the question is on the page.");
  else if (lexAt >= candidates)
    lines.push(
      `Full text: rank ${String(lexAt + 1)}, but the fusion takes only the first ${String(candidates)}.`,
    );
  else
    lines.push(
      `Full text: rank ${String(lexAt + 1)}, BM25 score ${fixed(question.lexical[lexAt]!.score, 3)}.`,
    );
  if (vecAt === -1) lines.push("Vectors: not in the list.");
  else if (vecAt >= neighbors)
    lines.push(
      `Vectors: rank ${String(vecAt + 1)}, but the fusion takes only the first ${String(neighbors)}.`,
    );
  else
    lines.push(
      `Vectors: rank ${String(vecAt + 1)}, cosine similarity ${fixed(question.vector[vecAt]!.similarity, 3)}.`,
    );
  if (row === undefined) {
    lines.push("Fused: not in the list, because no list that counts holds the page.");
    return { lines, sum: null };
  }
  const parts = [row.text, row.vector]
    .filter((rank): rank is number => rank !== null)
    .map((rank) => `1 / (${String(k)} + ${String(rank)})`);
  lines.push(`Fused: rank ${String(at + 1)} of ${String(fused.length)}.`);
  return { lines, sum: `${parts.join(" + ")} = ${fixed(row.score, 4)}` };
};

/** The figure. */
export default function HybridRanks(): ReactElement {
  const [questionId, setQuestionId] = useState(QUESTIONS[0]!.id);
  const [k, setK] = useState<number>(DEFAULTS.fusionK);
  const [candidates, setCandidates] = useState<number>(DEFAULTS.candidates);
  const [neighbors, setNeighbors] = useState<number>(DEFAULTS.neighbors);
  const [selected, setSelected] = useState(QUESTIONS[0]!.target);
  const [hover, setHover] = useState<string | null>(null);
  /** A page that the reader selected stays in focus, and the other pages fade. */
  const [pinned, setPinned] = useState(false);
  const [width, setWidth] = useState(720);
  const [still, setStill] = useState(true);
  const box = useRef<HTMLDivElement | null>(null);
  const rows = useRef<SVGGElement | null>(null);

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const measure = (): void => setWidth(Math.max(260, Math.floor(element.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setStill(query.matches);
    const change = (): void => setStill(query.matches);
    query.addEventListener("change", change);
    return () => {
      observer.disconnect();
      query.removeEventListener("change", change);
    };
  }, []);

  const question = figure.questions.find((one) => one.id === questionId) ?? figure.questions[0]!;
  const meta = QUESTIONS.find((one) => one.id === questionId) ?? QUESTIONS[0]!;
  const fused = useMemo(
    () => fuseQuestion(question, { k, candidates, neighbors }),
    [question, k, candidates, neighbors],
  );
  const layout = layoutOf(width);
  const count = Math.max(question.lexical.length, question.vector.length, fused.length, 1);
  const height = TOP + count * ROW + 4;

  const target = useMemo(() => {
    const positions = new Map<string, number>();
    question.lexical.forEach((hit, at) => positions.set(`L:${hit.doc}`, TOP + at * ROW));
    question.vector.forEach((hit, at) => positions.set(`R:${hit.doc}`, TOP + at * ROW));
    fused.forEach((row, at) => positions.set(`M:${row.doc}`, TOP + at * ROW));
    return positions;
  }, [question, fused]);
  const y = useTween(target, still);
  const yOf = (key: string): number => y.get(key) ?? target.get(key) ?? 0;

  const focus = hover ?? (pinned ? selected : null);
  const dim = (doc: string): string => (focus !== null && focus !== doc ? " pc-hy-faded" : "");
  const pick = (doc: string): void => {
    // a second selection of the same page shows each page again
    setPinned(!(pinned && doc === selected));
    setSelected(doc);
  };
  const shownDoc = hover ?? selected;
  const readout = readoutOf(shownDoc, question, fused, k, candidates, neighbors);

  const chooseQuestion = (id: string): void => {
    setQuestionId(id);
    setSelected(QUESTIONS.find((one) => one.id === id)?.target ?? "");
    setPinned(false);
    setHover(null);
  };

  /** The keys of the fused list: the arrows move the selection, as in a list box. */
  const onRowKey = (event: { readonly key: string; preventDefault(): void }, at: number): void => {
    const next = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const row = fused[Math.max(0, Math.min(fused.length - 1, next))];
    if (row === undefined) return;
    setSelected(row.doc);
    setPinned(true);
    const element = rows.current?.querySelector<SVGGElement>(`[data-doc="${row.doc}"]`);
    element?.focus();
  };

  const mid = PILL / 2;
  const link = (x1: number, y1: number, x2: number, y2: number): string => {
    const bend = (x2 - x1) / 2;
    return `M${fixed(x1, 1)} ${fixed(y1, 1)} C${fixed(x1 + bend, 1)} ${fixed(y1, 1)} ${fixed(x2 - bend, 1)} ${fixed(y2, 1)} ${fixed(x2, 1)} ${fixed(y2, 1)}`;
  };

  const pill = (
    column: "L" | "R",
    doc: string,
    at: number,
    value: string,
    cut: boolean,
  ): ReactElement => {
    const x = column === "L" ? 0 : layout.rightX;
    const top = yOf(`${column}:${doc}`);
    const isTarget = doc === meta.target;
    return (
      <g
        key={`${column}:${doc}`}
        className={`pc-hy-pill${cut ? " pc-hy-cut" : ""}${isTarget ? " pc-hy-target" : ""}${dim(doc)}`}
        onPointerEnter={() => setHover(doc)}
        onPointerLeave={() => setHover(null)}
        onClick={() => pick(doc)}
      >
        <rect x={x} y={top} width={layout.side} height={PILL} rx={5} />
        <text
          className="pc-hy-rank"
          x={x + (layout.wide ? 22 : layout.side / 2)}
          y={top + 16.5}
          textAnchor={layout.wide ? "end" : "middle"}
        >
          {at + 1}
        </text>
        {layout.wide ? (
          <>
            <text className="pc-hy-label" x={x + 30} y={top + 16.5}>
              {labelOf(doc)}
            </text>
            <text className="pc-hy-value" x={x + layout.side - 7} y={top + 16.5} textAnchor="end">
              {value}
            </text>
          </>
        ) : null}
      </g>
    );
  };

  const lexCut = Math.min(candidates, question.lexical.length);
  const vecCut = Math.min(neighbors, question.vector.length);

  return (
    <figure
      className="pc-hy not-content"
      aria-label="How hybrid search ranks the pages of one question"
    >
      <div className="pc-hy-controls">
        <div className="pc-presets" role="group" aria-label="The question">
          {QUESTIONS.map((one) => (
            <button
              key={one.id}
              type="button"
              className="pc-chip"
              aria-pressed={one.id === questionId}
              onClick={() => chooseQuestion(one.id)}
            >
              {one.label}
            </button>
          ))}
        </div>
        <div className="pc-hy-sliders">
          <label className="pc-hy-slider">
            <span>
              The fusion constant <code>k</code>: <strong>{k}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={120}
              step={1}
              value={k}
              onInput={(event) => setK(Number(event.currentTarget.value))}
            />
          </label>
          <label className="pc-hy-slider">
            <span>
              Full-text candidates: <strong>{countText(candidates)}</strong>
            </span>
            <input
              type="range"
              min={1}
              max={PAGES + 1}
              step={1}
              value={sliderOf(candidates)}
              onInput={(event) =>
                setCandidates(countOf(Number(event.currentTarget.value), DEFAULTS.candidates))
              }
            />
          </label>
          <label className="pc-hy-slider">
            <span>
              Vector neighbors: <strong>{countText(neighbors)}</strong>
            </span>
            <input
              type="range"
              min={1}
              max={PAGES + 1}
              step={1}
              value={sliderOf(neighbors)}
              onInput={(event) =>
                setNeighbors(countOf(Number(event.currentTarget.value), DEFAULTS.neighbors))
              }
            />
          </label>
          <button
            type="button"
            className="pc-button"
            disabled={
              k === DEFAULTS.fusionK &&
              candidates === DEFAULTS.candidates &&
              neighbors === DEFAULTS.neighbors
            }
            onClick={() => {
              setK(DEFAULTS.fusionK);
              setCandidates(DEFAULTS.candidates);
              setNeighbors(DEFAULTS.neighbors);
            }}
          >
            Use the defaults
          </button>
        </div>
      </div>

      <p className="pc-hy-question">
        <span>The question</span>
        <q>{question.q}</q>
      </p>

      <div className={`pc-hy-heads${layout.wide ? " pc-hy-heads-wide" : ""}`} aria-hidden="true">
        <span
          className="pc-hy-head pc-hy-head-text"
          style={layout.wide ? { left: 0, width: `${String(layout.side)}px` } : undefined}
        >
          <span className="pc-hy-key pc-hy-key-text" />
          Full text
          <small>
            {layout.wide
              ? `BM25, ${String(question.lexical.length)} found`
              : question.lexical.length}
          </small>
        </span>
        <span
          className="pc-hy-head pc-hy-head-mid"
          style={
            layout.wide
              ? { left: `${String(layout.midX)}px`, width: `${String(layout.midW)}px` }
              : undefined
          }
        >
          Fused
          <small>{`k = ${String(k)}`}</small>
        </span>
        <span
          className="pc-hy-head pc-hy-head-vec"
          style={
            layout.wide
              ? { left: `${String(layout.rightX)}px`, width: `${String(layout.side)}px` }
              : undefined
          }
        >
          <span className="pc-hy-key pc-hy-key-vec" />
          Vectors
          <small>
            {layout.wide
              ? `cosine, ${String(question.vector.length)} ranked`
              : question.vector.length}
          </small>
        </span>
      </div>

      <div className="pc-hy-plot" ref={box}>
        <svg
          viewBox={`0 0 ${String(layout.width)} ${String(height)}`}
          role="group"
          aria-label={`The rankings of the question ${question.q}`}
        >
          <g className="pc-hy-links" aria-hidden="true">
            {fused.map((row) => {
              const ym = yOf(`M:${row.doc}`) + mid;
              return (
                <g key={`links:${row.doc}`} className={dim(row.doc).trim()}>
                  {row.text !== null ? (
                    <path
                      className="pc-hy-link pc-hy-link-text"
                      d={link(layout.side, yOf(`L:${row.doc}`) + mid, layout.midX, ym)}
                    />
                  ) : null}
                  {row.vector !== null ? (
                    <path
                      className="pc-hy-link pc-hy-link-vec"
                      d={link(
                        layout.rightX,
                        yOf(`R:${row.doc}`) + mid,
                        layout.midX + layout.midW,
                        ym,
                      )}
                    />
                  ) : null}
                </g>
              );
            })}
          </g>
          <g aria-hidden="true">
            {question.lexical.map((hit, at) =>
              pill("L", hit.doc, at, fixed(hit.score, 2), at >= candidates),
            )}
            {question.vector.map((hit, at) =>
              pill("R", hit.doc, at, fixed(hit.similarity, 2), at >= neighbors),
            )}
            {lexCut < question.lexical.length ? (
              <g className="pc-hy-cutline">
                <line
                  x1={0}
                  x2={layout.side}
                  y1={TOP + lexCut * ROW - 3}
                  y2={TOP + lexCut * ROW - 3}
                />
                {layout.wide ? (
                  <text x={layout.side} y={TOP + lexCut * ROW - 6} textAnchor="end">
                    {`the first ${String(lexCut)} count`}
                  </text>
                ) : null}
              </g>
            ) : null}
            {vecCut < question.vector.length ? (
              <g className="pc-hy-cutline">
                <line
                  x1={layout.rightX}
                  x2={layout.rightX + layout.side}
                  y1={TOP + vecCut * ROW - 3}
                  y2={TOP + vecCut * ROW - 3}
                />
                {layout.wide ? (
                  <text x={layout.rightX + layout.side} y={TOP + vecCut * ROW - 6} textAnchor="end">
                    {`the first ${String(vecCut)} count`}
                  </text>
                ) : null}
              </g>
            ) : null}
            {question.lexical.length === 0 && layout.wide ? (
              <text className="pc-hy-none" x={layout.side / 2} y={TOP + 16} textAnchor="middle">
                no page matches a word
              </text>
            ) : null}
          </g>
          <g ref={rows} role="listbox" aria-label="The fused ranking, the best first">
            {fused.map((row, at) => {
              const top = yOf(`M:${row.doc}`);
              const isTarget = row.doc === meta.target;
              const isSelected = row.doc === selected;
              return (
                <g
                  key={`M:${row.doc}`}
                  data-doc={row.doc}
                  role="option"
                  aria-selected={isSelected}
                  aria-label={`${String(at + 1)}: ${labelOf(row.doc)}, score ${fixed(row.score, 4)}`}
                  tabIndex={
                    isSelected || (!fused.some((one) => one.doc === selected) && at === 0) ? 0 : -1
                  }
                  className={`pc-hy-row${isTarget ? " pc-hy-target" : ""}${isSelected ? " pc-hy-on" : ""}${dim(row.doc)}`}
                  onPointerEnter={() => setHover(row.doc)}
                  onPointerLeave={() => setHover(null)}
                  onClick={() => pick(row.doc)}
                  onFocus={() => {
                    setSelected(row.doc);
                    setPinned(true);
                  }}
                  onKeyDown={(event) => onRowKey(event, at)}
                >
                  <rect x={layout.midX} y={top} width={layout.midW} height={PILL} rx={5} />
                  <text className="pc-hy-rank" x={layout.midX + 22} y={top + 16.5} textAnchor="end">
                    {at + 1}
                  </text>
                  <text className="pc-hy-label" x={layout.midX + 30} y={top + 16.5}>
                    {labelOf(row.doc)}
                  </text>
                  <text
                    className="pc-hy-value"
                    x={layout.midX + layout.midW - 7}
                    y={top + 16.5}
                    textAnchor="end"
                  >
                    {fixed(row.score, 4)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <div className="pc-hy-readout" aria-live="polite">
        <p className="pc-hy-readout-name">
          {labelOf(shownDoc)}
          {shownDoc === meta.target ? <span className="pc-tag">the page that answers</span> : null}
        </p>
        {readout.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {readout.sum !== null ? (
          <p>
            The fused score: <code>{readout.sum}</code>
          </p>
        ) : null}
      </div>

      <figcaption className="pc-hy-note">{NOTES[question.id]}</figcaption>

      <ul className="pc-hy-legend" aria-label="Legend">
        <li>
          <span className="pc-hy-key pc-hy-key-text" />A rank of the full text that counts
        </li>
        <li>
          <span className="pc-hy-key pc-hy-key-vec" />A rank of the vectors that counts
        </li>
        <li>
          <span className="pc-hy-key pc-hy-key-target" />
          The page that answers the question
        </li>
      </ul>

      <details className="pc-table-view">
        <summary>The rankings as a table</summary>
        <div className="pc-table-wrap">
          <table className="pc-table">
            <thead>
              <tr>
                <th scope="col">Fused</th>
                <th scope="col">Page</th>
                <th scope="col">Full text</th>
                <th scope="col">Vectors</th>
                <th scope="col">Score</th>
              </tr>
            </thead>
            <tbody>
              {fused.map((row, at) => (
                <tr key={row.doc}>
                  <td>{at + 1}</td>
                  <th scope="row">{labelOf(row.doc)}</th>
                  <td>{row.text ?? "none"}</td>
                  <td>{row.vector ?? "none"}</td>
                  <td>{fixed(row.score, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <p className="pc-hy-source">
        The full-text ranks come from the index of polite-crawler {figure.provenance.package}. The
        vector ranks come from <code>{figure.provenance.model}</code> through transformers.js{" "}
        {figure.provenance.transformers}, in{" "}
        <a href={figure.provenance.run ?? "https://github.com/mark1russell7/crawler/actions"}>
          a CI run on {figure.provenance.date.slice(0, 10)}
        </a>
        .
      </p>
    </figure>
  );
}
