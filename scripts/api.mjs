#!/usr/bin/env node
// The reports of the public API: one file for each entry point of the npm package, from API Extractor.
//
//   node scripts/api.mjs           write packages/polite-crawler/api/<entry>.api.md from the build
//   node scripts/api.mjs --check   fail when a report is not the API of the build
//
// Build the package first (`pnpm build`): API Extractor reads the declarations in build/. The script reads
// the entry points from "publishConfig.exports" of the package, so each new entry point gets a report.
// CI starts `--check`. Thus a change to the public API is a change to a report, and a pull request shows it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = join(ROOT, "packages", "polite-crawler");
const REPORTS = join(PKG, "api");
// temp/ is in .gitignore. In a check, API Extractor writes the new report there.
const TEMP = join(PKG, "temp", "api");
const check = process.argv.includes("--check");
const REPORT_MESSAGES = new Set([
  "console-api-report-not-copied",
  "console-api-report-copied",
  "console-api-report-created",
]);

const { Extractor, ExtractorConfig, ExtractorLogLevel } = createRequire(join(PKG, "package.json"))(
  "@microsoft/api-extractor",
);
const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
const entries = Object.entries(manifest.publishConfig.exports)
  .filter(([, target]) => typeof target === "object" && target.types)
  .map(([subpath, target]) => ({
    subpath,
    types: join(PKG, target.types),
    name: basename(target.types, ".d.mts"),
  }));

mkdirSync(REPORTS, { recursive: true });
mkdirSync(TEMP, { recursive: true });
const failed = [];
for (const entry of entries) {
  if (!existsSync(entry.types)) {
    console.error(`${entry.types} is missing. Start \`pnpm build\` first.`);
    process.exit(1);
  }
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: PKG,
      mainEntryPointFilePath: entry.types,
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            module: "nodenext",
            moduleResolution: "nodenext",
            target: "es2022",
            lib: ["es2023"],
            types: ["node"],
            strict: true,
            skipLibCheck: true,
          },
        },
      },
      apiReport: {
        enabled: true,
        reportFileName: entry.name,
        reportFolder: REPORTS,
        reportTempFolder: TEMP,
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      newlineKind: "lf",
      messages: {
        compilerMessageReporting: { default: { logLevel: "warning" } },
        // A message about the API (for example a type that an export uses but no entry point
        // exports) goes into the report, where a review sees it.
        extractorMessageReporting: {
          default: { logLevel: "warning", addToApiReportFile: true },
          // The package does not tag each export with a release tag. Untagged means public.
          "ae-missing-release-tag": { logLevel: "none" },
          // Many members have no doc comment, and the report says "(undocumented)" at each one.
          "ae-undocumented": { logLevel: "none" },
        },
        // The doc comments are prose for people. ste-lint checks them, not the TSDoc parser.
        tsdocMessageReporting: { default: { logLevel: "none" } },
      },
    },
    configObjectFullPath: undefined,
    packageJsonFullPath: join(PKG, "package.json"),
  });
  const result = Extractor.invoke(config, {
    localBuild: !check,
    messageCallback(message) {
      // Only the warnings and the errors. The rest is the progress of each run.
      if (
        message.logLevel === ExtractorLogLevel.Info ||
        message.logLevel === ExtractorLogLevel.Verbose
      )
        message.handled = true;
      // A changed report is the subject of this script. It has its own message below.
      if (REPORT_MESSAGES.has(message.messageId)) message.handled = true;
    },
  });
  const file = `api/${entry.name}.api.md`;
  if (!result.succeeded) failed.push(file);
  // API Extractor writes a message that it cannot put at a declaration with its position in build/.
  // The position changes with each build, so the cause must go.
  const placed = readFileSync(join(TEMP, `${entry.name}.api.md`), "utf8")
    .split("\n")
    .filter((line) => /^\/\/ build\/\S+:\d+:\d+ - /.test(line));
  for (const line of placed) console.error(`${file}: ${line.slice(3)}`);
  if (placed.length > 0) failed.push(`${file} (${placed.length} messages with a position)`);
  console.log(`${file} (${entry.subpath}): ${result.apiReportChanged ? "changed" : "same"}`);
}

// A report of an entry point that the package no longer has
const names = new Set(entries.map((entry) => `${entry.name}.api.md`));
for (const name of readdirSync(REPORTS)) {
  if (names.has(name)) continue;
  if (check) failed.push(`api/${name} (no such entry point)`);
  else rmSync(join(REPORTS, name));
}

if (failed.length > 0) {
  console.error(
    check
      ? `The public API is not the API in the reports: ${failed.join(", ")}. Start \`pnpm api\`, then commit the reports.`
      : `API Extractor failed: ${failed.join(", ")}.`,
  );
  process.exit(1);
}
