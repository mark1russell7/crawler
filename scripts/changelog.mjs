#!/usr/bin/env node
// Prints the section of CHANGELOG.md for one version, for the notes of a GitHub release.
//
//   node scripts/changelog.mjs 0.2.0
//
// The section starts at the heading "## 0.2.0" (a date can follow it) and ends at the next "## " heading.
// The script exits with 1 when the section is missing or empty, so a release cannot go out without notes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  process.stderr.write("usage: node scripts/changelog.mjs <version>\n");
  process.exit(2);
}

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");
const lines = readFileSync(file, "utf8").split(/\r?\n/);
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const start = lines.findIndex((line) => new RegExp(`^## \\[?${escaped}\\]?(\\s|$)`).test(line));
if (start === -1) {
  process.stderr.write(`CHANGELOG.md has no section "## ${version}".\n`);
  process.exit(1);
}
const length = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
const body = lines
  .slice(start + 1, length === -1 ? undefined : start + 1 + length)
  .join("\n")
  .trim();
if (body === "") {
  process.stderr.write(`The section "## ${version}" of CHANGELOG.md is empty.\n`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
