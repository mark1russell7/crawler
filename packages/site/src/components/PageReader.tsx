/**
 * "What the crawler sees" reads the pasted HTML with `extractPage`, the page reader of the crawler.
 * It shows the JSON-LD, the visible text, the links and the decision about JavaScript.
 */
import { useMemo, useState, type ReactElement } from "react";
import { extractPage, typesOf } from "polite-crawler/html";

const SAMPLES: ReadonlyArray<{ readonly name: string; readonly url: string; readonly html: string }> = [
  {
    name: "A restaurant with JSON-LD",
    url: "https://forno.example/",
    html: `<!doctype html>
<html lang="en">
<head>
  <title>Forno Esempio · Wood-fired bread</title>
  <meta name="description" content="A neighborhood bakery.">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Bakery","name":"Forno Esempio",
   "telephone":"+1-555-0100","openingHours":["Tu-Su 07:00-15:00"],
   "address":{"@type":"PostalAddress","streetAddress":"12 Main St","addressLocality":"Springfield"}}
  </script>
</head>
<body>
  <nav><a href="/">Home</a> <a href="/menu">Menu</a> <a href="/hours-location">Hours &amp; Location</a></nav>
  <h1>Forno Esempio</h1>
  <p>Wood-fired bread, baked every morning before dawn.</p>
  <footer><p>Tuesday to Sunday, 7am to 3pm</p><p>12 Main St</p></footer>
</body>
</html>`,
  },
  {
    name: "An app shell",
    url: "https://app.example/venue/42",
    html: `<!doctype html>
<html lang="en">
<head><title>Book a table</title></head>
<body>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <div id="root"></div>
  <script src="/static/js/main.4f2a.js"></script>
</body>
</html>`,
  },
  {
    name: "Hours in a table",
    url: "https://museum.example/visit",
    html: `<!doctype html>
<html lang="en">
<head><title>Visit the museum</title></head>
<body>
  <h1>Plan your visit</h1>
  <table>
    <tr><td>Monday</td><td>10 am–5 pm</td></tr>
    <tr><td>Tuesday</td><td>Closed</td></tr>
    <tr><td>Wednesday</td><td>10 am–5 pm</td></tr>
    <tr><td>Thursday–Friday</td><td>10 am–10 pm</td></tr>
  </table>
  <p>Tickets <a href="/tickets">online</a> or at the door.</p>
</body>
</html>`,
  },
];

/** The page reader. */
export default function PageReader(): ReactElement {
  const [html, setHtml] = useState(SAMPLES[0]!.html);
  const [url, setUrl] = useState(SAMPLES[0]!.url);
  const read = useMemo(() => {
    try {
      return { page: extractPage(html, url.trim().length > 0 ? url : "https://example.com/"), error: undefined };
    } catch (error) {
      return { page: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  }, [html, url]);
  const page = read.page;

  return (
    <div className="pc-tool not-content">
      <div className="pc-presets" role="group" aria-label="Examples">
        {SAMPLES.map((sample) => (
          <button
            key={sample.name}
            type="button"
            className="pc-chip"
            aria-pressed={html === sample.html}
            onClick={() => {
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
            <input value={url} spellCheck={false} onChange={(event) => setUrl(event.target.value)} />
          </label>
          <label className="pc-field">
            <span>HTML</span>
            <textarea value={html} rows={16} spellCheck={false} onChange={(event) => setHtml(event.target.value)} />
          </label>
        </div>
        <div className="pc-tool-side" aria-live="polite">
          {page === undefined ? (
            <p className="pc-empty">The reader stopped: {read.error}</p>
          ) : (
            <>
              <div className={`pc-callout ${page.needsRender ? "pc-callout-warn" : "pc-callout-ok"}`}>
                <strong>{page.needsRender ? "This page needs a browser" : "No browser necessary"}</strong>
                <span>
                  {page.needsRender
                    ? `The crawler renders it in a headless browser: ${page.renderReason ?? "it shows almost nothing"}.`
                    : `The crawler reads ${page.visibleChars.toLocaleString("en-US")} characters of text with no browser.`}
                </span>
              </div>
              <dl className="pc-facts">
                <div>
                  <dt>Title</dt>
                  <dd>{page.title || "none"}</dd>
                </div>
                <div>
                  <dt>Language</dt>
                  <dd>{page.lang ?? "not stated"}</dd>
                </div>
                <div>
                  <dt>JSON-LD types</dt>
                  <dd>{page.jsonld.length === 0 ? "none" : [...new Set(page.jsonld.flatMap(typesOf))].join(", ")}</dd>
                </div>
              </dl>
              <section className="pc-out">
                <h3>The visible text</h3>
                <pre>{page.text.length > 0 ? page.text : "(no text)"}</pre>
              </section>
              {page.jsonld.length > 0 ? (
                <section className="pc-out">
                  <h3>The JSON-LD</h3>
                  <pre>{JSON.stringify(page.jsonld, null, 2)}</pre>
                </section>
              ) : null}
              <section className="pc-out">
                <h3>The links</h3>
                {page.links.length === 0 ? (
                  <p className="pc-empty">No links.</p>
                ) : (
                  <ul className="pc-links">
                    {page.links.slice(0, 20).map((link) => (
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
