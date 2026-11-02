// The tests of scripts/version.ts. Each test works on a copy of the version files in a temporary folder.
//
//   node --test scripts/version.test.ts
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHANGELOGS,
  NO_NOTES,
  PACKAGES,
  addSection,
  compareVersions,
  syncVersion,
} from "./version.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The files that name the version, from the root of the repository. */
const FILES = [
  ...PACKAGES.flatMap((name) => [
    `packages/${name}/package.json`,
    `packages/${name}/src/version.ts`,
    `packages/${name}/api/index.api.md`,
  ]),
  "server.json",
  ...CHANGELOGS,
];

let dir = "";
const read = (file: string): string => readFileSync(join(dir, file), "utf8");
const write = (file: string, text: string): void => writeFileSync(join(dir, file), text);
const versionOf = (name: string): unknown =>
  (JSON.parse(read(`packages/${name}/package.json`)) as { version?: unknown }).version;
/** This function sets the version of one package.json, as `npm version` does. */
const bump = (name: string, version: string): void => {
  const file = `packages/${name}/package.json`;
  const manifest = JSON.parse(read(file)) as Record<string, unknown>;
  write(file, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crawler-version-"));
  for (const file of FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(ROOT, file), join(dir, file));
  }
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

void describe("compareVersions", () => {
  void it("orders versions by the precedence of SemVer", () => {
    const ordered = [
      "0.2.4",
      "0.2.10",
      "0.3.0-alpha",
      "0.3.0-alpha.1",
      "0.3.0-alpha.beta",
      "0.3.0-beta.2",
      "0.3.0-beta.11",
      "0.3.0-rc.1",
      "0.3.0",
      "1.0.0",
    ];
    for (const [index, version] of ordered.entries()) {
      for (const other of ordered.slice(index + 1)) {
        assert.ok(compareVersions(version, other) < 0, `${version} < ${other}`);
        assert.ok(compareVersions(other, version) > 0, `${other} > ${version}`);
      }
      assert.equal(compareVersions(version, version), 0);
    }
    assert.equal(compareVersions("1.0.0+build.1", "1.0.0"), 0);
  });

  void it("refuses a version that is not SemVer", () => {
    assert.throws(() => compareVersions("1.0", "1.0.0"), /not a SemVer version/);
    assert.throws(() => compareVersions("v1.0.0", "1.0.0"), /not a SemVer version/);
  });
});

void describe("addSection", () => {
  void it("moves the notes of Unreleased into the section of the version", () => {
    const text =
      "# Changelog\n\n## Unreleased\n\n- A fix.\n- A feature.\n\n## 0.2.4 - 2026-10-25\n\n- Old.\n";
    assert.equal(
      addSection(text, "0.3.0", "2026-11-02"),
      "# Changelog\n\n## Unreleased\n\n## 0.3.0 - 2026-11-02\n\n- A fix.\n- A feature.\n\n## 0.2.4 - 2026-10-25\n\n- Old.\n",
    );
  });

  void it("writes one line when Unreleased has no notes, also as the last section", () => {
    assert.equal(
      addSection("# Changelog\n\n## Unreleased\n", "0.3.0", "2026-11-02"),
      `# Changelog\n\n## Unreleased\n\n## 0.3.0 - 2026-11-02\n\n${NO_NOTES}\n`,
    );
  });

  void it("does not change a changelog that has the section of the version", () => {
    const text = "## Unreleased\n\n- New.\n\n## 0.3.0 - 2026-11-01\n\n- Old.\n";
    assert.equal(addSection(text, "0.3.0", "2026-11-02"), text);
  });

  void it("refuses a changelog with no Unreleased section", () => {
    assert.throws(() => addSection("# Changelog\n", "0.3.0", "2026-11-02"), /no "## Unreleased"/);
  });
});

void describe("syncVersion", () => {
  void it("writes the higher version to each place, and a second run changes nothing", () => {
    const old = versionOf("polite-crawler");
    assert.equal(typeof old, "string");
    bump("polite-crawler-mcp", "9.8.7");
    const first = syncVersion(dir, "2026-11-02");
    assert.equal(first.version, "9.8.7");
    // the package.json of polite-crawler-mcp has the version already
    assert.deepEqual(
      [...first.changed].sort(),
      FILES.filter((file) => file !== "packages/polite-crawler-mcp/package.json").sort(),
    );
    for (const name of PACKAGES) {
      assert.equal(versionOf(name), "9.8.7");
      assert.match(read(`packages/${name}/src/version.ts`), /^export const VERSION = "9\.8\.7";$/m);
      assert.match(
        read(`packages/${name}/api/index.api.md`),
        /^export const VERSION = "9\.8\.7";$/m,
      );
    }
    const server = JSON.parse(read("server.json")) as {
      version: string;
      packages: Array<{ version: string }>;
    };
    assert.equal(server.version, "9.8.7");
    assert.deepEqual(
      server.packages.map((item) => item.version),
      ["9.8.7"],
    );
    for (const file of CHANGELOGS) {
      const lines = read(file).split("\n");
      const at = lines.indexOf("## Unreleased");
      assert.deepEqual(lines.slice(at, at + 3), ["## Unreleased", "", "## 9.8.7 - 2026-11-02"]);
    }
    const snapshot = FILES.map(read);
    const second = syncVersion(dir, "2026-11-03");
    assert.deepEqual(second, { version: "9.8.7", changed: [] });
    assert.deepEqual(FILES.map(read), snapshot);
  });

  void it("takes the higher version also when the other package has it", () => {
    bump("polite-crawler", "9.9.0");
    bump("polite-crawler-mcp", "9.9.0-rc.1");
    assert.equal(syncVersion(dir, "2026-11-02").version, "9.9.0");
    assert.equal(versionOf("polite-crawler-mcp"), "9.9.0");
  });

  void it("keeps the other fields of package.json byte for byte", () => {
    const before = read("packages/polite-crawler/package.json");
    bump("polite-crawler-mcp", "9.8.7");
    syncVersion(dir, "2026-11-02");
    const after = read("packages/polite-crawler/package.json");
    assert.equal(
      after.replace(/"version": "9\.8\.7"/, ""),
      before.replace(/"version": "[^"]*"/, ""),
    );
  });
});
