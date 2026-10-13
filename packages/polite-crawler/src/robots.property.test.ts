import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  HTML_ROBOTS,
  decide,
  isHtmlRobots,
  matchesPattern,
  normalizePath,
  parseRobots,
  productToken,
  robotsFromResponse,
} from "./robots.ts";

const line = fc.oneof(
  fc.constantFrom(
    "User-agent: *",
    "User-agent: PoliteCrawler",
    "User-agent: Claude-User",
    "Allow: /",
    "Disallow:",
    "Disallow: /",
  ),
  fc
    .tuple(
      fc.constantFrom("Allow", "Disallow", "Crawl-delay", "Sitemap", "Content-Signal"),
      fc.string({ maxLength: 40 }),
    )
    .map(([key, value]) => `${key}: ${value}`),
  fc.string({ maxLength: 60 }),
);
const robotsText = fc.array(line, { maxLength: 60 }).map((lines) => lines.join("\n"));
const path = fc.webPath().map((value) => (value.length === 0 ? "/" : value));

describe("robots.txt matching, for each input", () => {
  it("never throws, and decide always answers", () => {
    fc.assert(
      fc.property(fc.oneof(robotsText, fc.string({ maxLength: 8000 })), path, (text, at) => {
        const decision = decide(parseRobots(text), ["PoliteCrawler", "Claude-User"], at);
        expect(typeof decision.allowed).toBe("boolean");
      }),
    );
  });

  it("always permits /robots.txt, and an empty Disallow never blocks", () => {
    fc.assert(
      fc.property(robotsText, (text) => {
        expect(decide(parseRobots(text), ["PoliteCrawler"], "/robots.txt").allowed).toBe(true);
      }),
    );
    fc.assert(
      fc.property(path, (at) => {
        expect(
          decide(parseRobots("User-agent: *\nDisallow:\n"), ["PoliteCrawler"], at).allowed,
        ).toBe(true);
      }),
    );
  });

  it("gives the same decision for the percent-encoded and the plain form of an unreserved character", () => {
    const unreserved = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~".split(""),
    );
    fc.assert(
      fc.property(
        fc.array(unreserved, { minLength: 1, maxLength: 20 }),
        robotsText,
        (chars, text) => {
          const plain = `/${chars.join("")}`;
          const encoded = `/${chars.map((char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).join("")}`;
          expect(normalizePath(encoded)).toBe(normalizePath(plain));
          const robots = parseRobots(text);
          expect(decide(robots, ["PoliteCrawler"], encoded).allowed).toBe(
            decide(robots, ["PoliteCrawler"], plain).allowed,
          );
        },
      ),
    );
  });

  it("matches a pattern with no star exactly as a prefix", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^\/[a-z/]{0,12}$/),
        fc.stringMatching(/^\/[a-z/]{0,20}$/),
        (pattern, at) => {
          expect(matchesPattern(pattern, at)).toBe(at.startsWith(pattern));
        },
      ),
    );
  });

  it("matches a pathological pattern in linear time", () => {
    const pattern = `/${"*a".repeat(2000)}$`;
    const long = `/${"a".repeat(100_000)}b`;
    const started = performance.now();
    expect(matchesPattern(pattern, long)).toBe(false);
    expect(
      decide(parseRobots(`User-agent: *\nDisallow: ${pattern}\n`), ["PoliteCrawler"], long).allowed,
    ).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("reduces each user agent to the product token that a group names", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z][A-Za-z_-]{0,15}$/),
        fc.stringMatching(/^\d\.\d{1,2}$/),
        (name, version) => {
          fc.pre(
            ![
              "mozilla",
              "applewebkit",
              "khtml",
              "gecko",
              "chrome",
              "safari",
              "version",
              "like",
            ].includes(name.toLowerCase()),
          );
          const token = name.toLowerCase();
          expect(productToken(`${name}/${version}`)).toBe(token);
          expect(
            productToken(`Mozilla/5.0 (compatible; ${name}/${version}; +https://example.com/bot)`),
          ).toBe(token);
        },
      ),
    );
  });
});

describe("a robots.txt that is a web page", () => {
  // the shape of a reCAPTCHA page that a large site sends with a 200 in place of its robots.txt
  const CHALLENGE = `<!DOCTYPE html><html><head><title>Security Verification</title>
<script src="https://www.google.com/recaptcha/api.js"></script></head>
<body><form><div class="g-recaptcha"></div></form></body></html>`;

  it("is unreadable, so nothing is permitted, and a plain robots.txt sent as text/html stays a file", () => {
    const page = robotsFromResponse(
      200,
      "text/html; charset=utf-8",
      new TextEncoder().encode(CHALLENGE),
    );
    expect(page.unreachable).toBe(HTML_ROBOTS);
    expect(decide(page, ["PoliteCrawler"], "/").allowed).toBe(false);
    // no content type, but the body is a page
    expect(robotsFromResponse(200, null, `﻿  <html><body>login</body></html>`).unreachable).toBe(
      HTML_ROBOTS,
    );
    // a misconfigured server that sends a real robots.txt as text/html
    const file = robotsFromResponse(200, "text/html", "User-agent: *\nDisallow: /private\n");
    expect(file.unreachable).toBeUndefined();
    expect(decide(file, ["PoliteCrawler"], "/private/x").allowed).toBe(false);
    expect(isHtmlRobots("text/plain", "User-agent: *\nAllow: /\n")).toBe(false);
    // a 4xx is no robots.txt, and a 5xx is unreachable, as before
    expect(robotsFromResponse(404, "text/html", CHALLENGE).unreachable).toBeUndefined();
    expect(robotsFromResponse(503, "text/html", CHALLENGE).unreachable).toBe("status 503");
  });
});
