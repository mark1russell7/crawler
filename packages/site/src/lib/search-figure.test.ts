import { HYBRID_DEFAULTS } from "polite-crawler";
import { describe, expect, it } from "vitest";
import data from "../data/search-figure.json";
import { CORPUS, QUESTIONS } from "./search-corpus.ts";
import type { FigureData } from "./search-figure.ts";
import { fuseQuestion } from "./search-figure.ts";
import { corpusHash, corpusIndex, lexicalOf } from "./search-index.ts";

const figure = data as unknown as FigureData;
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

describe("the data of the search figure", () => {
  it("comes from the corpus of this commit", () => {
    expect(
      figure.provenance.corpus,
      "the corpus changed: run .github/workflows/search-figure.yml and commit its JSON",
    ).toBe(corpusHash());
    expect(figure.questions.map((one) => one.q)).toEqual(QUESTIONS.map((one) => one.q));
    expect(figure.defaults).toEqual(HYBRID_DEFAULTS);
  });

  it("names the model and the run that gave the vector ranks", () => {
    expect(figure.provenance.model).toBe("Xenova/bge-small-en-v1.5");
    expect(figure.provenance.run).toMatch(/^https:\/\/github\.com\/.+\/actions\/runs\/\d+$/);
    expect(figure.provenance.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("has the full-text ranks of the real index", () => {
    const index = corpusIndex();
    try {
      for (const question of figure.questions)
        expect(question.lexical, question.q).toEqual(lexicalOf(index, question.q));
    } finally {
      index.close();
    }
  });

  it("ranks each page of the corpus one time with the vectors", () => {
    const ids = CORPUS.map((doc) => doc.id).sort();
    for (const question of figure.questions)
      expect(question.vector.map((hit) => hit.doc).sort(), question.q).toEqual(ids);
  });

  // the notes of the figure (HybridRanks.tsx) tell these facts: a new run of the model must keep them
  it("keeps the facts that the notes of the figure tell", () => {
    const question = (id: string) => figure.questions.find((one) => one.id === id)!;
    const lexical = (id: string) => question(id).lexical.map((hit) => hit.doc);
    const vector = (id: string) => question(id).vector.map((hit) => hit.doc);
    const fusedRank = (id: string, doc: string, k: number) =>
      fuseQuestion(question(id), { k, candidates: 50, neighbors: 50 }).findIndex(
        (row) => row.doc === doc,
      ) + 1;

    expect(lexical("pizza")).not.toContain("forno");
    expect(lexical("pizza")).toContain("fx-2207");
    expect(vector("pizza")[0]).toBe("forno");

    expect(lexical("entrance")).toEqual([]);
    expect(vector("entrance").indexOf("museum-visit")).toBe(1);

    expect(vector("gtin")[0]).toMatch(/^fx-/);
    expect(lexical("gtin")[0]).toBe("olio");
    expect(fusedRank("gtin", "olio", 60)).toBe(1);

    expect(lexical("access")[0]).toBe("archive");
    expect(lexical("access")).not.toContain("museum-visit");
    expect(vector("access")[0]).toBe("museum-visit");
    expect(fusedRank("access", "museum-visit", 60)).toBe(4);
    expect(fusedRank("access", "museum-visit", 0)).toBe(2);

    expect(new Set(lexical("rye").slice(0, 3))).toEqual(new Set(vector("rye").slice(0, 3)));
    const top = fuseQuestion(question("rye"), { k: 60, candidates: 50, neighbors: 50 }).slice(0, 3);
    expect(top[0]!.score - top[2]!.score).toBeLessThan(0.0001);
  });

  it("fuses the two lists as the real hybrid search does", () => {
    const settings = {
      k: HYBRID_DEFAULTS.fusionK,
      candidates: HYBRID_DEFAULTS.candidates,
      neighbors: HYBRID_DEFAULTS.neighbors,
    };
    for (const question of figure.questions) {
      const fused = fuseQuestion(question, settings).map((row) => ({
        doc: row.doc,
        score: round(row.score),
      }));
      expect(fused, question.q).toEqual(question.hybrid);
    }
  });
});
