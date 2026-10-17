import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRESS_CONTACT } from "./cite.ts";
import { citationCff, datasetFiles, limitsOf, readme, zenodoMetadata } from "./dataset.ts";
import type { Study } from "./study.ts";

const site = new URL("../../", import.meta.url);
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(new URL(path, site)));
const input = {
  json: read("src/data/robots-study.json"),
  csv: read("public/data/robots-study.csv"),
  page: readFileSync(new URL("src/content/docs/notes/robots-txt-ai-agents.mdx", site), "utf8"),
};
const study = JSON.parse(new TextDecoder().decode(input.json)) as Study;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const fileOf = (files: ReturnType<typeof datasetFiles>, name: string): string =>
  decode(files.find((file) => file.name === name)!.bytes);

describe("the dataset for Zenodo", () => {
  it("has the two data files as the site has them, a README and a CITATION.cff", () => {
    const files = datasetFiles(input);
    expect(files.map((file) => file.name)).toEqual([
      "CITATION.cff",
      "README.md",
      "robots-study.csv",
      "robots-study.json",
    ]);
    expect(files[2]!.bytes).toEqual(input.csv);
    expect(files[3]!.bytes).toEqual(input.json);
  });

  it("gives the same bytes for the same input", () => {
    const one = datasetFiles(input);
    const two = datasetFiles({ ...input, json: new Uint8Array(input.json) });
    expect(two.map((file) => [file.name, decode(file.bytes)])).toEqual(
      one.map((file) => [file.name, decode(file.bytes)]),
    );
    // no file contains the day of the build, unless it is the day of the run
    const today = new Date().toISOString().slice(0, 10);
    const stamped = one
      .slice(0, 2)
      .filter(
        (file) => today !== study.fetched.from.slice(0, 10) && decode(file.bytes).includes(today),
      );
    expect(stamped).toEqual([]);
  });

  it("tells the method, each column, the dates, the limits of the page and the license", () => {
    const text = fileOf(datasetFiles(input), "README.md");
    const columns = decode(input.csv).split("\n")[0]!.split(",");
    for (const column of columns) expect(text).toContain(`\`${column}\``);
    for (const limit of limitsOf(input.page)) expect(text).toContain(`- ${limit}`);
    expect(limitsOf(input.page).length).toBeGreaterThan(4);
    expect(text).toContain(study.fetched.from);
    expect(text).toContain(study.fetched.to);
    expect(text).toContain(study.list.date);
    expect(text).toContain(study.userAgent);
    expect(text).toContain("CC BY 4.0");
    expect(text).toContain("https://creativecommons.org/licenses/by/4.0/");
    expect(text).not.toContain("DOI");
    // each row of a table has the cells of its head: no "|" in a cell breaks a row
    const tables: string[][] = [];
    let current: string[] | undefined;
    for (const line of text.split("\n")) {
      if (!line.startsWith("|")) current = undefined;
      else if (current === undefined) tables.push((current = [line]));
      else current.push(line);
    }
    expect(tables.length).toBe(2);
    for (const rows of tables)
      expect(new Set(rows.map((row) => row.split("|").length)).size).toBe(1);
  });

  it("names the DOI in the README and the CITATION.cff only when Zenodo reserved one", () => {
    const without = citationCff(study);
    expect(without).toContain("type: dataset");
    expect(without).toContain('title: "Robots.txt rules for AI crawlers on popular sites"');
    expect(without).toContain("license: CC-BY-4.0");
    expect(without).toContain(`version: "${study.fetched.from.slice(0, 10)}"`);
    expect(without).not.toContain("doi:");
    const files = datasetFiles({ ...input, doi: "10.5281/zenodo.1234567" });
    expect(fileOf(files, "CITATION.cff")).toContain('doi: "10.5281/zenodo.1234567"');
    expect(fileOf(files, "README.md")).toContain("https://doi.org/10.5281/zenodo.1234567");
    expect(() => datasetFiles({ ...input, doi: "zenodo.1234567" })).toThrow(/not a DOI/);
  });

  it("refuses a CSV that is not the CSV of the JSON", () => {
    const csv = new Uint8Array(input.csv);
    csv[csv.length - 2] = "x".charCodeAt(0);
    expect(() => datasetFiles({ ...input, csv })).toThrow(/not the CSV of robots-study.json/);
  });

  it("reads the limits of the page, and refuses a page with no limits or with MDX in a limit", () => {
    expect(limitsOf("## The limits\n\n- **One.** A limit.\n- **Two.** B.\n\n## Next\n")).toEqual([
      "**One.** A limit.",
      "**Two.** B.",
    ]);
    expect(() => limitsOf("## The method\n\n- a\n\n## Next\n")).toThrow(/no section/);
    expect(() => limitsOf("## The limits\n\n- {s.blocked} sites\n\n## Next\n")).toThrow(/MDX/);
    expect(() => readme(study, [])).not.toThrow();
  });

  it("gives Zenodo the metadata of a dataset, with the press contact in the notes only", () => {
    const metadata = zenodoMetadata(study);
    expect(metadata).toMatchObject({
      upload_type: "dataset",
      title: "Robots.txt rules for AI crawlers on popular sites",
      creators: [{ name: "Russell, Mark" }],
      license: "cc-by-4.0",
      version: study.fetched.from.slice(0, 10),
      notes: `Press contact: ${PRESS_CONTACT.email}`,
    });
    expect(metadata.keywords).toContain("robots.txt");
    expect(metadata.description).toContain("<p>");
    expect(metadata.description).not.toContain("<script");
    expect(JSON.stringify(metadata).split(PRESS_CONTACT.email)).toHaveLength(2);
    // the address goes in the record, not in the files
    for (const file of datasetFiles(input)) expect(decode(file.bytes)).not.toContain("@gmail");
  });
});
