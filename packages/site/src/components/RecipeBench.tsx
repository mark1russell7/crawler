/**
 * The recipe bench of the guide "Write a recipe". It starts the real recipe of `lib/recipe-example.ts`
 * in the browser. `defineRecipe` made it, `request` gives the request of an input, and the
 * extractor reads a captured body into documents. Then `locate` finds a quote, as `verify` does.
 * The crawler does not fetch here: the bench gives the body of the capture.
 */
import { useEffect, useState, type ReactElement } from "react";
import type { ExtractedDoc } from "polite-crawler";
import { locate } from "polite-crawler";
import { menu } from "../lib/recipe-example.ts";

type Answer = "json" | "maintenance" | "no-name";

const DAYS = ["tue", "sat", "sun"] as const;

const ITEMS: Readonly<Record<string, ReadonlyArray<Record<string, string>>>> = {
  tue: [
    { id: "rye", name: "Dark rye loaf", price: "6.50 EUR", notes: "Baked on Tuesdays and Fridays" },
    { id: "focaccia", name: "Focaccia with rosemary", price: "4.00 EUR" },
  ],
  sat: [
    { id: "cornetto", name: "Cornetto with apricot jam", price: "1.80 EUR" },
    { id: "pizza-bianca", name: "Pizza bianca", price: "3.20 EUR", notes: "Until 11 am" },
  ],
  sun: [{ id: "panettone", name: "Small panettone", price: "9.00 EUR", notes: "Sundays only" }],
};

/** This function gives the body that the API of the example answers, as the capture keeps it. */
const bodyOf = (day: string, answer: Answer): string => {
  if (answer === "maintenance")
    return "<!doctype html>\n<html><head><title>Maintenance</title></head>\n<body><p>The menu is in maintenance. Come back soon.</p></body></html>";
  const items = (ITEMS[day] ?? []).map((item, index) =>
    answer === "no-name" && index === 0 ? { ...item, name: undefined } : item,
  );
  return JSON.stringify({ day, items }, null, 2);
};

const ANSWERS: ReadonlyArray<{ readonly id: Answer; readonly label: string }> = [
  { id: "json", label: "The API answers" },
  { id: "maintenance", label: "A maintenance page" },
  { id: "no-name", label: "An item with no name" },
];

const STAGES = [
  "The input",
  "The request",
  "The capture",
  "The extractor",
  "The documents",
  "find, read, verify",
] as const;

/** The bench. */
export default function RecipeBench(): ReactElement {
  const [day, setDay] = useState<string>("tue");
  const [answer, setAnswer] = useState<Answer>("json");
  const [body, setBody] = useState(() => bodyOf("tue", "json"));
  const [quote, setQuote] = useState("rye");
  const [docs, setDocs] = useState<readonly ExtractedDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  let request: ReturnType<typeof menu.request> | undefined;
  let requestError: string | null = null;
  try {
    request = menu.request(day);
  } catch (thrown) {
    requestError = thrown instanceof Error ? thrown.message : String(thrown);
  }
  const contentType = answer === "maintenance" ? "text/html; charset=utf-8" : "application/json";
  const url = request?.url ?? "";

  useEffect(() => {
    let live = true;
    const bytes = new TextEncoder().encode(body);
    Promise.resolve()
      .then(() => menu.extractor(bytes, { url, contentType }))
      .then(
        (made) => {
          if (!live) return;
          setDocs(made);
          setError(null);
        },
        (thrown: unknown) => {
          if (!live) return;
          setDocs(null);
          setError(thrown instanceof Error ? thrown.message : String(thrown));
        },
      );
    return () => {
      live = false;
    };
  }, [body, url, contentType]);

  const choose = (nextDay: string, nextAnswer: Answer): void => {
    setDay(nextDay);
    setAnswer(nextAnswer);
    setBody(bodyOf(nextDay, nextAnswer));
  };

  const shownRequest =
    request === undefined
      ? null
      : {
          url: request.url,
          mode: request.mode,
          recipe: request.recipe,
          accept: request.accept,
          minIntervalMs: request.minIntervalMs,
          maxAgeMs: request.maxAgeMs,
        };

  return (
    <div className="pc-tool pc-rb not-content">
      <ol className="pc-rb-flow" aria-label="The path of a recipe">
        {STAGES.map((stage, index) => (
          <li
            key={stage}
            className={
              (index === 3 || index === 4) && error !== null ? "pc-rb-flow-stop" : undefined
            }
          >
            <span>{stage}</span>
          </li>
        ))}
      </ol>

      <div className="pc-rb-grid">
        <section className="pc-rb-stage" aria-label="The input and the request">
          <p className="pc-rb-step">1 and 2</p>
          <p className="pc-out-title">
            The input, and <code>menu.request(input)</code>
          </p>
          <div className="pc-presets" role="group" aria-label="The input">
            {DAYS.map((one) => (
              <button
                key={one}
                type="button"
                className="pc-chip pc-chip-code"
                aria-pressed={day === one}
                onClick={() => choose(one, answer)}
              >
                "{one}"
              </button>
            ))}
          </div>
          <div className="pc-out">
            <pre tabIndex={0}>{requestError ?? JSON.stringify(shownRequest, null, 2)}</pre>
          </div>
          <p className="pc-rb-note">
            The crawler fetches this request. The mode <code>api</code> skips robots.txt, and the
            pace of <code>minInterval</code> applies. A stored copy younger than <code>maxAge</code>{" "}
            answers with no request.
          </p>
        </section>

        <section className="pc-rb-stage" aria-label="The capture">
          <p className="pc-rb-step">3</p>
          <p className="pc-out-title">The capture: the body that the crawler keeps</p>
          <div className="pc-presets" role="group" aria-label="The answer of the API">
            {ANSWERS.map((one) => (
              <button
                key={one.id}
                type="button"
                className="pc-chip"
                aria-pressed={answer === one.id}
                onClick={() => choose(day, one.id)}
              >
                {one.label}
              </button>
            ))}
          </div>
          <label className="pc-field">
            <span>
              The body, with the type <code>{contentType}</code>. Change it to see what the
              extractor does.
            </span>
            <textarea
              value={body}
              rows={9}
              spellcheck={false}
              onInput={(event) => setBody(event.currentTarget.value)}
            />
          </label>
        </section>

        <section className="pc-rb-stage" aria-label="The extractor and the documents">
          <p className="pc-rb-step">4 and 5</p>
          <p className="pc-out-title">
            <code>menu.extractor(body, capture)</code>
          </p>
          {error !== null ? (
            <div className="pc-callout pc-callout-stop">
              <strong>The extractor threw an error</strong>
              <span>{error}</span>
              <span>
                The runtime keeps the capture and reports the error in <code>error</code>. The fetch
                still succeeds, and no document comes from this capture.
              </span>
            </div>
          ) : docs === null ? (
            <p className="pc-empty">The extractor reads the body…</p>
          ) : (
            <>
              <p className="pc-rb-note">
                {docs.length === 1 ? "One document" : `${String(docs.length)} documents`} from one
                capture. The extractor checked each one: an id, a kind, a title, a text and a URL.
              </p>
              <ul className="pc-rb-docs">
                {docs.map((doc) => (
                  <li key={doc.doc}>
                    <code>{doc.doc}</code>
                    <strong>{doc.title}</strong>
                    <span>{doc.text}</span>
                    <span className="pc-rb-meta">
                      kind <code>{doc.kind}</code>, meta <code>{JSON.stringify(doc.meta)}</code>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="pc-rb-stage" aria-label="Verify a quote">
          <p className="pc-rb-step">6</p>
          <p className="pc-out-title">The index: find, read and verify</p>
          <p className="pc-rb-note">
            The documents go into the index as versions. <code>find</code> searches them,{" "}
            <code>read</code> gives a range of a text, and <code>verify</code> finds the exact span
            of a quote, with the capture to cite.
          </p>
          <label className="pc-field">
            <span>A quote to verify</span>
            <input
              value={quote}
              spellcheck={false}
              onInput={(event) => setQuote(event.currentTarget.value)}
            />
          </label>
          {docs === null || docs.length === 0 ? (
            <p className="pc-empty">No document to verify.</p>
          ) : (
            <ul className="pc-rb-verify">
              {docs.map((doc) => {
                const hit = quote.trim().length === 0 ? undefined : locate(doc.text, quote);
                return (
                  <li key={doc.doc} className={hit?.found === true ? "pc-rb-found" : undefined}>
                    <code>{doc.doc}</code>
                    {hit === undefined ? (
                      <span>Type a quote.</span>
                    ) : hit.found && hit.start !== null && hit.end !== null ? (
                      <span>
                        ✓ found at the characters {hit.start} to {hit.end}:{" "}
                        {doc.text.slice(0, hit.start)}
                        <mark>{doc.text.slice(hit.start, hit.end)}</mark>
                        {doc.text.slice(hit.end)}
                      </span>
                    ) : (
                      <span>✗ not in this document</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
