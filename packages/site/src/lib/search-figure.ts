/**
 * The fusion of the figure "How hybrid search ranks". The page and the test use it. It cuts the two
 * rankings of `search-figure.json` to the candidate counts. Then it fuses them with the real
 * `fuseRanks` of polite-crawler, as the `find` of hybrid search does.
 */
import { fuseRanks } from "polite-crawler";

/** One question of `search-figure.json`, with its three rankings. */
export interface FigureQuestion {
  readonly id: string;
  readonly q: string;
  readonly lexical: ReadonlyArray<{ readonly doc: string; readonly score: number }>;
  readonly vector: ReadonlyArray<{ readonly doc: string; readonly similarity: number }>;
  readonly hybrid: ReadonlyArray<{ readonly doc: string; readonly score: number }>;
}

/** The data of the figure: the rankings, and where they came from. */
export interface FigureData {
  readonly provenance: {
    readonly model: string;
    readonly embedder: string;
    readonly transformers: string;
    readonly package: string;
    readonly date: string;
    readonly commit: string | null;
    readonly run: string | null;
    readonly corpus: string;
  };
  readonly defaults: {
    readonly candidates: number;
    readonly neighbors: number;
    readonly fusionK: number;
  };
  readonly questions: readonly FigureQuestion[];
}

/** The settings of a fusion: the constant k and the two candidate counts. */
export interface FusionSettings {
  readonly k: number;
  readonly candidates: number;
  readonly neighbors: number;
}

/** One row of the fused list: the page, its fused score, and its rank in each cut list (from 1). */
export interface FusedRow {
  readonly doc: string;
  readonly score: number;
  readonly text: number | null;
  readonly vector: number | null;
}

/** This function fuses the two rankings of a question with the settings, the best first. */
export const fuseQuestion = (question: FigureQuestion, settings: FusionSettings): FusedRow[] =>
  fuseRanks(
    [
      question.lexical.slice(0, settings.candidates).map((hit) => hit.doc),
      question.vector.slice(0, settings.neighbors).map((hit) => hit.doc),
    ],
    settings.k,
  ).map((one) => ({
    doc: one.id,
    score: one.score,
    text: one.ranks[0] ?? null,
    vector: one.ranks[1] ?? null,
  }));
