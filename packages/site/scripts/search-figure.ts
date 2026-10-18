// The data of the figure "How hybrid search ranks" (src/data/search-figure.json). For each question of
// src/lib/search-corpus.ts, this script writes three rankings of the corpus:
//
// - lexical: the full-text ranking of the real index of polite-crawler (SQLite FTS5, BM25), the
//   candidates of hybrid search.
// - vector: the documents of the real vector store, the closest chunk first, with the vectors of the
//   real model (bge-small through transformers.js, as `transformersEmbedder` gives them).
// - hybrid: the result of the real `find` of hybrid search with the default options. The test of the
//   figure makes sure that the fusion of the page gives the same list.
//
// The model runs in CI only (.github/workflows/search-figure.yml): its first use downloads it from
// the Hugging Face Hub. The JSON names the model, the versions, the date and the commit.
//
//   pnpm exec tsx packages/site/scripts/search-figure.ts --out <file>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CrawlRuntime } from "polite-crawler";
import {
  HYBRID_DEFAULTS,
  TRANSFORMERS_MODELS,
  VERSION,
  VectorStore,
  createHybridSearch,
  transformersEmbedder,
  unitVector,
} from "polite-crawler";
import { CORPUS, FETCHED_AT, QUESTIONS } from "../src/lib/search-corpus.ts";
import { corpusHash, corpusIdOf, corpusIndex, lexicalOf } from "../src/lib/search-index.ts";

const MODEL = "Xenova/bge-small-en-v1.5";

const at = process.argv.indexOf("--out");
const out = at === -1 ? undefined : process.argv[at + 1];
if (out === undefined) {
  console.error("usage: tsx packages/site/scripts/search-figure.ts --out <file>");
  process.exit(2);
}

const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const packageDir = dirname(fileURLToPath(import.meta.resolve("polite-crawler/package.json")));
const transformersVersion = (
  JSON.parse(
    readFileSync(
      join(packageDir, "node_modules", "@huggingface", "transformers", "package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

const index = corpusIndex();
const store = new VectorStore(":memory:");
const embedder = transformersEmbedder({ model: MODEL });
// hybrid search needs only the index and the time of a runtime: the corpus is in the index already
const runtime = { index, now: () => FETCHED_AT } as unknown as CrawlRuntime;
const hybrid = createHybridSearch(runtime, { embedder, store });

const started = Date.now();
const embedded = await hybrid.embed();
if (embedded.embedded !== CORPUS.length)
  throw new Error(
    `the model embedded ${String(embedded.embedded)} of ${String(CORPUS.length)} pages`,
  );

const questions = [];
for (const question of QUESTIONS) {
  const lexical = lexicalOf(index, question.q);
  // the vector search of hybrid search: the question as a query, then the closest chunk of each page
  const [given] = await embedder.embed([question.q], { purpose: "query" });
  const vector = unitVector(given!);
  const seen = new Set<string>();
  const near: Array<{ doc: string; similarity: number }> = [];
  for (const hit of store.search(embedder.id, vector)) {
    for (const doc of hit.docs) {
      if (seen.has(doc)) continue;
      seen.add(doc);
      near.push({ doc: corpusIdOf(doc), similarity: round(hit.similarity, 4) });
    }
  }
  const found = await hybrid.find(question.q, { limit: CORPUS.length });
  questions.push({
    id: question.id,
    q: question.q,
    lexical,
    vector: near,
    hybrid: found.map((hit) => ({ doc: corpusIdOf(hit.doc), score: hit.score })),
  });
  console.info(
    `${question.q}\n  full text: ${lexical.map((hit) => hit.doc).join(", ")}\n  vectors:   ${near
      .slice(0, 6)
      .map((hit) => `${hit.doc} ${String(hit.similarity)}`)
      .join(", ")}\n  hybrid:    ${found
      .slice(0, 6)
      .map((hit) => corpusIdOf(hit.doc))
      .join(", ")}`,
  );
}

const server = process.env["GITHUB_SERVER_URL"];
const repository = process.env["GITHUB_REPOSITORY"];
const run = process.env["GITHUB_RUN_ID"];
const data = {
  provenance: {
    note: "The full-text ranks come from the index of polite-crawler. The vector ranks come from a run of the model in CI.",
    model: MODEL,
    dimensions: TRANSFORMERS_MODELS[MODEL]?.dimensions ?? null,
    embedder: embedder.id,
    transformers: transformersVersion,
    package: VERSION,
    node: process.version,
    date: new Date().toISOString(),
    commit: process.env["GITHUB_SHA"] ?? null,
    run:
      server !== undefined && repository !== undefined && run !== undefined
        ? `${server}/${repository}/actions/runs/${run}`
        : null,
    corpus: corpusHash(),
    ms: Date.now() - started,
  },
  defaults: HYBRID_DEFAULTS,
  questions,
};
writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
index.close();
store.close();
await embedder.close?.();
console.info(`wrote ${out}`);
