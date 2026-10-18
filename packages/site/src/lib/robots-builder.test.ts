import { decide, parseRobots } from "polite-crawler/robots";
import { describe, expect, it } from "vitest";
import study from "../data/robots-study.json";
import { TRAINING_BLOCK_PATHS, TRAINING_BLOCK_ROBOTS } from "./recipes.ts";
import type { BuilderChoices } from "./robots-builder.ts";
import {
  BUILDER_GROUPS,
  MCP_TOKENS,
  OTHER_TOKEN,
  RECIPE_CHOICES,
  buildRobots,
  cleanPath,
  pathsOf,
} from "./robots-builder.ts";

const tokensOf = (id: string): string[] =>
  BUILDER_GROUPS.find((group) => group.id === id)?.agents.map((agent) => agent.token) ?? [];

describe("the robots.txt builder", () => {
  it("uses the agents of the study, and Bingbot", () => {
    const of = (role: string): string[] =>
      study.agents.filter((agent) => agent.role === role).map((agent) => agent.token);
    expect(new Set(tokensOf("training"))).toEqual(new Set(of("training")));
    expect(new Set(tokensOf("search"))).toEqual(new Set(of("search")));
    expect(new Set(tokensOf("user"))).toEqual(new Set(of("user")));
    expect(tokensOf("engines")).toEqual(["Googlebot", "Bingbot"]);
  });

  it("gives the verdicts of the recipe for the choices of the recipe", () => {
    const built = parseRobots(buildRobots(RECIPE_CHOICES));
    const recipe = parseRobots(TRAINING_BLOCK_ROBOTS);
    const tokens = [...BUILDER_GROUPS.flatMap((group) => group.agents), { token: OTHER_TOKEN }].map(
      (agent) => agent.token,
    );
    for (const path of TRAINING_BLOCK_PATHS.split("\n")) {
      for (const token of tokens)
        expect(decide(built, [token], path).allowed, `${token} on ${path}`).toBe(
          decide(recipe, [token], path).allowed,
        );
      expect(decide(built, MCP_TOKENS, path).allowed).toBe(
        decide(recipe, MCP_TOKENS, path).allowed,
      );
    }
  });

  it("writes the content signal of the recipe", () => {
    expect(buildRobots(RECIPE_CHOICES)).toContain(
      "Content-Signal: search=yes, ai-input=yes, ai-train=no",
    );
    expect(buildRobots({ ...RECIPE_CHOICES, signal: false })).not.toContain("Content-Signal");
  });

  it("refuses Google-Extended and still permits Googlebot", () => {
    const robots = parseRobots(buildRobots(RECIPE_CHOICES));
    expect(decide(robots, ["Google-Extended"], "/").allowed).toBe(false);
    expect(decide(robots, ["Googlebot"], "/").allowed).toBe(true);
  });

  it("keeps a group out of one path", () => {
    const choices: BuilderChoices = {
      ...RECIPE_CHOICES,
      rules: { ...RECIPE_CHOICES.rules, search: "path" },
    };
    const robots = parseRobots(buildRobots(choices));
    expect(decide(robots, ["PerplexityBot"], "/members/news").allowed).toBe(false);
    expect(decide(robots, ["PerplexityBot"], "/").allowed).toBe(true);
    expect(decide(robots, ["PerplexityBot"], "/account/orders").allowed).toBe(false);
  });

  it("lets a named group fetch a private path when the group does not repeat it", () => {
    const choices: BuilderChoices = { ...RECIPE_CHOICES, repeat: false };
    const robots = parseRobots(buildRobots(choices));
    expect(decide(robots, ["Claude-User"], "/account/orders").allowed).toBe(true);
    expect(decide(robots, [OTHER_TOKEN], "/account/orders").allowed).toBe(false);
  });

  it("refuses the MCP server when the file keeps the assistants out", () => {
    const choices: BuilderChoices = {
      ...RECIPE_CHOICES,
      rules: { ...RECIPE_CHOICES.rules, user: "none" },
    };
    const robots = parseRobots(buildRobots(choices));
    const decision = decide(robots, MCP_TOKENS, "/");
    expect(decision.allowed).toBe(false);
    expect(decision.by).toBe("Claude-User");
  });

  it("reads the paths of the reader", () => {
    expect(cleanPath(" members/ ")).toBe("/members/");
    expect(cleanPath("")).toBe("");
    expect(pathsOf("/account/, /cart  checkout")).toEqual(["/account/", "/cart", "/checkout"]);
  });
});
