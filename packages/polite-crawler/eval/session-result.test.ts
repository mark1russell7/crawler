import { describe, expect, it } from "vitest";
import type { Claim } from "./measure.mts";
import {
  checkAnswer,
  markdownOf,
  normalize,
  plainOf,
  promptOf,
  recordOf,
  skippedRecord,
  summarize,
} from "./session-result.mts";

const claim: Claim = {
  id: "rfc-example",
  source: "rfc",
  url: "https://example.com/rfc",
  question: "What does the server send?",
  quote: "The server sends a “hello” — once.",
};

const line = (event: unknown): string => JSON.stringify(event);
const stream = (answer: string, extra: Record<string, unknown> = {}): string =>
  [
    line({
      type: "system",
      subtype: "init",
      tools: ["mcp__crawler__crawl_fetch", "mcp__crawler__crawl_verify"],
    }),
    line({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "mcp__crawler__crawl_fetch" },
          { type: "text", text: "…" },
        ],
      },
    }),
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "mcp__crawler__crawl_verify" }] },
    }),
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "mcp__crawler__crawl_verify" }] },
    }),
    "not json",
    line({
      type: "result",
      subtype: "success",
      result: answer,
      num_turns: 4,
      duration_ms: 9000,
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 4,
      },
      modelUsage: {
        "claude-sonnet-5-5": {
          inputTokens: 10,
          cacheCreationInputTokens: 1000,
          cacheReadInputTokens: 20000,
          outputTokens: 300,
          costUSD: 0.04,
        },
        "claude-haiku-5-5": { inputTokens: 500, outputTokens: 50, costUSD: 0.01 },
      },
      permission_denials: [],
      ...extra,
    }),
  ].join("\n");

describe("the check of an answer", () => {
  it("ignores the differences of quote marks, dashes and white space", () => {
    expect(normalize("a “b”  —\n c")).toBe('a "b" - c');
    expect(checkAnswer('<quote>The server sends a "hello" - once.</quote>', claim.quote)).toBe(
      "verified",
    );
  });

  it("accepts a longer quote that holds the quote of the claim", () => {
    expect(
      checkAnswer("<quote>First. The server sends a “hello” — once. Then.</quote>", claim.quote),
    ).toBe("verified");
  });

  it("tells a part quote, a wrong quote and no quote apart", () => {
    expect(checkAnswer("<quote>The server sends a “hello”</quote>", claim.quote)).toBe("partial");
    expect(checkAnswer("<quote>The client sends nothing.</quote>", claim.quote)).toBe("wrong");
    expect(checkAnswer("The server sends a hello.", claim.quote)).toBe("no-quote");
  });

  it("removes the inline Markdown of a quote, and keeps the words", () => {
    expect(plainOf("The `map()` method of `Array` instances")).toBe(
      "The map() method of Array instances",
    );
    expect(plainOf("a **bold** and _italic_ [link](https://example.com/a) word")).toBe(
      "a bold and italic link word",
    );
    expect(plainOf("snake_case_name and file_name.py stay")).toBe(
      "snake_case_name and file_name.py stay",
    );
  });

  it("gives the URL and the question in the prompt", () => {
    expect(promptOf(claim)).toContain("Page: https://example.com/rfc");
    expect(promptOf(claim)).toContain("Question: What does the server send?");
  });
});

describe("the record of a session", () => {
  it("adds the usage of each model and counts the tool calls", () => {
    const entry = recordOf(
      claim,
      "mcp",
      stream("<quote>The server sends a “hello” — once.</quote>"),
    );
    expect(entry.status).toBe("done");
    expect(entry.check).toBe("verified");
    expect(entry.usage).toEqual({ input: 510, cacheWrite: 1000, cacheRead: 20000, output: 350 });
    expect(entry.costUsd).toBe(0.05);
    expect(entry.tools).toEqual({ mcp__crawler__crawl_fetch: 1, mcp__crawler__crawl_verify: 2 });
    expect(entry.offered).toHaveLength(2);
  });

  it("uses the main usage when the result has no usage of each model", () => {
    const entry = recordOf(claim, "webfetch", stream("", { modelUsage: undefined }));
    expect(entry.usage).toEqual({ input: 1, cacheWrite: 2, cacheRead: 3, output: 4 });
    expect(entry.check).toBe("no-quote");
  });

  it("marks a stream with no result as failed", () => {
    const entry = recordOf(
      claim,
      "mcp",
      line({ type: "system", subtype: "init" }),
      "exit 1: no key",
    );
    expect(entry.status).toBe("failed");
    expect(entry.note).toBe("exit 1: no key");
  });
});

describe("the summary", () => {
  it("counts only the sessions with a result, and projects the cost of the set", () => {
    const records = [
      {
        ...recordOf(claim, "mcp", stream("<quote>The server sends a “hello” — once.</quote>")),
        onPage: true,
      },
      recordOf(
        { ...claim, id: "two" },
        "mcp",
        stream("<quote>wrong words here</quote>", { total_cost_usd: 0.15 }),
      ),
      skippedRecord({ ...claim, id: "three" }, "mcp", "the budget"),
      recordOf(claim, "webfetch", stream("<quote>The server sends a “hello”</quote>")),
    ];
    const [mcp, webfetch] = summarize(records, 30);
    expect(mcp?.sessions).toBe(2);
    expect(mcp?.skipped).toBe(1);
    expect(mcp?.checks.verified).toBe(1);
    expect(mcp?.costUsd).toBeCloseTo(0.2);
    expect(mcp?.costPerVerifiedUsd).toBeCloseTo(0.2);
    expect(mcp?.projectedUsd).toBeCloseTo(3);
    expect(mcp?.onPage).toBe(1);
    expect(mcp?.costPerOnPageUsd).toBeCloseTo(0.2);
    expect(webfetch?.onPage).toBe(0);
    expect(mcp?.medianTurns).toBe(4);
    expect(webfetch?.checks.partial).toBe(1);
    expect(webfetch?.costPerVerifiedUsd).toBeNull();
    const markdown = markdownOf([mcp!, webfetch!], records, "claude-sonnet-5-5");
    expect(markdown).toContain("| mcp | 2 | 1 | 1 |");
    expect(markdown).toContain("| rfc-example | 1 | mcp | done | verified | yes |");
    expect(markdown).toContain("crawl_verify 2");
  });

  it("gives a summary for each arm with records, in the sequence of the arms", () => {
    const answer = "<quote>The server sends a “hello” — once.</quote>";
    const records = [
      recordOf(claim, "webfetch", stream(answer)),
      recordOf(claim, "mcp-quote", stream(answer)),
    ];
    expect(summarize(records, 30).map((arm) => arm.arm)).toEqual(["mcp-quote", "webfetch"]);
  });
});
