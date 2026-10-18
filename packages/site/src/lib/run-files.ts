/**
 * The dataset of each run, for the build: the files `src/data/study/<version>.json`. The feed and
 * the address `/crawler/data/robots-study-<version>.json` read them. Only the build loads this
 * module, because it imports the dataset of each run.
 */
import type { Study } from "./study.ts";
import { toCsv } from "./study.ts";

const files = import.meta.glob<Study>("../data/study/*.json", { eager: true, import: "default" });

/** The dataset of each run, by its version. */
export const RUN_STUDIES: Readonly<Record<string, Study>> = Object.fromEntries(
  Object.entries(files).map(([path, study]) => [
    /([^/]+)\.json$/.exec(path)?.[1] ?? path,
    study as unknown as Study,
  ]),
);

const encoder = new TextEncoder();

/** The size in bytes of the CSV of each run. A test keeps each CSV equal to the CSV of its dataset. */
export const RUN_CSV_BYTES: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(RUN_STUDIES).map(([version, study]) => [
    version,
    encoder.encode(toCsv(study)).byteLength,
  ]),
);
