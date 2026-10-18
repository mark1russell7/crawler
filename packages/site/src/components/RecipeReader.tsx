/**
 * The recipe reader starts the pure readers of the two recipes of polite-crawler on the pasted
 * HTML. `venueReadingsOf` reads the opening hours, and `productOf` reads the Product data. A worker
 * reads the page, so a large page does not stop the tool. The page gives the result of the first
 * example.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { RecipeInput, RecipeView, ReadingView } from "../lib/recipe-read.ts";
import { RECIPE_SAMPLES } from "../lib/recipe-samples.ts";
import { LABEL, WeekChart } from "./WeekChart.tsx";

/** The wait after the last key press before the reader starts. */
const DEBOUNCE_MS = 250;

type Tab = "hours" | "product";

const SOURCE: Readonly<Record<ReadingView["from"], string>> = {
  jsonld: "JSON-LD",
  text: "page text",
  osm: "OpenStreetMap",
};

const money = (price: { readonly amount: number; readonly currency: string } | null): string => {
  if (price === null) return "none";
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: price.currency }).format(
      price.amount,
    );
  } catch {
    return `${String(price.amount)} ${price.currency}`;
  }
};

const days = (list: readonly string[]): string => list.map((day) => LABEL[day] ?? day).join(", ");

/** This component shows one reading of the hours, with its rank, its source and its quote. */
const Reading = ({
  reading,
  index,
  best,
  fromSite,
}: {
  readonly reading: ReadingView;
  readonly index: number;
  readonly best: boolean;
  readonly fromSite: boolean;
}): ReactElement => (
  <section className={`pc-reading pc-rr-reading${best ? " pc-rr-best" : ""}`}>
    <header>
      <span className="pc-rr-rank" title="The rank orders the readings, 0 first">
        rank {reading.rank}
      </span>
      <strong>
        {index + 1}. {SOURCE[reading.from]}
      </strong>
      {reading.label !== null ? <span className="pc-tag">below “{reading.label}”</span> : null}
      {best ? <span className="pc-tag pc-tag-best">best</span> : null}
      {fromSite ? <span className="pc-tag">from_site</span> : null}
      {reading.schedule === "other" ? <span className="pc-tag">a different schedule</span> : null}
      {reading.inferred ? <span className="pc-tag pc-tag-guess">am or pm guessed</span> : null}
      {reading.partial ? <span className="pc-tag pc-tag-guess">a rule left out</span> : null}
      {reading.season !== null ? <span className="pc-tag">season: {reading.season}</span> : null}
    </header>
    <p className="pc-reading-says">{reading.hours === "" ? "no days" : reading.hours}</p>
    <WeekChart week={reading.week} />
    {reading.quote !== null ? (
      <div className="pc-rr-quote">
        <blockquote>{reading.raw}</blockquote>
        <p className={reading.quote.found ? "pc-rr-ok" : "pc-rr-miss"}>
          {reading.quote.found
            ? `✓ verify finds this quote at the characters ${String(reading.quote.start)} to ${String(reading.quote.end)} of the text.`
            : "✗ verify does not find this quote in the text."}
        </p>
      </div>
    ) : (
      <p className="pc-rr-path">
        From the JSON-LD of the page, at <code>{reading.path ?? "jsonld"}</code>. It is not in the
        visible text, so a citation names the record.
      </p>
    )}
  </section>
);

const STATUS: Readonly<Record<string, { readonly mark: string; readonly text: string }>> = {
  same: { mark: "=", text: "same" },
  changed: { mark: "≠", text: "changed" },
  added: { mark: "+", text: "new" },
  skipped: { mark: "–", text: "not compared" },
  unstated: { mark: "?", text: "not stated" },
};

/** The recipe reader. */
export default function RecipeReader({ initial }: { readonly initial: RecipeView }): ReactElement {
  const first = RECIPE_SAMPLES[0]!;
  const [html, setHtml] = useState(first.html);
  const [url, setUrl] = useState(first.url);
  const [location, setLocation] = useState(first.location);
  const [kept, setKept] = useState(first.kept);
  const [compareWith, setCompareWith] = useState<number | null>(null);
  const [skipSplit, setSkipSplit] = useState(false);
  const [view, setView] = useState<RecipeView>(initial);
  const [tab, setTab] = useState<Tab>(initial.product.read.found ? "product" : "hours");
  const [busy, setBusy] = useState(false);
  const worker = useRef<Worker | undefined>(undefined);
  const running = useRef(false);
  const job = useRef(0);
  const started = useRef(false);
  const now = useRef(false);
  const chosen = useRef(false);

  useEffect(() => () => worker.current?.terminate(), []);

  useEffect(() => {
    // the first render shows the result that the build made
    if (!started.current) {
      started.current = true;
      return;
    }
    const id = ++job.current;
    const input: RecipeInput = { html, url, location, kept, compareWith, skipSplit };
    const show = (result: RecipeView): void => {
      if (id !== job.current) return;
      running.current = false;
      setView(result);
      setBusy(false);
      // a new example opens the tab of the reader that found something
      if (chosen.current) {
        chosen.current = false;
        setTab(result.product.read.found ? "product" : "hours");
      }
    };
    const run = (): void => {
      setBusy(true);
      if (typeof Worker === "undefined") {
        void import("../lib/recipe-read.ts").then(({ readRecipes }) => show(readRecipes(input)));
        return;
      }
      // a reader that is still busy with an old page stops, so the newest text wins
      if (running.current) {
        worker.current?.terminate();
        worker.current = undefined;
      }
      worker.current ??= new Worker(new URL("../lib/recipe-worker.ts", import.meta.url), {
        type: "module",
      });
      worker.current.onmessage = (event: MessageEvent<{ id: number; result: RecipeView }>) => {
        if (event.data.id === id) show(event.data.result);
      };
      running.current = true;
      worker.current.postMessage({ id, input });
    };
    const wait = now.current ? 0 : DEBOUNCE_MS;
    now.current = false;
    const timer = window.setTimeout(run, wait);
    return () => window.clearTimeout(timer);
  }, [html, url, location, kept, compareWith, skipSplit]);

  const venue = view.venue;
  const product = view.product;
  const read = product.read;
  const compared = view.compare.reading === null ? undefined : venue.readings[view.compare.reading];

  return (
    <div className="pc-tool not-content">
      <div className="pc-presets" role="group" aria-label="Examples">
        {RECIPE_SAMPLES.map((sample) => (
          <button
            key={sample.name}
            type="button"
            className="pc-chip"
            aria-pressed={html === sample.html}
            onClick={() => {
              now.current = true;
              chosen.current = true;
              setHtml(sample.html);
              setUrl(sample.url);
              setLocation(sample.location);
              setKept(sample.kept);
              setCompareWith(null);
            }}
          >
            {sample.name}
          </button>
        ))}
      </div>
      <div className="pc-tool-grid">
        <div className="pc-tool-side pc-rr-inputs">
          <label className="pc-field">
            <span>The URL of the page</span>
            <input
              value={url}
              spellcheck={false}
              onInput={(event) => setUrl(event.currentTarget.value)}
            />
          </label>
          <label className="pc-field">
            <span>HTML</span>
            <textarea
              value={html}
              rows={14}
              spellcheck={false}
              onInput={(event) => setHtml(event.currentTarget.value)}
            />
          </label>
          {tab === "hours" ? (
            <>
              <label className="pc-field">
                <span>
                  The address of the venue, for a page with more than one location (
                  <code>location</code>)
                </span>
                <input
                  value={location}
                  spellcheck={false}
                  placeholder="for example 40 Corso Esempio"
                  onInput={(event) => setLocation(event.currentTarget.value)}
                />
              </label>
              <label className="pc-field">
                <span>The hours that you keep, in OpenStreetMap notation</span>
                <input
                  value={kept}
                  spellcheck={false}
                  placeholder="for example Tu-Su 07:00-15:00"
                  onInput={(event) => setKept(event.currentTarget.value)}
                />
              </label>
            </>
          ) : null}
        </div>

        <div className="pc-tool-side" aria-live="polite" aria-busy={busy}>
          {busy ? <p className="pc-empty">The readers read the page…</p> : null}
          {!view.ok ? <p className="pc-empty">The reader stopped: {view.error}</p> : null}
          {view.blocked !== null ? (
            <div className="pc-callout pc-callout-stop">
              <strong>A wall: {view.blocked} sent a bot check</strong>
              <span>
                This page is not the content. The crawler keeps no document for it. Thus{" "}
                <code>readProduct</code> gives <code>wall: true</code> and a note, and{" "}
                <code>readVenue</code> reads no hours. The crawler does not try a different
                identity.
              </span>
            </div>
          ) : null}

          <div className="pc-toggle pc-rr-tabs" role="group" aria-label="The reader">
            <button
              type="button"
              aria-pressed={tab === "hours"}
              aria-controls="pc-rr-panel"
              onClick={() => setTab("hours")}
            >
              Opening hours ({venue.readings.length})
            </button>
            <button
              type="button"
              aria-pressed={tab === "product"}
              aria-controls="pc-rr-panel"
              onClick={() => setTab("product")}
            >
              Product ({read.found ? "found" : "none"})
            </button>
          </div>

          <div
            className="pc-rr-panel"
            id="pc-rr-panel"
            role="region"
            aria-label={tab === "hours" ? "The venue reader" : "The product reader"}
          >
            {tab === "hours" ? (
              <>
                <p className="pc-rr-lead">
                  <code>venueReadingsOf</code> reads the JSON-LD records of a venue and the text of
                  the page. Each reading has a rank: JSON-LD is 0, a text below an hours heading is
                  1, and a different schedule is 4.
                </p>
                {venue.notes.length > 0 ? (
                  <ul className="pc-notes">
                    {venue.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}
                {venue.disagree.length > 0 ? (
                  <div className="pc-callout pc-callout-warn">
                    <strong>The readings disagree on {days(venue.disagree)}</strong>
                    <span>
                      Two readings of the whole schedule (rank 2 or less) give different hours.{" "}
                      <code>readVenue</code> names these days in <code>disagree</code>. The
                      application decides which reading is true.
                    </span>
                  </div>
                ) : null}
                {venue.readings.length === 0 ? (
                  <p className="pc-empty">The reader found no hours on this page.</p>
                ) : (
                  venue.readings.map((reading, index) => (
                    <Reading
                      key={`${reading.from}-${reading.hours}-${String(index)}`}
                      reading={reading}
                      index={index}
                      best={venue.best === index}
                      fromSite={venue.fromSite === index}
                    />
                  ))
                )}
                {venue.phone !== null || venue.menus.length > 0 ? (
                  <dl className="pc-facts">
                    <div>
                      <dt>Phone</dt>
                      <dd>{venue.phone ?? "none"}</dd>
                    </div>
                    <div>
                      <dt>Menu links</dt>
                      <dd>
                        {venue.menus.length === 0
                          ? "none"
                          : venue.menus.map((menu) => menu.url).join(", ")}
                      </dd>
                    </div>
                  </dl>
                ) : null}

                <section className="pc-rr-compare" aria-label="Compare with the kept hours">
                  <p className="pc-out-title">Compare with the hours that you keep</p>
                  <p className="pc-rr-lead">
                    <code>compareHours</code> compares the kept hours with one reading, day by day.
                    Select the reading.
                  </p>
                  {venue.readings.length > 1 ? (
                    <div className="pc-presets" role="group" aria-label="The reading to compare">
                      {venue.readings.map((reading, index) => (
                        <button
                          key={`compare-${String(index)}`}
                          type="button"
                          className="pc-chip"
                          aria-pressed={view.compare.reading === index}
                          onClick={() => setCompareWith(index)}
                        >
                          {`Reading ${String(index + 1)}: ${SOURCE[reading.from]}`}
                          {venue.fromSite === index ? " (from_site)" : ""}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <label className="pc-rr-check">
                    <input
                      type="checkbox"
                      checked={skipSplit}
                      onChange={(event) => setSkipSplit(event.currentTarget.checked)}
                    />
                    <span>
                      Do not compare a day with two intervals (<code>skipSplit</code>)
                    </span>
                  </label>
                  {view.compare.keptError !== null ? (
                    <p className="pc-empty">{view.compare.keptError}</p>
                  ) : null}
                  {view.compare.result !== null && compared !== undefined ? (
                    <>
                      <p className={`pc-rr-verdict pc-rr-${view.compare.result.status}`}>
                        <code>compareHours</code> gives{" "}
                        <strong>{view.compare.result.status}</strong>
                        {view.compare.result.status === "changed"
                          ? `: ${days(view.compare.result.days)} changed.`
                          : view.compare.result.status === "new"
                            ? ": you keep no hours, so each day of the reading is new."
                            : ": each day that the two weeks state is the same."}
                      </p>
                      <div className="pc-table-wrap">
                        <table className="pc-table pc-rr-days">
                          <thead>
                            <tr>
                              <th scope="col">Day</th>
                              <th scope="col">Kept</th>
                              <th scope="col">{`Reading ${String((view.compare.reading ?? 0) + 1)}`}</th>
                              <th scope="col">Result</th>
                            </tr>
                          </thead>
                          <tbody>
                            {view.compare.days.map((day) => (
                              <tr key={day.day} className={`pc-rr-day-${day.status}`}>
                                <th scope="row">{LABEL[day.day] ?? day.day}</th>
                                <td>{day.kept}</td>
                                <td>{day.reading}</td>
                                <td>
                                  <span className="pc-rr-mark" aria-hidden="true">
                                    {STATUS[day.status]?.mark}
                                  </span>{" "}
                                  {STATUS[day.status]?.text}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="pc-rr-small">
                        A change is not a fact yet. Confirm it with a second reading, as a watch
                        does.
                      </p>
                    </>
                  ) : venue.readings.length === 0 ? null : (
                    <p className="pc-empty">Give the kept hours to compare them.</p>
                  )}
                </section>
              </>
            ) : (
              <>
                <p className="pc-rr-lead">
                  <code>productOf</code> reads the schema.org Product data. A page often has more
                  Product records: related products, and products that other people bought.{" "}
                  <code>pickProduct</code> picks the product of the page.
                </p>
                {!read.found ? (
                  <ul className="pc-notes">
                    {read.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : (
                  <>
                    <dl className="pc-facts">
                      <div>
                        <dt>Name</dt>
                        <dd>{read.name ?? "none"}</dd>
                      </div>
                      <div>
                        <dt>Brand</dt>
                        <dd>{read.brand ?? "none"}</dd>
                      </div>
                      <div>
                        <dt>SKU and GTIN</dt>
                        <dd>
                          {read.sku ?? "none"}, {read.gtin ?? "none"}
                        </dd>
                      </div>
                      <div>
                        <dt>Price</dt>
                        <dd>
                          {money(read.price)}
                          {read.price_to !== null ? ` to ${money(read.price_to)}` : ""}
                          {read.price !== null ? (
                            <span className="pc-rr-sub">the page writes “{read.price.raw}”</span>
                          ) : null}
                        </dd>
                      </div>
                      <div>
                        <dt>Availability</dt>
                        <dd>
                          <code>{read.availability ?? "none"}</code>
                          {read.availabilities.length > 1 ? (
                            <span className="pc-rr-sub">of {read.availabilities.join(", ")}</span>
                          ) : null}
                        </dd>
                      </div>
                      <div>
                        <dt>The variant of the URL</dt>
                        <dd>
                          {read.variant === null
                            ? "none"
                            : `${read.variant.name ?? read.variant.sku ?? "a variant"}: ${money(read.variant.price)}`}
                        </dd>
                      </div>
                    </dl>

                    {product.variants.length > 0 ? (
                      <div className="pc-table-wrap">
                        <table className="pc-table">
                          <thead>
                            <tr>
                              <th scope="col">Variant</th>
                              <th scope="col">Price</th>
                              <th scope="col">Old price</th>
                              <th scope="col">Availability</th>
                            </tr>
                          </thead>
                          <tbody>
                            {product.variants.map((variant) => (
                              <tr
                                key={variant.sku ?? variant.name ?? ""}
                                className={variant.named ? "pc-rr-named" : undefined}
                              >
                                <th scope="row">
                                  {variant.name ?? variant.sku}
                                  {variant.named ? " (the URL names it)" : ""}
                                </th>
                                <td>{money(variant.price)}</td>
                                <td>{variant.old === null ? "none" : <s>{variant.old}</s>}</td>
                                <td>
                                  <code>{variant.availability ?? "none"}</code>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}

                    <section className="pc-out" aria-label="The product of the page">
                      <p className="pc-out-title">Which product is the product of the page?</p>
                      <ol className="pc-rr-candidates">
                        {product.candidates.map((candidate) => (
                          <li
                            key={`${candidate.name}-${candidate.url ?? ""}`}
                            className={candidate.picked ? "pc-rr-picked" : undefined}
                          >
                            <span className="pc-rr-mark" aria-hidden="true">
                              {candidate.picked ? "✓" : "·"}
                            </span>
                            <span>
                              <strong>{candidate.name}</strong>
                              {candidate.picked ? " (picked)" : ""}
                              <span className="pc-rr-sub">
                                {candidate.url ?? "no url"},{" "}
                                {candidate.size.toLocaleString("en-US")} characters of JSON
                                {candidate.offers ? ", with offers" : ""}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ol>
                      <p>
                        {product.why === "url"
                          ? "The picked record names this page in its url or its @id, so the reader takes it first."
                          : product.why === "offers"
                            ? "No record names this page, so the reader takes the largest record with offers or variants."
                            : "No record names this page or has offers, so the reader takes the largest record."}
                        {product.without !== null
                          ? ` Without that url, the reader takes ${product.without}: the largest record with offers, and a related product.`
                          : ""}
                      </p>
                    </section>

                    {product.amounts.length > 0 ? (
                      <section className="pc-out" aria-label="How readAmount reads each price">
                        <p className="pc-out-title">
                          How <code>readAmount</code> reads each price
                        </p>
                        <ul className="pc-rr-amounts">
                          {product.amounts.map((amount, index) => (
                            <li key={`${amount.raw}-${String(index)}`}>
                              <code>“{amount.raw}”</code>
                              <span aria-hidden="true">→</span>
                              <span>
                                {amount.amount === null ? "not an amount" : String(amount.amount)}{" "}
                                {amount.currency ?? ""}
                              </span>
                              {amount.old ? (
                                <span className="pc-tag">an old price: not the price</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                    {read.notes.length > 0 ? (
                      <ul className="pc-notes">
                        {read.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
