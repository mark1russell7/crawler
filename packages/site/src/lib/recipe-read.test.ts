import { describe, expect, it } from "vitest";
import type { RecipeInput } from "./recipe-read.ts";
import { readRecipes } from "./recipe-read.ts";
import { RECIPE_SAMPLES } from "./recipe-samples.ts";

const inputOf = (index: number, more: Partial<RecipeInput> = {}): RecipeInput => {
  const sample = RECIPE_SAMPLES[index]!;
  return {
    html: sample.html,
    url: sample.url,
    location: sample.location,
    kept: sample.kept,
    compareWith: null,
    skipSplit: false,
    ...more,
  };
};

// the page of the recipe reader tells these facts about its examples
describe("the examples of the recipe reader", () => {
  it("shows a restaurant whose JSON-LD and text disagree", () => {
    const view = readRecipes(inputOf(0));
    expect(view.venue.readings.map((one) => [one.from, one.rank])).toEqual([
      ["jsonld", 0],
      ["text", 1],
      ["text", 4],
    ]);
    expect(view.venue.best).toBe(0);
    expect(view.venue.fromSite).toBe(0);
    expect(view.venue.disagree).toEqual(["tue", "wed", "thu", "fri", "sat", "sun"]);
    expect(view.venue.readings[1]!.quote?.found).toBe(true);
    // from_site is the stale JSON-LD: the kept hours look the same
    expect(view.compare.result?.status).toBe("same");
    const text = readRecipes(inputOf(0, { compareWith: 1 }));
    expect(text.compare.result?.status).toBe("changed");
  });

  it("reads one location of a group, and none without an address", () => {
    const view = readRecipes(inputOf(1));
    expect(view.venue.readings).toHaveLength(1);
    expect(view.venue.readings[0]!.path).toBe("jsonld[1]");
    expect(view.compare.result?.days).toEqual(["sat"]);
    const none = readRecipes(inputOf(1, { location: "" }));
    expect(none.venue.readings).toHaveLength(0);
    expect(none.venue.notes[0]).toContain("lists 3 locations");
  });

  it("picks the product of the page over a larger related product", () => {
    const view = readRecipes(inputOf(2));
    expect(view.product.read.name).toBe("Olio Esempio");
    expect(view.product.why).toBe("url");
    expect(view.product.without).toBe("Aceto Esempio, 250 ml");
    const sizes = Object.fromEntries(view.product.candidates.map((one) => [one.name, one.size]));
    expect(sizes["Aceto Esempio, 250 ml"]).toBeGreaterThan(sizes["Olio Esempio"]!);
    expect(view.product.read.variant?.price).toEqual({ amount: 21, currency: "EUR", raw: "21,00" });
    expect(view.product.read.price?.amount).toBe(12.5);
    expect(view.product.read.price_to?.amount).toBe(89);
    expect(view.product.variants.find((one) => one.named)?.old).toBe("24,00");
  });

  it("stops at a wall", () => {
    const view = readRecipes(inputOf(3));
    expect(view.blocked).not.toBeNull();
    expect(view.venue.readings).toHaveLength(0);
    expect(view.product.read.found).toBe(false);
  });
});
