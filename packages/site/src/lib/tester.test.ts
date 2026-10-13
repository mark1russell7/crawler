import { decide, parseRobots } from "polite-crawler/robots";
import { describe, expect, it } from "vitest";
import { TRAINING_BLOCK_ROBOTS } from "./recipes.ts";
import { productToken, toPath } from "./tester.ts";

describe("the input of the robots.txt tester", () => {
  it("reads a full URL as its path and query", () => {
    expect(toPath("https://example.com/private/x?page=2")).toEqual({
      path: "/private/x?page=2",
      from: "https://example.com/private/x?page=2",
    });
    expect(toPath("//example.com/private/x").path).toBe("/private/x");
    expect(toPath("www.example.com/private/x").path).toBe("/private/x");
  });

  it("adds the leading slash to a path without one", () => {
    expect(toPath("private/x")).toEqual({ path: "/private/x", from: "private/x" });
    expect(toPath("  /private/x  ")).toEqual({ path: "/private/x" });
  });

  it("finds the product token in a token with a version and in a full User-Agent", () => {
    expect(productToken("MyBot")).toBe("MyBot");
    expect(productToken("MyBot/1.0")).toBe("MyBot");
    expect(productToken("Mozilla/5.0 (compatible; MyBot/1.0; +https://example.com/bot)")).toBe(
      "MyBot",
    );
    expect(
      productToken(
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
      ),
    ).toBe("GPTBot");
    expect(
      productToken(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) MyBot/2.0 Safari/537.36",
      ),
    ).toBe("MyBot");
  });

  it("makes the verdict of a full URL and of a full User-Agent the verdict of the path and the token", () => {
    const robots = parseRobots("User-agent: MyBot\nDisallow: /private/\n");
    const agent = productToken("Mozilla/5.0 (compatible; MyBot/1.0)");
    expect(decide(robots, [agent], toPath("https://example.com/private/x").path).allowed).toBe(
      false,
    );
    expect(decide(robots, [agent], toPath("private/x").path).allowed).toBe(false);
  });
});

describe("the recipe for site owners", () => {
  const robots = parseRobots(TRAINING_BLOCK_ROBOTS);
  const allowed = (tokens: readonly string[], path: string): boolean =>
    decide(robots, tokens, path).allowed;

  it("refuses each training crawler on each path", () => {
    for (const token of [
      "GPTBot",
      "ClaudeBot",
      "CCBot",
      "Google-Extended",
      "Applebot-Extended",
      "Bytespider",
      "meta-externalagent",
    ])
      expect(allowed([token], "/blog/a-post")).toBe(false);
  });

  it("permits the assistants and the search crawlers, except the private path", () => {
    for (const token of [
      "ChatGPT-User",
      "Claude-User",
      "Perplexity-User",
      "OAI-SearchBot",
      "Claude-SearchBot",
      "PerplexityBot",
      "Googlebot",
    ]) {
      expect(allowed([token], "/blog/a-post")).toBe(true);
      expect(allowed([token], "/account/orders")).toBe(false);
    }
  });

  it("lets the MCP server of polite-crawler read a page for an assistant", () => {
    expect(allowed(["PoliteCrawler", "Claude-User"], "/blog/a-post")).toBe(true);
    expect(allowed(["PoliteCrawler", "Claude-User"], "/account/orders")).toBe(false);
  });
});
