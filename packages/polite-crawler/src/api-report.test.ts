import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The API reports of this package are data, and this test keeps them true: the counts of
// docs/API-REVIEW.md come from the release tags of the reports in api/. The counts were out of date
// for two versions before this test.
//
// The check that test/api/public-api.txt names no chunk of the bundler is the option entriesOnly of
// api-report, in the field apiReport of the root package.json. The command check:api fails on a
// chunk.

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(PACKAGE, "..", "..");
const read = (...parts: string[]): string => readFileSync(join(...parts), "utf8");

/** The counts of the release tags in one report of api-extractor. */
interface Counts {
  stable: number;
  beta: number;
  deprecated: number;
}

const countsOf = (report: string): Counts => {
  const tags = report.match(/^\/\/ @[a-z].*$/gm) ?? [];
  return {
    stable: tags.filter((tag) => tag.startsWith("// @public")).length,
    beta: tags.filter((tag) => tag.startsWith("// @beta")).length,
    deprecated: tags.filter((tag) => tag.includes("@deprecated")).length,
  };
};

/** This function gives the reports that one row of the table counts, from the name of the row. */
const reportsOf = (row: string): string[] => {
  if (row === "polite-crawler root") return [join(PACKAGE, "api", "index.api.md")];
  if (row === "polite-crawler-mcp")
    return [join(ROOT, "packages", "polite-crawler-mcp", "api", "index.api.md")];
  const entries = [...row.matchAll(/`\/([a-z]+)`/g)].map((match) => match[1] ?? "");
  return entries.map((entry) => join(PACKAGE, "api", `${entry}.api.md`));
};

describe("the API report", () => {
  it("gives the counts of the table in docs/API-REVIEW.md", () => {
    const review = read(ROOT, "docs", "API-REVIEW.md");
    const table = review.slice(review.indexOf("## Counts"));
    const rows = [...table.matchAll(/^\| (.+?) \| (\d+) \| (\d+) \| (\d+) \|$/gm)];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const [, row = "", stable, beta, deprecated] of rows) {
      const files = reportsOf(row);
      expect(files.length, row).toBeGreaterThan(0);
      const total = files
        .map((file) => countsOf(read(file)))
        .reduce((sum, counts) => ({
          stable: sum.stable + counts.stable,
          beta: sum.beta + counts.beta,
          deprecated: sum.deprecated + counts.deprecated,
        }));
      expect({ row, ...total }).toEqual({
        row,
        stable: Number(stable),
        beta: Number(beta),
        deprecated: Number(deprecated),
      });
    }
  });
});
