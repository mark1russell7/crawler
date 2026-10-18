// The dataset of the robots.txt study, for Zenodo. This script writes a folder with the two data
// files of the site, a README and a CITATION.cff. The same input gives the same bytes.
//
// Start it from the root of the repository:
//   pnpm exec tsx packages/site/scripts/study-dataset.ts <out dir> [--doi <doi>]
//
// With --doi, the README and the CITATION.cff name the DOI. The workflow study-zenodo.yml writes
// the folder again with the DOI that Zenodo reserved, before it puts the files in the draft.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StudyDoi } from "../src/lib/cite.ts";
import { conceptOf } from "../src/lib/cite.ts";
import type { DatasetFile, DatasetInput } from "../src/lib/dataset.ts";
import { datasetFiles } from "../src/lib/dataset.ts";

const site = fileURLToPath(new URL("..", import.meta.url));

/**
 * This function reads the input of the dataset from the site: the JSON and the CSV of the newest run,
 * the study page, and the concept DOI in study-doi.json.
 */
export const readInput = (doi?: string): DatasetInput => ({
  json: new Uint8Array(readFileSync(join(site, "src/data/robots-study.json"))),
  csv: new Uint8Array(readFileSync(join(site, "public/data/robots-study.csv"))),
  page: readFileSync(join(site, "src/content/docs/notes/robots-txt-ai-agents.mdx"), "utf8"),
  doi,
  concept: conceptOf(
    JSON.parse(readFileSync(join(site, "src/data/study-doi.json"), "utf8")) as StudyDoi,
  ),
});

/**
 * This function writes the files into the folder. It fails when the folder has a different file, so
 * the folder holds the dataset and nothing else.
 */
export const writeDataset = (dir: string, files: readonly DatasetFile[]): void => {
  mkdirSync(dir, { recursive: true });
  const names = new Set(files.map((file) => file.name));
  const other = readdirSync(dir).filter((name) => !names.has(name));
  if (other.length > 0)
    throw new Error(`${dir} has files that are not of the dataset: ${other.join(", ")}`);
  for (const file of files) writeFileSync(join(dir, file.name), file.bytes);
};

const main = (args: readonly string[]): void => {
  const [out, flag, doi] = args;
  if (out === undefined || (flag !== undefined && (flag !== "--doi" || doi === undefined))) {
    console.error("usage: study-dataset.ts <out dir> [--doi <doi>]");
    process.exit(2);
  }
  const files = datasetFiles(readInput(doi));
  writeDataset(out, files);
  for (const file of files) console.info(`${file.name}  ${String(file.bytes.byteLength)} bytes`);
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
