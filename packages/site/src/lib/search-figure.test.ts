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
