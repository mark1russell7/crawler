// The record of the robots.txt study on Zenodo. This script makes a draft with a reserved DOI, puts
// the dataset in it (with the DOI in the README and the CITATION.cff), and publishes it only when it
// is asked to. The workflow .github/workflows/study-zenodo.yml starts it:
//   pnpm exec tsx packages/site/scripts/study-zenodo.ts <out dir> <deposition.json>
//
// The environment:
//   ZENODO_SANDBOX         "true" for sandbox.zenodo.org, the test copy of Zenodo
//   ZENODO_TOKEN           the token for zenodo.org (scopes deposit:write and deposit:actions)
//   ZENODO_SANDBOX_TOKEN   the token for sandbox.zenodo.org
//   ZENODO_PUBLISH         "true" to publish the record. Otherwise it stays a draft.
//   ZENODO_NEW_VERSION_OF  the id of a published record, to make a new version of it
//
// It writes the files that it put in the draft to <out dir>, and the last answer of the API to
// <deposition.json>. It never writes the token.
import { appendFileSync, writeFileSync } from "node:fs";
import { datasetFiles, studyDoiFile, zenodoMetadata } from "../src/lib/dataset.ts";
import { studyVersion } from "../src/lib/cite.ts";
import type { Study } from "../src/lib/study.ts";
import { ZENODO_API, ZENODO_SANDBOX_API, deposit } from "../src/lib/zenodo.ts";
import { readInput, writeDataset } from "./study-dataset.ts";

const [out, record] = process.argv.slice(2);
if (out === undefined || record === undefined) {
  console.error("usage: study-zenodo.ts <out dir> <deposition.json>");
  process.exit(2);
}
const env = (name: string): string => process.env[name]?.trim() ?? "";
const sandbox = env("ZENODO_SANDBOX") === "true";
const token = env(sandbox ? "ZENODO_SANDBOX_TOKEN" : "ZENODO_TOKEN");
if (token.length === 0) {
  console.error(
    `The secret ${sandbox ? "ZENODO_SANDBOX_TOKEN" : "ZENODO_TOKEN"} is not set. Make a token on ${sandbox ? "sandbox.zenodo.org" : "zenodo.org"} with the scopes deposit:write and deposit:actions, then: gh secret set ${sandbox ? "ZENODO_SANDBOX_TOKEN" : "ZENODO_TOKEN"} -R mark1russell7/crawler`,
  );
  process.exit(1);
}
const newVersionOf = env("ZENODO_NEW_VERSION_OF");

const input = readInput();
const study = JSON.parse(new TextDecoder().decode(input.json)) as Study;
const result = await deposit({
  api: sandbox ? ZENODO_SANDBOX_API : ZENODO_API,
  token,
  metadata: zenodoMetadata(study),
  newVersionOf: newVersionOf.length === 0 ? undefined : newVersionOf,
  publish: env("ZENODO_PUBLISH") === "true",
  files: (doi) => {
    const files = datasetFiles({ ...input, doi });
    writeDataset(out, files);
    return files;
  },
});

writeFileSync(
  record,
  `${JSON.stringify({ sandbox, doi: result.doi, url: result.url, published: result.published, files: result.files, deposition: result.deposition }, null, 2)}\n`,
);
const version = studyVersion(study);
const lines = [
  `## The robots.txt study on ${sandbox ? "sandbox.zenodo.org" : "Zenodo"}`,
  "",
  `- DOI: \`${result.doi}\`${result.published ? "" : " (reserved: it resolves after you publish the record)"}`,
  `- ${result.published ? "Record" : "Draft"}: ${result.url}`,
  `- Version: ${version}`,
  `- Files: ${result.files.map((file) => `\`${file.name}\` (${String(file.size)} bytes)`).join(", ")}`,
  "",
  result.published
    ? "After the record is public, put this text in `packages/site/src/data/study-doi.json`:"
    : "Review the draft on Zenodo and click Publish. Then put this text in `packages/site/src/data/study-doi.json`:",
  "",
  "```json",
  studyDoiFile(result.doi, version).trimEnd(),
  "```",
];
console.info(lines.join("\n"));
const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary !== undefined && summary.length > 0) appendFileSync(summary, `${lines.join("\n")}\n`);
