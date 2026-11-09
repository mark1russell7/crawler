#!/usr/bin/env node
// The lockstep version of polite-crawler and polite-crawler-mcp.
//
//   node scripts/version.ts            write the version to each place, and add the changelog sections
//   pnpm --filter polite-crawler run version
//
// The two packages always have the same version. The script reads the version of each package.json,
// takes the higher one, and writes it to each place that names the version:
//   - "version" of packages/polite-crawler/package.json and packages/polite-crawler-mcp/package.json
//   - VERSION of src/version.ts and of the two API reports of each package: api/index.api.md
//     (scripts/api.ts) and test/api/public-api.txt (api-report)
//   - the two "version" fields of server.json
// Then CHANGELOG.md and packages/polite-crawler-mcp/CHANGELOG.md get "## <version> - <date>" directly
// below "## Unreleased", with the notes of Unreleased. A second run changes nothing.
//
// The "version" script of each package.json starts this script. npm and pnpm start it in the folder of
// the package after `npm version` or `pnpm version`, so a change of one package.json is sufficient.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeRegExp } from "@mark1russell7/text";

/** The packages that have the same version, by their folder in packages/. */
export const PACKAGES = ["polite-crawler", "polite-crawler-mcp"] as const;

/** The changelogs that get a section for each version, from the root of the repository. */
export const CHANGELOGS = ["CHANGELOG.md", "packages/polite-crawler-mcp/CHANGELOG.md"] as const;

/** The line of a changelog section when Unreleased has no notes. */
export const NO_NOTES = "- New versions of the dependencies (the release train).";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The parts of a SemVer version that its precedence uses. */
interface Parsed {
  readonly core: readonly [number, number, number];
  readonly pre: readonly string[];
}

const parse = (version: string): Parsed => {
  const match = SEMVER.exec(version);
  if (match === null) throw new Error(`${version} is not a SemVer version`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split("."),
  };
};

/** This function compares two prerelease identifiers by the rules of SemVer 2.0.0. */
const compareIdentifiers = (a: string, b: string): number => {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * This function compares two versions by the precedence of SemVer 2.0.0. The result is negative
 * when `a` is lower, positive when `a` is higher, and 0 when they have the same precedence.
 */
export const compareVersions = (a: string, b: string): number => {
  const x = parse(a);
  const y = parse(b);
  for (const index of [0, 1, 2] as const) {
    const difference = x.core[index] - y.core[index];
    if (difference !== 0) return difference;
  }
  // a version with no prerelease is higher than each of its prereleases
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let index = 0; index < Math.min(x.pre.length, y.pre.length); index += 1) {
    const difference = compareIdentifiers(x.pre[index] ?? "", y.pre[index] ?? "");
    if (difference !== 0) return difference;
  }
  return x.pre.length - y.pre.length;
};

/** This function replaces each match of a pattern, and fails when the text has no match. */
const replaceIn = (file: string, text: string, pattern: RegExp, replacement: string): string => {
  if (!pattern.test(text)) throw new Error(`${file} has no match of ${String(pattern)}`);
  pattern.lastIndex = 0;
  return text.replace(pattern, replacement);
};

/**
 * This function adds the section of a version to the text of a changelog. The section goes
 * directly below "## Unreleased" and gets the notes of Unreleased. A changelog that has a section
 * of the version already does not change.
 */
export const addSection = (text: string, version: string, date: string): string => {
  const lines = text.split("\n");
  const has = new RegExp(`^## \\[?${escapeRegExp(version)}\\]?(\\s|$)`);
  if (lines.some((line) => has.test(line))) return text;
  const start = lines.findIndex((line) => /^## Unreleased\s*$/.test(line));
  if (start === -1) throw new Error('the changelog has no "## Unreleased" section');
  const length = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
  const end = length === -1 ? lines.length : start + 1 + length;
  const notes = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  const section = [
    lines[start] ?? "## Unreleased",
    "",
    `## ${version} - ${date}`,
    "",
    notes === "" ? NO_NOTES : notes,
  ];
  const rest = lines.slice(end);
  return [...lines.slice(0, start), ...section, ...(rest.length > 0 ? ["", ...rest] : [""])].join(
    "\n",
  );
};

/** The result of a run: the version, and the files that the run changed. */
export interface SyncResult {
  readonly version: string;
  readonly changed: readonly string[];
}

/**
 * This function writes the higher version of the two package.json files to each place that names
 * the version, and adds the changelog sections. `root` is the folder of the repository. `date` is
 * the date of a new changelog section, as YYYY-MM-DD.
 */
export const syncVersion = (root: string, date: string): SyncResult => {
  const versions = PACKAGES.map((name) => {
    const manifest = JSON.parse(
      readFileSync(join(root, "packages", name, "package.json"), "utf8"),
    ) as { readonly version?: unknown };
    if (typeof manifest.version !== "string")
      throw new Error(`packages/${name}/package.json has no version`);
    parse(manifest.version);
    return manifest.version;
  });
  const version = versions.reduce((high, next) => (compareVersions(next, high) > 0 ? next : high));
  const changed: string[] = [];
  const edit = (file: string, change: (text: string) => string): void => {
    const path = join(root, file);
    const before = readFileSync(path, "utf8");
    const after = change(before);
    if (after === before) return;
    writeFileSync(path, after);
    changed.push(file);
  };
  const quoted = JSON.stringify(version);
  for (const name of PACKAGES) {
    // only the top-level field: it has an indent of two spaces
    edit(`packages/${name}/package.json`, (text) =>
      replaceIn(name, text, /^ {2}"version": "[^"]*"/m, `  "version": ${quoted}`),
    );
    // the report of api-report has `export declare const`
    for (const file of [
      `packages/${name}/src/version.ts`,
      `packages/${name}/api/index.api.md`,
      `packages/${name}/test/api/public-api.txt`,
    ]) {
      edit(file, (text) =>
        replaceIn(file, text, /^(export (?:declare )?const VERSION = )"[^"]*";$/m, `$1${quoted};`),
      );
    }
  }
  // the version of the server, and the version of its npm package
  edit("server.json", (text) => {
    const next = text.replace(/^( {2}| {6})"version": "[^"]*"/gm, `$1"version": ${quoted}`);
    const count = [...next.matchAll(/^(?: {2}| {6})"version": /gm)].length;
    if (count !== 2) throw new Error(`server.json has ${String(count)} version fields, not 2`);
    return next;
  });
  for (const file of CHANGELOGS) edit(file, (text) => addSection(text, version, date));
  return { version, changed };
};

if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const date = new Date().toISOString().slice(0, 10);
  const { version, changed } = syncVersion(root, date);
  console.log(
    changed.length === 0
      ? `version ${version}: each place has it already.`
      : `version ${version}: ${changed.join(", ")}`,
  );
}
