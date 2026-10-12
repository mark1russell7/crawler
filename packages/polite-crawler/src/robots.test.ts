import { describe, expect, it } from "vitest";
import {
  ALLOW_ALL,
  DISALLOW_ALL,
  ROBOTS_MAX_BYTES,
  decide,
  normalizePath,
  parseRobots,
  robotsFromStatus,
} from "./robots.ts";

const allowed = (text: string, token: string, path: string): boolean =>
  decide(parseRobots(text), [token], path).allowed;

// RFC 9309 §5.1, verbatim
const RFC_EXAMPLE = `User-Agent: *
Disallow: *.gif$
Disallow: /example/
Allow: /publications/

User-Agent: foobot
Disallow:/
Allow:/example/page.html
Allow:/example/allowed.gif

User-Agent: barbot
User-Agent: bazbot
Disallow: /example/page.html

User-Agent: quxbot

EOF
`;

describe("robots.txt per RFC 9309", () => {
  it("reads the RFC's own example the way its appendix says", () => {
    // foobot may fetch two pages and nothing else
    expect(allowed(RFC_EXAMPLE, "foobot", "/example/page.html")).toBe(true);
    expect(allowed(RFC_EXAMPLE, "foobot", "/example/allowed.gif")).toBe(true);
    expect(allowed(RFC_EXAMPLE, "foobot", "/publications/")).toBe(false);
    // barbot and bazbot share a group
    expect(allowed(RFC_EXAMPLE, "barbot", "/example/page.html")).toBe(false);
    expect(allowed(RFC_EXAMPLE, "bazbot", "/example/page.html")).toBe(false);
    expect(allowed(RFC_EXAMPLE, "bazbot", "/example/other.html")).toBe(true);
    // quxbot's group is empty: everything, and no fall back to *
    expect(allowed(RFC_EXAMPLE, "quxbot", "/example/page.gif")).toBe(true);
    // anyone else gets *
    expect(allowed(RFC_EXAMPLE, "otherbot", "/example/x.html")).toBe(false);
    expect(allowed(RFC_EXAMPLE, "otherbot", "/image.gif")).toBe(false);
    expect(allowed(RFC_EXAMPLE, "otherbot", "/image.gif?v=2")).toBe(true);
    expect(allowed(RFC_EXAMPLE, "otherbot", "/publications/a")).toBe(true);
  });

  it("lets the longest match win, and allow win a tie", () => {
    const text =
      "User-Agent: foobot\nAllow: /example/page/\nDisallow: /example/page/disallowed.gif\n";
    expect(allowed(text, "foobot", "/example/page/")).toBe(true);
    expect(allowed(text, "foobot", "/example/page/disallowed.gif")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /page\nAllow: /page\n", "x", "/page")).toBe(true);
  });

  it("treats * as any sequence and a trailing $ as the end", () => {
    const text = "User-agent: *\nDisallow: /*.php$\nDisallow: /fish*\n";
    expect(allowed(text, "x", "/index.php")).toBe(false);
    expect(allowed(text, "x", "/index.php?x=1")).toBe(true);
    expect(allowed(text, "x", "/index.phps")).toBe(true);
    expect(allowed(text, "x", "/fishheads/yummy.html")).toBe(false);
    expect(allowed(text, "x", "/Fish.asp")).toBe(true);
  });

  it("compares percent-encoded and plain forms as the same path", () => {
    expect(normalizePath("/%7ejoe/%2fdir")).toBe("/~joe/%2Fdir");
    expect(normalizePath("/foo/ä")).toBe("/foo/%C3%A4");
    expect(allowed("User-agent: *\nDisallow: /~joe/\n", "x", "/%7Ejoe/index.html")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /foo/ä\n", "x", "/foo/%C3%A4")).toBe(false);
  });

  it("matches the product token case-insensitively, ignoring a version", () => {
    const text =
      "User-agent: PoliteCrawler/1.0\nDisallow: /private\n\nUser-agent: *\nDisallow: /\n";
    expect(allowed(text, "politecrawler", "/public")).toBe(true);
    expect(allowed(text, "POLITECRAWLER", "/private/x")).toBe(false);
  });

  it("merges groups that name the same crawler", () => {
    const text =
      "User-agent: a\nDisallow: /one\n\nUser-agent: b\nDisallow: /two\n\nUser-agent: a\nDisallow: /three\n";
    expect(allowed(text, "a", "/one")).toBe(false);
    expect(allowed(text, "a", "/three")).toBe(false);
    expect(allowed(text, "a", "/two")).toBe(true);
  });

  it("ignores rules before any user-agent line, and an empty disallow", () => {
    expect(allowed("Disallow: /\nUser-agent: *\nAllow: /x\n", "bot", "/anything")).toBe(true);
    expect(allowed("User-agent: *\nDisallow:\n", "bot", "/anything")).toBe(true);
  });

  it("always allows /robots.txt itself", () => {
    expect(decide(DISALLOW_ALL, ["bot"], "/robots.txt").allowed).toBe(true);
    expect(decide(DISALLOW_ALL, ["bot"], "/").allowed).toBe(false);
  });

  it("applies Claude-User's rules only where a site wrote them", () => {
    const text = "User-agent: Claude-User\nDisallow: /private\n\nUser-agent: *\nAllow: /\n";
    const robots = parseRobots(text);
    expect(decide(robots, ["PoliteCrawler"], "/private/a").allowed).toBe(true);
    expect(decide(robots, ["PoliteCrawler", "Claude-User"], "/private/a")).toMatchObject({
      allowed: false,
      by: "Claude-User",
    });
    expect(
      decide(parseRobots("User-agent: *\nAllow: /\n"), ["PoliteCrawler", "Claude-User"], "/x").allowed,
    ).toBe(true);
  });

  it("reads crawl-delay, sitemaps and usage preferences", () => {
    const text = [
      "User-agent: *",
      "Content-Signal: search=yes, ai-train=no",
      "Crawl-delay: 4",
      "Allow: /",
      "Sitemap: https://example.com/sitemap.xml",
    ].join("\n");
    const robots = parseRobots(text);
    expect(decide(robots, ["bot"], "/").crawlDelaySeconds).toBe(4);
    expect(robots.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(robots.signals).toEqual(["content-signal: search=yes, ai-train=no"]);
  });

  it("parses the first 500 KiB and no further", () => {
    const filler = `# ${"x".repeat(ROBOTS_MAX_BYTES)}\n`;
    const robots = parseRobots(`User-agent: *\nDisallow: /early\n${filler}Disallow: /late\n`);
    expect(decide(robots, ["bot"], "/early").allowed).toBe(false);
    expect(decide(robots, ["bot"], "/late").allowed).toBe(true);
  });

  it("reads the fetch status: 4xx allows all; 5xx, 429 and silence allow nothing", () => {
    expect(robotsFromStatus(404, "")).toBe(ALLOW_ALL);
    expect(robotsFromStatus(403, "")).toBe(ALLOW_ALL);
    expect(robotsFromStatus(429, "")).toMatchObject({ unreachable: "status 429, rate-limited" });
    expect(robotsFromStatus(503, "")).toMatchObject({ unreachable: "status 503" });
    expect(robotsFromStatus(0, undefined)).toMatchObject({ unreachable: "no response" });
    expect(decide(robotsFromStatus(503, ""), ["bot"], "/").allowed).toBe(false);
    expect(
      decide(robotsFromStatus(200, "User-agent: *\nDisallow: /a\n"), ["b"], "/a").allowed,
    ).toBe(false);
  });
});
