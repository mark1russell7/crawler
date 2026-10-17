import { describe, expect, it } from "vitest";
import type { Meter } from "./sitemaps.ts";
import { feedDate, readSitemap, scanSitemap } from "./sitemaps.ts";
import { urlset } from "./test-site.ts";

const BASE = "https://site.example/sitemap.xml";

/**
 * The reader counts the characters that it examines. For a hostile file, the count stays in
 * proportion to the length: no step reads the text again from an earlier position. The test uses
 * the count, not the time of a clock, so a busy computer cannot change the result.
 */
const linear = (make: (n: number) => string): void => {
  const steps = (n: number): { readonly steps: number; readonly length: number } => {
    const text = make(n);
    const meter: Meter = { steps: 0 };
    scanSitemap(text, BASE, {}, meter);
    return { steps: meter.steps, length: text.length };
  };
  const small = steps(2000);
  const large = steps(32_000);
  expect(small.steps).toBeLessThanOrEqual(4 * small.length + 16);
  expect(large.steps).toBeLessThanOrEqual(4 * large.length + 16);
  // 16 times the input gives about 16 times the steps, not the 256 times of a square
  expect(large.steps).toBeLessThan(24 * small.steps);
};

describe("the sitemap reader", () => {
  it("reads a sitemap: the URLs, the dates and the change frequency", () => {
    const read = readSitemap(
      `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<url><loc>https://site.example/a?x=1&amp;y=2#part</loc><lastmod>2026-10-01</lastmod><changefreq>Daily</changefreq>
  <image:image><image:loc>https://cdn.example/photo.jpg</image:loc></image:image></url>
<url><loc><![CDATA[https://site.example/b]]></loc><lastmod>2026-10-02T10:00</lastmod><changefreq>often</changefreq></url>
<url><loc>/relative</loc></url>
<!-- a comment <url><loc>https://site.example/hidden</loc></url> -->
<url><loc>https://site.example/c?utm_source=mail</loc><lastmod>not a date</lastmod></url>
</urlset>`,
      BASE,
    );
    expect(read).toMatchObject({ kind: "urlset", invalid: 1, complete: true, notes: [] });
    expect(read.entries).toEqual([
      {
        url: "https://site.example/a?x=1&y=2",
        lastmod: "2026-10-01T00:00:00.000Z",
        changefreq: "daily",
      },
      { url: "https://site.example/b", lastmod: "2026-10-02T10:00:00.000Z", changefreq: null },
      { url: "https://site.example/c", lastmod: null, changefreq: null },
    ]);
  });

  it("reads a sitemap index, a sitemap with a prefix, and a text sitemap", () => {
    const index = readSitemap(
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://site.example/s1.xml.gz</loc><lastmod>2026-09-01T00:00:00+02:00</lastmod></sitemap></sitemapindex>`,
      BASE,
    );
    expect(index.kind).toBe("sitemapindex");
    expect(index.entries).toEqual([
      {
        url: "https://site.example/s1.xml.gz",
        lastmod: "2026-08-31T22:00:00.000Z",
        changefreq: null,
      },
    ]);
    const prefixed = readSitemap(
      `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:x="urn:other"><sm:url><sm:loc>https://site.example/p</sm:loc><x:loc>https://site.example/no</x:loc></sm:url></sm:urlset>`,
      BASE,
    );
    expect(prefixed.entries.map((entry) => entry.url)).toEqual(["https://site.example/p"]);
    const text = readSitemap(
      "﻿https://site.example/1\n\nnot a URL\r\nhttps://site.example/2\r\n",
      BASE,
    );
    expect(text).toMatchObject({ kind: "text", invalid: 1, complete: true });
    expect(text.entries.map((entry) => entry.url)).toEqual([
      "https://site.example/1",
      "https://site.example/2",
    ]);
  });

  it("reads an RSS 2.0, an RSS 1.0 and an Atom feed, with their relative links", () => {
    const rss = readSitemap(
      `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><link>https://site.example/</link><atom:link rel="self" href="https://site.example/feed"/>
<item><title>A</title><link>/post/1</link><pubDate>Tue, 07 Oct 2026 12:00:00 GMT</pubDate></item>
<item><link></link><guid>https://site.example/post/2</guid><pubDate>Wed, 08 Oct 2026 09:30:00 +0200</pubDate></item>
<item><guid isPermaLink="false">post-3</guid></item></channel></rss>`,
      "https://site.example/blog/feed.xml",
    );
    expect(rss).toMatchObject({ kind: "rss", invalid: 1 });
    expect(rss.entries).toEqual([
      { url: "https://site.example/post/1", lastmod: "2026-10-07T12:00:00.000Z", changefreq: null },
      { url: "https://site.example/post/2", lastmod: "2026-10-08T07:30:00.000Z", changefreq: null },
    ]);
    const rdf = readSitemap(
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel rdf:about="https://site.example/"/><item rdf:about="https://site.example/r1"><dc:date>2026-10-03</dc:date></item><item rdf:about="https://site.example/x"><link>https://site.example/r2</link></item></rdf:RDF>`,
      BASE,
    );
    expect(rdf.entries.map((entry) => [entry.url, entry.lastmod])).toEqual([
      ["https://site.example/r1", "2026-10-03T00:00:00.000Z"],
      ["https://site.example/r2", null],
    ]);
    const atom = readSitemap(
      `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://site.example/news/"><entry><link rel="enclosure" href="talk.mp3"/><link href="one.pdf" type="application/pdf"/><link href="one.html"/><updated>2026-10-05T00:00:00Z</updated><published>2026-01-01T00:00:00Z</published></entry><entry xml:base="/other/"><link rel="alternate" href="two"/></entry></feed>`,
      "https://site.example/atom.xml",
    );
    expect(atom.kind).toBe("atom");
    expect(atom.entries).toEqual([
      {
        url: "https://site.example/news/one.html",
        lastmod: "2026-10-05T00:00:00.000Z",
        changefreq: null,
      },
      { url: "https://site.example/other/two", lastmod: null, changefreq: null },
    ]);
  });

  it("gives no entry for a page that is not a sitemap, and stops at an error with the entries before it", () => {
    expect(readSitemap("<!doctype html><html><body>Not found</body></html>", BASE)).toMatchObject({
      kind: "unknown",
      entries: [],
      complete: false,
      notes: ["not a sitemap or a feed: the root element is <html>"],
    });
    expect(readSitemap("", BASE)).toMatchObject({ kind: "unknown", complete: false });
    const broken = readSitemap(
      urlset([["https://site.example/1"]]).replace("</urlset>", "<url><loc>x</lox></url></urlset>"),
      BASE,
    );
    expect(broken).toMatchObject({
      complete: false,
      notes: ["the end tag </lox> does not match <loc>"],
    });
    expect(broken.entries).toHaveLength(1);
    const cut = readSitemap(
      urlset([["https://site.example/1"], ["https://site.example/2"]]).slice(0, -30),
      BASE,
    );
    expect(cut).toMatchObject({ complete: false, notes: ["the file ends inside an element"] });
    expect(cut.entries).toHaveLength(1);
    for (const bad of [
      "<urlset><url a=b></url></urlset>",
      '<urlset><url a="b></urlset>',
      "<urlset><!-- open",
    ]) {
      expect(readSitemap(bad, BASE).complete).toBe(false);
    }
  });

  it("stops at the limit of entries", () => {
    const many = urlset(
      Array.from({ length: 30 }, (_, at) => [`https://site.example/${String(at)}`] as const),
    );
    const read = readSitemap(many, BASE, { maxEntries: 10 });
    expect(read).toMatchObject({ complete: false, notes: ["the reader stopped at 10 entries"] });
    expect(read.entries).toHaveLength(10);
    const lines = Array.from({ length: 30 }, (_, at) => `https://site.example/${String(at)}`).join(
      "\n",
    );
    expect(readSitemap(lines, BASE, { maxEntries: 5 })).toMatchObject({ complete: false });
  });

  it("reads dates in the W3C and the mail forms, and gives null for other text", () => {
    expect(feedDate("2026")).toBe("2026-01-01T00:00:00.000Z");
    expect(feedDate("2026-10")).toBe("2026-10-01T00:00:00.000Z");
    expect(feedDate("2026-10-07T12:00:00.5-05:00")).toBe("2026-10-07T17:00:00.500Z");
    expect(feedDate("2026-10-07 12:00")).toBe("2026-10-07T12:00:00.000Z");
    expect(feedDate("Tue, 07 Oct 2026 12:00:00 EST")).toBe("2026-10-07T17:00:00.000Z");
    for (const text of ["1", "yesterday", "", "2026-13-45", "x".repeat(100)]) {
      expect(feedDate(text)).toBeNull();
    }
  });
});

describe("the sitemap reader on hostile files", () => {
  it("expands no entity: a billion-laughs DTD gives no text and no URL", () => {
    const levels = Array.from(
      { length: 9 },
      (_, at) =>
        `<!ENTITY lol${String(at + 1)} "${`&lol${at === 0 ? "" : String(at)};`.repeat(10)}">`,
    ).join("");
    const text = `<?xml version="1.0"?><!DOCTYPE urlset [<!ENTITY lol "lol">${levels}]><urlset><url><loc>https://site.example/&lol9;</loc></url><url><loc>https://site.example/&amp;ok</loc></url><url><loc>https://site.example/&#x41;&#66;</loc></url><url><loc>https://site.example/&#xD800;</loc></url></urlset>`;
    const meter: Meter = { steps: 0 };
    const read = scanSitemap(text, BASE, {}, meter);
    expect(read.notes).toEqual([
      "the file declares a DTD: the reader ignores it and expands no entity",
    ]);
    expect(read.entries.map((entry) => entry.url)).toEqual([
      "https://site.example/&ok",
      "https://site.example/AB",
    ]);
    expect(read.invalid).toBe(2);
    expect(meter.steps).toBeLessThan(4 * text.length);
  });

  it("stops at a deep nesting, and does not keep a long value", () => {
    const deep = `<urlset>${"<a>".repeat(200_000)}`;
    const read = readSitemap(deep, BASE);
    expect(read).toMatchObject({ complete: false, notes: ["the elements nest deeper than 32"] });
    const shallow = readSitemap(`<urlset>${"<a>".repeat(10)}</urlset>`, BASE, { maxDepth: 5 });
    expect(shallow.notes).toEqual(["the elements nest deeper than 5"]);
    const long = readSitemap(
      urlset([[`https://site.example/${"x".repeat(10_000)}`], ["https://site.example/ok"]]),
      BASE,
    );
    expect(long.entries.map((entry) => entry.url)).toEqual(["https://site.example/ok"]);
    expect(long.invalid).toBe(1);
  });

  it("reads hostile files in time that grows in proportion to their length", () => {
    // unclosed constructs that a careless reader searches again from each position
    linear((n) => `<urlset>${"<!".repeat(n)}`);
    linear((n) => `<urlset>${"<a ".repeat(n)}`);
    linear((n) => `<urlset><url b="${"&".repeat(n)}`);
    linear((n) => `<urlset><url><loc>${"&a".repeat(n)}</loc></url></urlset>`);
    linear((n) => `<urlset><url><loc>${"&#x41;".repeat(n)}</loc></url></urlset>`);
    linear((n) => `<!DOCTYPE x [${"[".repeat(n)}`);
    linear(
      (n) => `<urlset>${"<url><loc>https://site.example/a</loc></url>".repeat(n / 8)}</urlset>`,
    );
    linear((n) => `<urlset>${"<![CDATA[".repeat(n)}`);
    linear((n) => `<urlset>${"<a></a>".repeat(n)}</urlset>`);
    linear((n) => `${"https://site.example/x\n".repeat(n / 4)}`);
    linear((n) => `<rss><channel>${"<item><link>/a</link></item>".repeat(n / 8)}</channel></rss>`);
  });
});
