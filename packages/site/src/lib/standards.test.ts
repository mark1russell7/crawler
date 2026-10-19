import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SOURCE, googleSummary, summarizeGoogle } from "./standards.ts";

// The page links the tests of polite-crawler and of polite-crawler-mcp (the MCP server since 0.2.0)
const packageDir = new URL("../../../polite-crawler/", import.meta.url);
const packageDirs: Readonly<Record<string, URL>> = {
  [SOURCE]: packageDir,
  [`${SOURCE}-mcp`]: new URL("../../../polite-crawler-mcp/", import.meta.url),
};
const page = readFileSync(
  new URL("../content/docs/reference/standards.mdx", import.meta.url),
  "utf8",
);

/**
 * The test references of the page: a link to a test file of the package, and after it the names of
 * the tests in code font, up to the next link or the end of the line.
 */
const references = (): Array<{
  readonly file: string;
  readonly url: string;
  readonly test: string;
}> => {
  const out: Array<{ file: string; url: string; test: string }> = [];
  for (const line of page.split("\n")) {
    const links = [...line.matchAll(/\[`([\w.-]+\.test\.ts)`\]\(([^)]+)\)/g)];
    links.forEach((link, index) => {
      const end = links[index + 1]?.index ?? line.length;
      const after = line.slice(link.index + link[0].length, end);
      for (const name of after.matchAll(/`([^`]+)`/g))
        out.push({ file: link[1]!, url: link[2]!, test: name[1]! });
    });
  }
  return out;
};

describe("the Standards page", () => {
  it("shows the Google cases as the test of the package counts them", () => {
    const google = googleSummary();
    expect(google).toEqual(
      summarizeGoogle(
        new Uint8Array(
          readFileSync(new URL("test/corpus/google-robotstxt/robots_test.cc", packageDir)),
        ),
      ),
    );
    expect(google.wrong).toBe(0);
    expect(google.total).toBe(
      google.agree + google.differences.length + google.notUrls + google.notCounted,
    );
    expect(google.total).toBeGreaterThan(190);
    expect(google.differences).toHaveLength(12);
    for (const one of google.differences) {
      expect(one.href).toBe(
        `https://github.com/google/robotstxt/blob/${google.commit}/robots_test.cc#L${String(one.line)}`,
      );
      expect(one.reason.length).toBeGreaterThan(20);
      expect(one.google).not.toBe(one.crawler);
    }
  });

  it("links each rule to a test that exists, with its exact name", () => {
    const found = references();
    expect(found.length).toBeGreaterThan(50);
    const missing: string[] = [];
    for (const { file, url, test } of found) {
      const root = Object.keys(packageDirs).find((one) => url === `${one}/src/${file}`);
      expect(root, `${url} is a test file of a package`).toBeDefined();
      const source = readFileSync(new URL(`src/${file}`, packageDirs[root ?? SOURCE]), "utf8");
      if (!source.includes(JSON.stringify(test))) missing.push(`${file}: ${test}`);
    }
    expect(missing).toEqual([]);
  });
});
