import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import studyDoi from "../data/study-doi.json";
import type { StudyDoi } from "./cite.ts";
import { PRESS_CONTACT, bibtex, datasetCreator, doiOf, isDoi, studyVersion } from "./cite.ts";
import type { Study } from "./study.ts";
import data from "../data/robots-study.json";

const study = data as unknown as Study;
const version = studyVersion(study);
const root = fileURLToPath(new URL("../../../../", import.meta.url));

/** The files that git keeps or can keep in the repository: not the files that it ignores. */
const repositoryFiles = (): string[] =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\n")
    .filter((file) => file.length > 0 && existsSync(join(root, file)));

describe("the citation of the study", () => {
  it("shows a DOI only when study-doi.json names one for this run of the study", () => {
    expect(doiOf(study, { doi: null, version: null })).toBeUndefined();
    expect(doiOf(study, { doi: "10.5281/zenodo.1234567", version })).toBe("10.5281/zenodo.1234567");
    // the DOI of an earlier run, or a text that is not a DOI
    expect(doiOf(study, { doi: "10.5281/zenodo.1234567", version: "2026-09-01" })).toBeUndefined();
    expect(doiOf(study, { doi: "zenodo.1234567", version })).toBeUndefined();
  });

  it("keeps study-doi.json empty, or with a DOI and the version that it names", () => {
    const file = studyDoi as StudyDoi;
    expect(Object.keys(file).sort()).toEqual(["doi", "version"]);
    const valid =
      file.doi === null
        ? file.version === null
        : isDoi(file.doi) && /^\d{4}-\d{2}-\d{2}$/.test(file.version ?? "");
    expect(valid).toBe(true);
  });

  it("gives a BibTeX entry for the article, and for the dataset when it has a DOI", () => {
    const article = bibtex(study, undefined);
    expect(article).toMatch(/^@misc\{russell2026robots,\n/);
    expect(article).toContain("author       = {Russell, Mark}");
    expect(article).toContain(
      "title        = {{Who lets AI agents in? The robots.txt rules of the top 1,000 domains}}",
    );
    expect(article).toContain(
      "url          = {https://mark1russell7.github.io/crawler/notes/robots-txt-ai-agents/}",
    );
    expect(article).not.toContain("doi");
    const dataset = bibtex(study, "10.5281/zenodo.1234567");
    expect(dataset).toContain("title     = {Robots.txt rules for {AI} crawlers on popular sites}");
    expect(dataset).toContain("doi       = {10.5281/zenodo.1234567}");
    expect(dataset).toContain("url       = {https://doi.org/10.5281/zenodo.1234567}");
    expect(dataset).toContain("publisher = {Zenodo}");
    expect(dataset.endsWith("\n}")).toBe(true);
  });

  it("names the press contact on the creator of the dataset", () => {
    expect(datasetCreator()).toMatchObject({
      "@type": "Person",
      contactPoint: { "@type": "ContactPoint", contactType: "press", email: PRESS_CONTACT.email },
    });
  });

  it("writes the press address in one file of the repository", () => {
    const found = repositoryFiles().filter((file) =>
      readFileSync(join(root, file)).includes(PRESS_CONTACT.email),
    );
    // the page, the structured data and the record on Zenodo read it from cite.ts
    expect(found).toEqual(["packages/site/src/lib/cite.ts"]);
  });
});
