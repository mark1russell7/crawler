import { describe, expect, it } from "vitest";
import historyData from "../data/study-history.json";
import { FEED_URL, studyFeed, xmlEscape } from "./feed.ts";
import type { StudyHistory, StudyRun } from "./runs.ts";

const history = historyData as unknown as StudyHistory;

/**
 * This function checks that a text is well-formed XML: one root element, each tag closed in sequence,
 * each attribute in quotes, and each `&` an entity. It gives the elements, so a test can count them.
 * It is strict for the XML that the feed writes: no comments, no CDATA and no DTD.
 */
const parseXml = (
  xml: string,
): Array<{ name: string; attrs: Record<string, string>; text: string }> => {
  const body = xml.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/, "");
  if (body === xml) throw new Error("no XML declaration");
  const elements: Array<{ name: string; attrs: Record<string, string>; text: string }> = [];
  const open: Array<{ name: string; attrs: Record<string, string>; text: string }> = [];
  let roots = 0;
  const token =
    /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<&]*(?:&(?:amp|lt|gt|quot|apos);[^"<&]*)*")*)\s*(\/?)>|([^<]+)/gy;
  let at = 0;
  for (let match = token.exec(body); match !== null; match = token.exec(body)) {
    at = token.lastIndex;
    const [, close, name, attrText, self, text] = match;
    if (text !== undefined) {
      if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(text))
        throw new Error(`a bare & in ${text.slice(0, 40)}`);
      if (text.includes(">")) throw new Error(`a bare > in ${text.slice(0, 40)}`);
      const top = open.at(-1);
      if (top === undefined) {
        if (text.trim().length > 0) throw new Error("text outside the root");
      } else top.text += text;
      continue;
    }
    if (close === "/") {
      const top = open.pop();
      if (top?.name !== name) throw new Error(`</${String(name)}> closes <${String(top?.name)}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [, key, value] of (attrText ?? "").matchAll(/([\w:.-]+)="([^"]*)"/g)) {
      if (key === undefined || key in attrs) throw new Error(`a repeated attribute ${String(key)}`);
      attrs[key] = value ?? "";
    }
    const element = { name: name ?? "", attrs, text: "" };
    if (open.length === 0) roots += 1;
    elements.push(element);
    if (self !== "/") open.push(element);
  }
  if (at !== body.length) throw new Error(`not XML at ${body.slice(at, at + 40)}`);
  if (open.length > 0) throw new Error(`<${String(open.at(-1)?.name)}> is not closed`);
  if (roots !== 1) throw new Error(`${String(roots)} root elements`);
  return elements;
};

const unescape = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const run = (version: string, doi: string | null): StudyRun => ({
  version,
  doi,
  fetched: { from: `${version}T06:17:00.000Z`, to: `${version}T06:18:30.000Z` },
  list: { id: "TEST1", date: version, size: 1000 },
  answered: 500,
  states: { file: 450, none: 50, blocked: 100, unreachable: 400 },
  agents: ["GPTBot", "ClaudeBot", "ChatGPT-User", "Claude-User"].map((token) => ({
    token,
    refused: 100,
    byName: 60,
    byStar: 40,
    welcomed: 10,
    share: 20,
  })),
});

describe("the feed of the monthly runs", () => {
  it("is well-formed RSS 2.0 with one item for each run of the history", () => {
    const sizes = Object.fromEntries(history.runs.map((entry) => [entry.version, 174981]));
    const xml = studyFeed(history, sizes, "10.5281/zenodo.23443374");
    const elements = parseXml(xml);
    expect(elements[0]).toMatchObject({ name: "rss", attrs: { version: "2.0" } });
    expect(elements.filter((element) => element.name === "channel")).toHaveLength(1);
    expect(elements.filter((element) => element.name === "item")).toHaveLength(history.runs.length);
    const self = elements.find((element) => element.name === "atom:link");
    expect(self?.attrs).toMatchObject({ href: FEED_URL, rel: "self" });
    expect(xml).toContain("https://doi.org/10.5281/zenodo.23443374");
    expect(xml).toContain("https://doi.org/10.5281/zenodo.23443375");
  });

  it("gives each run an item, the newest first, with full addresses and the size of its CSV", () => {
    const two: StudyHistory = {
      runs: [run("2026-10-12", "10.5281/zenodo.1234567"), run("2026-11-02", null)],
    };
    const xml = studyFeed(two, { "2026-10-12": 1000, "2026-11-02": 2000 }, undefined);
    const elements = parseXml(xml);
    const items = elements.filter((element) => element.name === "item");
    expect(items).toHaveLength(2);
    const links = elements.filter((element) => element.name === "link").map((link) => link.text);
    expect(links).toEqual([
      "https://mark1russell7.github.io/crawler/notes/robots-txt-ai-agents/",
      "https://mark1russell7.github.io/crawler/notes/robots-txt-ai-agents/#run-2026-11-02",
      "https://mark1russell7.github.io/crawler/notes/robots-txt-ai-agents/#run-2026-10-12",
    ]);
    const enclosures = elements.filter((element) => element.name === "enclosure");
    expect(enclosures.map((element) => element.attrs)).toEqual([
      {
        url: "https://mark1russell7.github.io/crawler/data/robots-study-2026-11-02.csv",
        length: "2000",
        type: "text/csv",
      },
      {
        url: "https://mark1russell7.github.io/crawler/data/robots-study-2026-10-12.csv",
        length: "1000",
        type: "text/csv",
      },
    ]);
    const guids = elements.filter((element) => element.name === "guid").map((guid) => guid.text);
    expect(new Set(guids).size).toBe(2);
    expect(elements.find((element) => element.name === "pubDate")?.text).toBe(
      "Mon, 02 Nov 2026 06:18:30 GMT",
    );
    // each address in the HTML of an item is a full address
    const html = elements
      .filter((element) => element.name === "description")
      .slice(1)
      .map((element) => unescape(element.text));
    const hrefs = html.flatMap((text) => [...text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]));
    expect(hrefs.length).toBeGreaterThan(4);
    for (const href of hrefs) expect(href).toMatch(/^https:\/\//);
    expect(html[0]).toContain("comes after the owner publishes");
    expect(html[1]).toContain('href="https://doi.org/10.5281/zenodo.1234567"');
    expect(html[1]).toContain("20.0% refuse GPTBot");
  });

  it("gives the same text for the same history, and fails when a run has no CSV", () => {
    const one: StudyHistory = { runs: [run("2026-10-12", null)] };
    expect(studyFeed(one, { "2026-10-12": 1 }, undefined)).toBe(
      studyFeed(one, { "2026-10-12": 1 }, undefined),
    );
    expect(() => studyFeed(one, {}, undefined)).toThrow(/no CSV/);
  });

  it("escapes the text of the feed", () => {
    expect(xmlEscape(`a & b <c> "d" 'e'`)).toBe("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;");
    expect(() => parseXml('<?xml version="1.0" encoding="UTF-8"?>\n<a>b & c</a>')).toThrow(
      /bare &/,
    );
    expect(() => parseXml('<?xml version="1.0" encoding="UTF-8"?>\n<a><b></a></b>')).toThrow(
      /closes/,
    );
  });
});
