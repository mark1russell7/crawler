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
    const [article, after] = page.text.split("\n\n");
    const lines = article!.split("\n");
    expect(lines[0]).toBe("Our story");
    expect(lines).toContain("The second chapter.");
    // the article is not repeated after the blank line, and no marker is made up
    expect(after!.split("\n")).toEqual([
      "Home",
      "Hours",
      "Sunday 10 am–5 pm",
      "Tuesday Closed",
      "40 Elm St",
    ]);
  });

  it("keeps a line that the article and a sidebar share in the sidebar too", () => {
    const story = "<p>The story of our family's bakery and its hearth is a long one, told here in full.</p>";
    const html = `<html><body><article><h1>Events this month</h1>${story.repeat(80)}<h3>Saturday</h3><p>10 am – 5 pm</p></article>
      <aside><h2>Hours</h2><dl><dt>Monday</dt><dd>Closed</dd><dt>Tuesday</dt><dd>10 am – 5 pm</dd><dt>Wednesday</dt><dd>10 am – 5 pm</dd></dl></aside></body></html>`;
    const after = extractPage(html, "https://bakery.example/").text.split("\n\n")[1]!;
    expect(after.split("\n")).toEqual([
      "Hours",
      "Monday",
      "Closed",
      "Tuesday",
      "10 am – 5 pm",
      "Wednesday",
      "10 am – 5 pm",
    ]);
  });

  it("keeps the heading above a table that Readability leaves out, and the footer of a long article", () => {
    const story = "<p>The story of our family's bakery and its hearth is a long one, told here in full.</p>";
    const visit = extractPage(
      `<html><body><article><h1>Visit</h1>${story.repeat(80)}<h2>Opening hours</h2></article><aside><table><tr><td>Tue–Sun</td><td>7am–3pm</td></tr></table></aside></body></html>`,
      "https://bakery.example/",
    );
    expect(visit.text.split("\n\n")[1]).toBe("Opening hours\nTue–Sun 7am–3pm");
    const history = extractPage(
      `<html><body><article><h1>History</h1>${story.repeat(800)}</article><footer><h2>Hours</h2><p>Tue–Sun 10 am – 5 pm</p></footer></body></html>`,
      "https://bakery.example/",
    );
    expect(history.text.length).toBeLessThanOrEqual(50_000);
    expect(history.text).toContain("Tue–Sun 10 am – 5 pm");
    expect(history.notes).toContain("the text is cut to 50000 characters");
  });

  it("spells a URL one way", () => {
    expect(canonicalUrl("https://Venue.EXAMPLE:443/menu?utm_source=x&page=2#top")).toBe(
      "https://venue.example/menu?page=2",
    );
    expect(
      canonicalUrl("https://shop.example/p?srsltid=Af1&gbraid=0A&_hsenc=p2&mkt_tok=a&id=7"),
    ).toBe("https://shop.example/p?id=7");
    expect(canonicalUrl("https://shop.example/p?")).toBe("https://shop.example/p");
    expect(canonicalUrl("https://shop.example/%7Euser/a%2fb")).toBe(
      "https://shop.example/~user/a%2Fb",
    );
  });

  it("reads JSON-LD written as an array, and names types without the vocabulary prefix", () => {
    const records = readJsonLd([
      '[{"@type":"http://schema.org/Event","name":"Trivia"},{"@type":["Bar","Restaurant"]}]',
    ]);
    expect(records.map((record) => typesOf(record))).toEqual([["Event"], ["Bar", "Restaurant"]]);
    expect(typesOf({ "@type": "schema:Restaurant" })).toEqual(["Restaurant"]);
  });

  it("repairs the JSON-LD that sites break, and counts what it cannot repair", () => {
    const records = readJsonLd([
      '{"@type":"Restaurant","name":"Trailing comma",}',
      '{"@type":"Bakery","description":"line one\nline two"}',
      '/*<![CDATA[*/{"@type":"Cafe"}/*]]>*/',
      '{"@type":"Bar"} {"@type":"Pub"}',
      '{"@context":"https://schema.org","@graph":{"@type":"Museum"}}',
    ]);
    expect(records.map((record) => typesOf(record)[0])).toEqual([
      "Restaurant",
      "Bakery",
      "Cafe",
      "Bar",
      "Pub",
      "Museum",
    ]);
    expect(records[1]!["description"]).toBe("line one\nline two");
    const page = extractPage(
      `<html><head><script type='application/ld+json; charset=utf-8'>{"@type":"Bakery"}</script>
      <script type="application/ld+json ">{"@type":"Store"}</script><script type="application/ld+json">{ not json</script></head>
      <body><p>${"Fresh bread every morning. ".repeat(5)}</p></body></html>`,
      "https://bakery.example/",
    );
    expect(page.jsonld.map((record) => typesOf(record)[0])).toEqual(["Bakery", "Store"]);
    expect(page.notes).toContain("1 JSON-LD block could not be read");
  });
});

describe("markup that a browser forgives", () => {
  const filler = "We serve wood-fired pizza and fresh pasta made in house every day. ";

  it("reads a page that opens <head> and never closes it, with no <body>", () => {
    const page = extractPage(
      `<!doctype html><html lang=en><head><meta charset=utf-8><title>Bakery</title><link rel=stylesheet href=a.css><main><p>Hours: Tue-Sun 7am-3pm. ${filler}</p></main></html>`,
      "https://bakery.example/",
    );
    expect(page.text).toContain("Hours: Tue-Sun 7am-3pm.");
    expect(page.needsRender).toBe(false);
    expect(page.title).toBe("Bakery");
  });

  it("starts a line at each legacy block element", () => {
    const page = extractPage(
      `<html><body><center>Joe's Diner</center><center>Mon-Fri 6am-2pm</center><center>Sat-Sun 7am-1pm</center>
      <fieldset><legend>Book</legend>Pick a time</fieldset><details><summary>Menu</summary>Pancakes</details>
      <p>${filler}</p></body></html>`,
      "https://diner.example/",
    );
    expect(page.text.split("\n").slice(0, 7)).toEqual([
      "Joe's Diner",
      "Mon-Fri 6am-2pm",
      "Sat-Sun 7am-1pm",
      "Book",
      "Pick a time",
      "Menu",
      "Pancakes",
    ]);
  });

  it("reads the content of a declarative shadow root, and keeps custom elements apart", () => {
    const page = extractPage(
      `<html><body><opening-hours><template shadowrootmode="open"><p>Tue-Sun 11am-9pm</p></template></opening-hours>
      <x-price>12</x-price><x-unit>USD</x-unit><template><p>Never shown</p></template><p>${filler}</p></body></html>`,
      "https://venue.example/",
    );
    expect(page.text).toContain("Tue-Sun 11am-9pm");
    expect(page.text).toContain("12 USD");
    expect(page.text).not.toContain("Never shown");
  });

  it("gives the title of the page, not of an icon, and no empty title or language", () => {
    const body = `<p>${filler}</p>`;
    const read = (html: string) => extractPage(html, "https://x.example/");
    expect(read(`<html><head><title></title></head><body><h1>Heading</h1>${body}</body></html>`).title).toBe(
      "Heading",
    );
    expect(read(`<html><body><svg><title>Icon</title></svg><h1>Heading</h1>${body}</body></html>`).title).toBe(
      "Heading",
    );
    expect(read(`<html lang=""><body>${body}</body></html>`).lang).toBeNull();
  });

  it("keeps links to other pages only, with an image's words, and without credentials", () => {
    const page = extractPage(
      `<html><head><base href="javascript:void(0)"><link rel="canonical" href="/home?utm_source=x"></head><body>
      <a href="#top">Top</a><a href="/menu">Menu</a><a href="/r"><img alt="Reserve a table"></a>
      <a href="https://user:pass@venue.example/p">Private</a><p>${filler}</p></body></html>`,
      "https://venue.example/",
    );
    expect(page.links).toEqual([
      { href: "https://venue.example/menu", text: "Menu" },
      { href: "https://venue.example/r", text: "Reserve a table" },
      { href: "https://venue.example/p", text: "Private" },
    ]);
    expect(page.canonical).toBe("https://venue.example/home");
    // a canonical on another site is not trusted
    const other = `<html><head><link rel="canonical" href="https://other.example/"></head><body><p>${filler}</p></body></html>`;
    expect(extractPage(other, "https://venue.example/").canonical).toBeNull();
  });
});

describe("what a page needs", () => {
  it("follows a meta refresh as a redirect, with no browser", () => {
    const page = extractPage(
      `<html><head><meta http-equiv="refresh" content="0; url='/home'"><title>Redirecting</title></head><body></body></html>`,
      "https://venue.example/",
    );
    expect(page).toMatchObject({
      redirect: "https://venue.example/home",
      needsRender: false,
      links: [{ href: "https://venue.example/home", text: "" }],
    });
    // an anchor to the same target gives the link its text
    const moved = extractPage(
      `<html><head><meta http-equiv="refresh" content="0; url=/new"><title>Moved</title></head><body><p>This page moved. <a href="/new">Go to the new page</a>.</p><a href="/new">again</a></body></html>`,
      "https://venue.example/old",
    );
    expect(moved.links).toEqual([{ href: "https://venue.example/new", text: "Go to the new page" }]);
  });

  it("knows an application root without quotes, and Angular's root element", () => {
    const loading =
      "<p>Loading the restaurant, please wait while we fetch the menu and the hours for you today.</p>";
    for (const root of ["<div id=root></div>", "<app-root></app-root>"]) {
      const page = extractPage(`<html><body>${root}${loading}</body></html>`, "https://spa.example/");
      expect(page.renderReason).toBe("an empty application root");
    }
  });

  it("does not render a short post for the noscript of its comments", () => {
    const post = `<html><body><p>${"Our new spring menu starts on Tuesday. ".repeat(8)}</p>
      <noscript>Please enable JavaScript to view the comments powered by Disqus.</noscript></body></html>`;
    expect(extractPage(post, "https://blog.example/").needsRender).toBe(false);
  });

  it("names a bot check or a firewall page, and does not send it to the browser", () => {
    const incapsula = `<html><head><meta name="robots" content="noindex"></head><body><iframe id="main-iframe" src="/_Incapsula_Resource?CWUDNSAI=9">Request unsuccessful. Incapsula incident ID: 1</iframe></body></html>`;
    expect(extractPage(incapsula, "https://venue.example/")).toMatchObject({
      blocked: "Incapsula",
      needsRender: false,
      renderReason: null,
    });
    const cloudflare = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><h2>Checking if the site connection is secure</h2><noscript>Enable JavaScript and cookies to continue</noscript><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`;
    expect(extractPage(cloudflare, "https://venue.example/")).toMatchObject({
      blocked: "Cloudflare",
      needsRender: false,
    });
  });
});

describe("pages that cost far more than their size", () => {
  const timed = <T>(run: () => T): { readonly value: T; readonly ms: number } => {
    const started = performance.now();
    const value = run();
    return { value, ms: performance.now() - started };
  };

  it("reads a table of 5,000 rows and an article of 1 MB in time that grows with the size", () => {
    const table = `<html><body><table><tbody>${"<tr><td>Monday</td><td>10 am - 5 pm</td></tr>".repeat(5000)}</tbody></table></body></html>`;
    const rows = timed(() => extractPage(table, "https://x.example/"));
    expect(rows.value.text.startsWith("Monday 10 am - 5 pm\n")).toBe(true);
    expect(rows.ms).toBeLessThan(2000);
    const para =
      "<p>The museum is open to visitors and offers guided tours of the permanent collection, with special exhibitions each season.</p>\n";
    const article = `<html><body><article>${para.repeat(Math.floor(1_000_000 / para.length))}</article></body></html>`;
    const big = timed(() => extractPage(article, "https://x.example/"));
    expect(big.value.text.length).toBeLessThanOrEqual(50_000);
    // a walk that read childNodes again for each child took 80 seconds on this page
    expect(big.ms).toBeLessThan(8000);
  }, 30_000);

  it("reads markup nested 20,000 and 400,000 deep without a stack overflow", () => {
    for (const depth of [20_000, 400_000]) {
      const html = `<!doctype html><html><body>${"<div>".repeat(depth)}hello${"</div>".repeat(depth)}<p>after</p></body></html>`;
      const deep = timed(() => extractPage(html, "https://x.example/"));
      expect(deep.value.text).toBe("hello\nafter");
      expect(deep.ms).toBeLessThan(5000);
    }
    const unclosed = extractPage(
      `<html><body>${"<font>item ".repeat(30_000)}</body></html>`,
      "https://x.example/",
    );
    expect(unclosed.text.startsWith("item item item")).toBe(true);
    expect(unclosed.notes[0]).toMatch(/nests deeper than 1000 elements/);
  }, 30_000);

  it("keeps the whole page when Readability fails on it", () => {
    const story =
      "<p>The story of our family's bakery and its hearth is a long one, told here in full.</p>";
    const page = extractPage(`<td><article>${story.repeat(80)}</article>`, "https://x.example/");
    expect(page.text.startsWith("The story of our family's bakery")).toBe(true);
  });
});
