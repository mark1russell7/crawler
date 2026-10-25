// Plans the git tag and the GitHub release of polite-crawler, for the tag job of release.yml.
//
//   node scripts/release/tags.mjs <file>
//
// The shared build job (reusable-release-build.yml of the template) runs this script, and the tag
// job (reusable-release-tag.yml) reads <file>. That job holds "contents: write" and runs no code of
// the repository. Thus this script runs in the build job ("contents: read") and makes all the text
// of the release.
//
// This repository keeps its own tags.mjs. It publishes two packages, but only polite-crawler gets a
// tag and a release, with the tag "v<version>". The tags.mjs of the template gives each package a
// tag "<name>@<version>", no title and no tarball, and it does not stop a release without a
// changelog section. <file> is a JSON array with one entry, for the package polite-crawler:
//
//   tag         "v<version>".
//   title       "polite-crawler <version>".
//   prerelease  true for a version with a prerelease part, for example 0.2.0-beta.1.
//   notes       The section of the version in CHANGELOG.md (scripts/changelog.mjs). Without that
//               section, the script fails, and the release stops before the publish.
//   tarballs    Each published package: the GitHub release gets the two tarballs as files.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseVersion, publishedPackages, root } from "./workspace.mjs";

const NAME = "polite-crawler";

const out = process.argv[2];
if (out === undefined) {
  process.stderr.write("usage: node scripts/release/tags.mjs <file>\n");
  process.exit(2);
}

const packages = publishedPackages();
const entry = packages.find(({ manifest }) => manifest.name === NAME);
if (entry === undefined) {
  process.stderr.write(`${NAME} is not a published package of this repository.\n`);
  process.exit(1);
}
const { version } = entry.manifest;

// changelog.mjs prints the section of the version. It exits with 1 when the section is missing or empty.
let notes;
try {
  notes = execFileSync(process.execPath, [join(root, "scripts", "changelog.mjs"), version], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
} catch {
  process.stderr.write(`Add the section of ${version} to CHANGELOG.md before the release.\n`);
  process.exit(1);
}

const plan = [
  {
    name: NAME,
    version,
    tag: `v${version}`,
    prerelease: (parseVersion(version)?.prerelease.length ?? 0) > 0,
    title: `${NAME} ${version}`,
    notes,
    tarballs: packages.map(({ manifest }) => manifest.name),
  },
];
writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
for (const { tag, prerelease } of plan) process.stdout.write(`${tag}${prerelease ? " (prerelease)" : ""}\n`);
