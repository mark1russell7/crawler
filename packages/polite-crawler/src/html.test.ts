import { describe, expect, it } from "vitest";
import { canonicalUrl, extractPage, readJsonLd, typesOf } from "./html.ts";

const VENUE = `<!doctype html><html lang="en"><head>
<title>Forno Esempio · Springfield</title>
<meta name="description" content="Wood-fired pizza in Union Square">
<base href="https://toscana.example/">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"Restaurant","name":"Forno Esempio","telephone":"+1-617-555-0100",
   "address":{"@type":"PostalAddress","streetAddress":"12 Main Sq","addressLocality":"Springfield"},
   "openingHours":["Tu-Th 16:00-21:00","Fr-Sa 16:00-22:00"]},
  {"@type":"WebSite","name":"Forno Esempio"}]}</script>
<script type="application/ld+json">{ this is not json }</script>
<style>.x{color:red}</style>
</head><body>
<nav><a href="/menu">Menu</a> <a href="menu#dinner">Dinner menu</a> <a href="/contact?utm_source=ig">Contact</a>
<a href="mailto:hi@toscana.example">Email</a></nav>
<main><h1>Wood-fired pizza</h1><p>Since 2011.</p><script>var tracking = 1;</script></main>
<footer><p>Hours: Tue–Thu 4–9pm, Fri–Sat 4–10pm</p></footer>
</body></html>`;

describe("reading a web page", () => {
  it("reads JSON-LD (graph flattened, broken blocks skipped), title, text and links", () => {
    const page = extractPage(VENUE, "https://toscana.example/");
    expect(page.title).toBe("Forno Esempio · Springfield");
    expect(page.description).toBe("Wood-fired pizza in Union Square");
    expect(page.lang).toBe("en");
    expect(page.jsonld.map((record) => typesOf(record))).toEqual([["Restaurant"], ["WebSite"]]);
    expect(page.jsonld[0]!["openingHours"]).toEqual(["Tu-Th 16:00-21:00", "Fr-Sa 16:00-22:00"]);
    // the text a reader sees: no scripts or styles, one line per block
    expect(page.text).toContain("Wood-fired pizza\nSince 2011.");
    expect(page.text).toContain("Hours: Tue–Thu 4–9pm, Fri–Sat 4–10pm");
    expect(page.text).not.toContain("tracking");
    expect(page.text).not.toContain("color:red");
    // links resolved against <base>, fragment and tracking dropped, deduplicated, mailto skipped
    expect(page.links).toEqual([
      { href: "https://toscana.example/menu", text: "Menu" },
      { href: "https://toscana.example/contact", text: "Contact" },
    ]);
    expect(page.needsRender).toBe(false);
  });

  it("reads a page whose markup puts a tag before <head>, as a browser would", () => {
    const malformed = `<!DOCTYPE html><html lang="en"><meta charset="UTF-8"><head><title>Trattoria Esempio</title></head>
      <body><h1>Cuban kitchen</h1><p>${"Authentic Cuban flavors in Waltham. ".repeat(5)}</p></body></html>`;
    const page = extractPage(malformed, "https://venue.example/");
    expect(page.text).toContain("Authentic Cuban flavors in Waltham.");
    expect(page.needsRender).toBe(false);
    // the optional tags left out altogether, and the title is still not text
    const bare = extractPage(
      `<meta charset="UTF-8"><title>Trattoria Esempio</title><p>${"Open Tuesday to Sunday from 5pm. ".repeat(4)}</p>`,
      "https://venue.example/",
    );
    expect(bare.title).toBe("Trattoria Esempio");
    expect(bare.text.startsWith("Open Tuesday to Sunday from 5pm.")).toBe(true);
    expect(bare.needsRender).toBe(false);
  });

  it("keeps words apart where the markup runs links and options together", () => {
    const page = extractPage(
      `<html><body><nav><a href="/a">Card Offers from Amex</a><a href="/b">Global Dining Access</a></nav>
      <p>See the <a href="/menu">menu</a>. Open <a href="/mon">Mon</a>-Fri.</p>
      <select><option>1 Guest</option><option>2 Guests</option></select>
      <p>${"A neighborhood restaurant with a long story. ".repeat(3)}</p></body></html>`,
      "https://venue.example/",
    );
    expect(page.text.split("\n").slice(0, 4)).toEqual([
      "Card Offers from Amex Global Dining Access",
      "See the menu. Open Mon-Fri.",
      "1 Guest",
      "2 Guests",
    ]);
  });

  it("knows a page that shows nothing without JavaScript", () => {
    const shell =
      '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
    expect(extractPage(shell, "https://spa.example/")).toMatchObject({
      needsRender: true,
      renderReason: "only 0 characters of visible text",
    });
    const asks = `<html><body><noscript>You need to enable JavaScript to run this app.</noscript><p>${"Loading the menu… ".repeat(20)}</p></body></html>`;
    expect(extractPage(asks, "https://spa.example/").renderReason).toBe(
      "the page asks for JavaScript",
    );
  });

  it("leads a long page with its article and keeps every other line, a table row as one", () => {
    const paragraph =
      "<p>The story of our family's bakery and its hearth is a long one, told here in full.</p>";
    // minified markup, no whitespace between blocks: the lines must not run together
    const long = `<html><body><header><a href="/">Home</a></header><article><h1>Our story</h1>${paragraph.repeat(90)}<p>The second chapter.</p></article><aside><h2>Hours</h2><table><tbody><tr><td>Sunday</td><td>10 am–5 pm</td></tr><tr><td>Tuesday</td><td>Closed</td></tr></tbody></table></aside><footer><p>40 Elm St</p></footer></body></html>`;
    const page = extractPage(long, "https://bakery.example/story");
    expect(page.visibleChars).toBeGreaterThan(6000);
    const lines = page.text.split("\n");
    expect(lines[0]).toBe("Our story");
    expect(lines).toContain("The second chapter.");
    // the article is not repeated after the marker
    const rest = lines.slice(lines.indexOf("[the rest of the page]") + 1);
    expect(rest).toEqual(["Home", "Hours", "Sunday 10 am–5 pm", "Tuesday Closed", "40 Elm St"]);
  });

  it("spells a URL one way", () => {
    expect(canonicalUrl("https://Venue.EXAMPLE:443/menu?utm_source=x&page=2#top")).toBe(
      "https://venue.example/menu?page=2",
    );
  });

  it("reads JSON-LD written as an array, and names types without the vocabulary prefix", () => {
    const records = readJsonLd([
      '[{"@type":"http://schema.org/Event","name":"Trivia"},{"@type":["Bar","Restaurant"]}]',
    ]);
    expect(records.map((record) => typesOf(record))).toEqual([["Event"], ["Bar", "Restaurant"]]);
  });
});
