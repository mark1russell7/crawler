import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalSite } from "./test-surfaces.ts";
import {
  PLAIN_PAGE,
  childEnv,
  localSite,
  removeDir,
  runCli,
  seedStore,
  tempDir,
} from "./test-surfaces.ts";
import { VERSION } from "./version.ts";

const SLOW = 60_000;
let store: string;
let work: string;
let site: LocalSite;

beforeAll(async () => {
  store = await tempDir("cli-store");
  work = await tempDir("cli-work");
  await seedStore(store);
  site = await localSite((request, response) => {
    if (request.url === "/robots.txt") response.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    else response.writeHead(200, { "content-type": "text/html" }).end(PLAIN_PAGE);
  });
}, SLOW);

afterAll(async () => {
  await site.close();
  await removeDir(store);
  await removeDir(work);
});

describe("the command line: warnings", () => {
  it("removes only the experimental warning of node:sqlite from the standard error", async () => {
    // a different warning at the end of the run, after the command started, still shows
    const other =
      'let shown = false; process.on("beforeExit", () => { if (!shown) { shown = true; process.emitWarning("OTHER-WARNING", "ExperimentalWarning"); } });';
    const options = `${process.env["NODE_OPTIONS"] ?? ""} --import=data:text/javascript,${encodeURIComponent(other)}`.trim();
    const ran = await runCli(["find", "bread", "--dir", store], { env: childEnv({ NODE_OPTIONS: options }) });
    expect(ran.stderr).not.toContain("SQLite is an experimental feature");
    expect(ran.stderr).toContain("OTHER-WARNING");
  }, SLOW);
});

describe("the command line: help and usage errors", () => {
  it("prints the version and the help, with exit code 0", async () => {
    const [long, short, help] = await Promise.all([runCli(["--version"]), runCli(["-v"]), runCli(["--help"])]);
    expect(long).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
    expect(short).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(help.stdout).toContain("Exit codes:");
    expect(help.stdout).toContain("--allow-private");
  }, SLOW);

  it("exits with code 2 for a wrong command line, and opens no store", async () => {
    const dir = join(work, "never");
    const cases: ReadonlyArray<readonly [readonly string[], string]> = [
      [["bogus"], 'no command "bogus"'],
      [["fetch"], "fetch wants at least one URL"],
      [["find"], "find wants a query"],
      [["read", "a", "b"], "read wants one document id"],
      [["verify", "url:x"], "verify wants a document id and a quote"],
      [["reindex", "now"], "reindex takes no argument"],
      [["find", "x", "--limit", ""], '--limit wants a whole number, not ""'],
      [["find", "x", "--limit", "1e1"], "--limit wants a whole number"],
      [["find", "x", "--limit", "0"], "--limit wants 1 or more"],
      [["find", "x", "--limit", "-1"], "--limit"],
      [["find", "x", "--frobnicate"], "Unknown option '--frobnicate'"],
      [["read", "url:x", "--limit", "5"], "--limit is an option of find"],
      [["fetch", "https://example.com/", "--render", "bogus"], "--render is auto, never or always"],
      [["fetch", "https://example.com/", "--max-age", "soon"], "--max-age: not a duration"],
      [["find", "x", "--dir", ""], "--dir wants a folder"],
    ];
    const results = await Promise.all(cases.map(([args]) => runCli([...args, ...(args.includes("--dir") ? [] : ["--dir", dir])])));
    results.forEach((result, at) => {
      const [args, message] = cases[at]!;
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stdout, args.join(" ")).toBe("");
      expect(result.stderr, args.join(" ")).toContain(`polite-crawler: `);
      expect(result.stderr, args.join(" ")).toContain(message);
    });
    expect(existsSync(dir)).toBe(false);
  }, SLOW);

  it("exits with code 2 for a switch variable that is not 1 or 0", async () => {
    const result = await runCli(["find", "x", "--dir", join(work, "never2")], {
      env: childEnv({ POLITE_CRAWLER_ALLOW_PRIVATE: "maybe" }),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('POLITE_CRAWLER_ALLOW_PRIVATE is 1 or 0, not "maybe"');
  }, SLOW);

  it("exits with code 1 when the store is not a folder", async () => {
    const file = join(work, "a-file");
    await writeFile(file, "not a folder");
    const result = await runCli(["find", "bread", "--dir", file]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`the store ${file} does not open`);
  }, SLOW);
});

describe("the command line: the store", () => {
  it("finds, reads and verifies, with exit code 0 for an answer and 1 for none", async () => {
    const [found, none, read, verified, missing, unknown] = await Promise.all([
      runCli(["find", "wood", "fired", "bread", "--dir", store]),
      runCli(["find", "zeppelin", "--dir", store]),
      runCli(["read", "url:https://bakery.example/", "--length", "100", "--dir", store]),
      runCli(["verify", "url:https://bakery.example/", "Tuesday", "to", "Sunday", "--dir", store]),
      runCli(["verify", "url:https://bakery.example/", "Monday", "9am", "--dir", store]),
      runCli(["read", "url:https://nowhere.example/", "--dir", store]),
    ]);
    expect(found.code).toBe(0);
    expect(found.stdout).toContain("url:https://bakery.example/  Forno Esempio");
    expect(none).toMatchObject({ code: 1, stdout: "nothing stored matches\n" });
    expect(read.code).toBe(0);
    expect(read.stdout).toContain("Forno Esempio\nhttps://bakery.example/\n[0–100 of ");
    expect(verified.code).toBe(0);
    expect(verified.stdout).toMatch(/^found at \d+–\d+ in fetch\.[0-9a-f]{12}: /);
    expect(missing).toMatchObject({ code: 1, stdout: "not found\n" });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no stored document url:https://nowhere.example/");
  }, SLOW);

  it("prints JSON for a program", async () => {
    const result = await runCli(["find", "bread", "--json", "--limit", "1", "--dir", store]);
    expect(result.code).toBe(0);
    const hits = JSON.parse(result.stdout) as Array<{ doc: string }>;
    expect(hits).toEqual([expect.objectContaining({ doc: "url:https://bakery.example/" })]);
  }, SLOW);

  it("holds back a page that refuses AI input, and reads it with --user-provided", async () => {
    const held = await runCli(["read", "url:https://members.example/", "--dir", store]);
    expect(held.code).toBe(1);
    expect(held.stdout).toContain("Add --user-provided if you gave this URL yourself.");
    expect(held.stdout).not.toContain("7319");
    const given = await runCli(["read", "url:https://members.example/", "--user-provided", "--dir", store]);
    expect(given.code).toBe(0);
    expect(given.stdout).toContain("The access code is 7319.");
    const logs = await readdir(join(store, "captures"), { recursive: true });
    const text = await Promise.all(
      logs.filter((name) => name.endsWith(".ndjson")).map((name) => readFile(join(store, "captures", name), "utf8")),
    );
    expect(text.join("")).toContain('"kind":"override"');
  }, SLOW);

  it("keeps the documents of an application recipe through a reindex", async () => {
    const dir = await tempDir("cli-reindex");
    try {
      await seedStore(dir);
      const rebuilt = await runCli(["reindex", "--dir", dir]);
      expect(rebuilt.code).toBe(0);
      expect(rebuilt.stdout).toMatch(/^\d+ captures replayed, 3 documents, \d+ URLs\n1 documents of other recipes kept: menu\n$/);
      expect((await runCli(["find", "focaccia", "--dir", dir])).code).toBe(0);
      expect((await runCli(["find", "bread", "--dir", dir])).code).toBe(0);
    } finally {
      await removeDir(dir);
    }
  }, SLOW);

  it("puts a store with ~ in the home folder, and a relative store in the working folder", async () => {
    const home = await tempDir("cli-home");
    const cwd = await tempDir("cli-cwd");
    try {
      const env = childEnv({ HOME: home, USERPROFILE: home, POLITE_CRAWLER_DIR: "~/research" });
      const tilde = await runCli(["find", "bread"], { cwd, env });
      expect(tilde.code).toBe(1);
      expect(existsSync(join(home, "research", "index.sqlite"))).toBe(true);
      expect(existsSync(join(cwd, "~"))).toBe(false);
      const relative = await runCli(["find", "bread", "--dir", "here"], { cwd, env });
      expect(relative.code).toBe(1);
      expect(existsSync(join(cwd, "here", "index.sqlite"))).toBe(true);
    } finally {
      await removeDir(home);
      await removeDir(cwd);
    }
  }, SLOW);
});

describe("the command line: fetch", () => {
  it("refuses a private address by default, names a bad URL, and exits with code 1", async () => {
    const dir = await tempDir("cli-fetch");
    try {
      const before = site.hits.length;
      const result = await runCli(["fetch", "notaurl", `${site.origin}/a`, "notaurl", "--no-browser", "--dir", dir]);
      expect(result.code).toBe(1);
      expect(result.stdout.match(/^✗ notaurl$/gm)).toHaveLength(1);
      expect(result.stdout).toContain(`✗ ${site.origin}/a`);
      expect(result.stdout).toContain("egress policy: 127.0.0.1 is a loopback address");
      expect(site.hits.length).toBe(before);
    } finally {
      await removeDir(dir);
    }
  }, SLOW);

  it("fetches a private address with --allow-private, and a new copy with --max-age 0", async () => {
    const dir = await tempDir("cli-fetch");
    try {
      const first = await runCli(["fetch", `${site.origin}/a`, "--allow-private", "--no-browser", "--dir", dir]);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`✓ ${site.origin}/a`);
      const before = site.hits.length;
      const again = await runCli(["fetch", `${site.origin}/a`, "--allow-private", "--max-age", "0", "--json", "--dir", dir]);
      expect(again.code).toBe(0);
      expect(JSON.parse(again.stdout)).toEqual([expect.objectContaining({ outcome: "ok" })]);
      expect(site.hits.length).toBeGreaterThan(before);
    } finally {
      await removeDir(dir);
    }
  }, SLOW);
});
