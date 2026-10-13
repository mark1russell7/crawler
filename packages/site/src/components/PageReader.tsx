/**
 * "What the crawler sees" reads the pasted HTML with `extractPage`, the page reader of the crawler.
 * It shows the JSON-LD, the visible text, the links and the decision about JavaScript. A worker reads
 * the page, so a large page does not stop the tool. The page gives the result of the first example.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { PageRead } from "../lib/page-read.ts";
import { PAGE_SAMPLES } from "../lib/page-samples.ts";

/** The wait after the last key press before the reader starts. */
const DEBOUNCE_MS = 250;

/** The page reader. */
export default function PageReader({ initial }: { readonly initial: PageRead }): ReactElement {
  const [html, setHtml] = useState(PAGE_SAMPLES[0]!.html);
  const [url, setUrl] = useState(PAGE_SAMPLES[0]!.url);
  const [page, setPage] = useState<PageRead>(initial);
  const [busy, setBusy] = useState(false);
  const worker = useRef<Worker | undefined>(undefined);
  const running = useRef(false);
  const job = useRef(0);
  const first = useRef(true);
  const now = useRef(false);

  useEffect(() => () => worker.current?.terminate(), []);

  useEffect(() => {
    // the first render shows the result that the build made
    if (first.current) {
      first.current = false;
      return;
    }
    const id = ++job.current;
    const show = (result: PageRead): void => {
      if (id !== job.current) return;
      running.current = false;
      setPage(result);
      setBusy(false);
    };
    const run = (): void => {
      setBusy(true);
      if (typeof Worker === "undefined") {
        void import("../lib/page-read.ts").then(({ readPage }) => show(readPage(html, url)));
        return;
      }
      // a reader that is still busy with an old page stops, so the newest text wins
      if (running.current) {
        worker.current?.terminate();
        worker.current = undefined;
      }
      worker.current ??= new Worker(new URL("../lib/page-worker.ts", import.meta.url), { type: "module" });
      worker.current.onmessage = (event: MessageEvent<{ id: number; result: PageRead }>) => {
        if (event.data.id === id) show(event.data.result);
      };
      running.current = true;
      worker.current.postMessage({ id, html, url });
    };
    const wait = now.current ? 0 : DEBOUNCE_MS;
    now.current = false;
    const timer = window.setTimeout(run, wait);
    return () => window.clearTimeout(timer);
  }, [html, url]);

  const types = page.types.length === 0 ? "none" : page.types.join(", ");

  return (
    <div className="pc-tool not-content">
      <div className="pc-presets" role="group" aria-label="Examples">
        {PAGE_SAMPLES.map((sample) => (
          <button
            key={sample.name}
            type="button"
            className="pc-chip"
            aria-pressed={html === sample.html}
            onClick={() => {
              now.current = true;
              setHtml(sample.html);
              setUrl(sample.url);
            }}
          >
            {sample.name}
          </button>
        ))}
      </div>
      <div className="pc-tool-grid">
        <div className="pc-tool-side">
          <label className="pc-field">
            <span>The URL of the page</span>
            <input value={url} spellcheck={false} onChange={(event) => setUrl(event.currentTarget.value)} />
          </label>
          <label className="pc-field">
            <span>HTML</span>
            <textarea value={html} rows={16} spellcheck={false} onChange={(event) => setHtml(event.currentTarget.value)} />
          </label>
        </div>
        <div className="pc-tool-side" aria-live="polite" aria-busy={busy}>
          {busy ? <p className="pc-empty">The reader reads the page…</p> : null}
          {!page.ok ? (
            <p className="pc-empty">The reader stopped: {page.error}</p>
          ) : (
            <>
              {page.blocked !== null ? (
                <div className="pc-callout pc-callout-warn">
                  <strong>A bot check sent its page</strong>
                  <span>
                    {`This is the page of ${page.blocked}, not the content. The crawler does not open a browser to get past it.`}
                  </span>
                </div>
              ) : page.redirect !== null ? (
                <div className="pc-callout pc-callout-warn">
                  <strong>The page moved</strong>
                  <span>{`A meta refresh sends the reader to ${page.redirect}. The crawler does not render this page.`}</span>
                </div>
              ) : (
                <div className={`pc-callout ${page.needsRender ? "pc-callout-warn" : "pc-callout-ok"}`}>
                  <strong>{page.needsRender ? "This page needs a browser" : "No browser necessary"}</strong>
                  <span>
                    {page.needsRender
                      ? `The crawler renders it in a headless browser: ${page.renderReason ?? "it shows almost nothing"}.`
                      : `The crawler reads ${page.visibleChars.toLocaleString("en-US")} characters of text with no browser.`}
                  </span>
                </div>
              )}
              <dl className="pc-facts">
                <div>
                  <dt>Title</dt>
                  <dd>{page.titleFromUrl ? "none: the reader uses the URL" : page.title || "none"}</dd>
                </div>
                <div>
                  <dt>Language</dt>
                  <dd>{page.lang ?? "not stated"}</dd>
                </div>
                <div>
                  <dt>Canonical URL</dt>
                  <dd>{page.canonical ?? "none on this site"}</dd>
                </div>
                <div>
                  <dt>JSON-LD types</dt>
                  <dd>
                    {types}
                    {page.brokenJsonLd > 0 ? (
                      <span className="pc-tester-sub">
                        {page.brokenJsonLd === 1 ? "1 JSON-LD block is not correct JSON" : `${String(page.brokenJsonLd)} JSON-LD blocks are not correct JSON`}
                      </span>
                    ) : null}
                  </dd>
                </div>
              </dl>
              {page.notes.length > 0 ? (
                <section className="pc-out" aria-label="What the reader left out">
                  <p className="pc-out-title">What the reader left out</p>
                  <ul className="pc-notes">
                    {page.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section className="pc-out" aria-label="The visible text">
                <p className="pc-out-title">The visible text</p>
                <pre tabIndex={0}>{page.text.length > 0 ? page.text : "(no text)"}</pre>
              </section>
              {page.jsonld.length > 0 ? (
                <section className="pc-out" aria-label="The JSON-LD">
                  <p className="pc-out-title">The JSON-LD</p>
                  <pre tabIndex={0}>{page.jsonld}</pre>
                </section>
              ) : null}
              <section className="pc-out" aria-label="The links">
                <p className="pc-out-title">
                  The links{page.linkCount > page.links.length ? `: the first ${String(page.links.length)} of ${String(page.linkCount)}` : ""}
                </p>
                {page.links.length === 0 ? (
                  <p className="pc-empty">No links.</p>
                ) : (
                  <ul className="pc-links">
                    {page.links.map((link) => (
                      <li key={link.href}>
                        <span>{link.text || "(no text)"}</span>
                        <code>{link.href}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
