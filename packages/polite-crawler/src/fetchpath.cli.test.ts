import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalSite } from "./test-surfaces.ts";
import { PLAIN_PAGE, localSite, removeDir, runCli, tempDir } from "./test-surfaces.ts";
import { keyDirectory, verifySignature } from "./webbotauth.ts";

// The command line of the archived fallback and of signed requests (Web Bot Auth).

const SLOW = 60_000;
// The Ed25519 test key of RFC 9421, appendix B.1.4. A test key: never use it for a real crawler.
const KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF
-----END PRIVATE KEY-----
`;
const KEYID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";

let work: string;
let keyPath: string;
let site: LocalSite;
const seen: Array<{ readonly url: string; readonly headers: Record<string, string> }> = [];

beforeAll(async () => {
  work = await tempDir("fetchpath-cli");
  keyPath = join(work, "key.pem");
  await writeFile(keyPath, KEY);
  await writeFile(
    join(work, "bad.pem"),
    "-----BEGIN PRIVATE KEY-----\nSECRETBYTES\n-----END PRIVATE KEY-----\n",
  );
  site = await localSite((request, response) => {
    seen.push({
      url: request.url ?? "/",
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
      ),
    });
    if (request.url === "/robots.txt")
      response.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    else response.writeHead(200, { "content-type": "text/html" }).end(PLAIN_PAGE);
  });
}, SLOW);

afterAll(async () => {
  await site.close();
  await removeDir(work);
});

describe("the command line: archived copies and signed requests", () => {
  it(
    "lists the new options in the help",
    async () => {
      const help = await runCli(["--help"]);
      expect(help.code).toBe(0);
      for (const option of [
        "--archive-fallback",
        "--archive-despite-robots",
        "--sign-key",
        "--signature-agent",
        "key-directory",
      ])
        expect(help.stdout).toContain(option);
    },
    SLOW,
  );

  it(
    "gives exit code 2 for a wrong use of the options, and opens no store",
    async () => {
      const dir = join(work, "never");
      const runs = await Promise.all([
        runCli(["fetch", "https://example.com/", "--dir", dir, "--archive-despite-robots"]),
        runCli(["fetch", "https://example.com/", "--dir", dir, "--sign-key", keyPath]),
        runCli([
          "fetch",
          "https://example.com/",
          "--dir",
          dir,
          "--signature-agent",
          "https://bot.example",
        ]),
        runCli(["find", "bread", "--dir", dir, "--archive-fallback"]),
        runCli(["key-directory", "--dir", dir]),
        runCli([
          "fetch",
          "https://example.com/",
          "--dir",
          dir,
          "--sign-key",
          join(work, "bad.pem"),
          "--signature-agent",
          "https://bot.example",
        ]),
        runCli([
          "fetch",
          "https://example.com/",
          "--dir",
          dir,
          "--sign-key",
          keyPath,
          "--signature-agent",
          "http://bot.example",
        ]),
      ]);
      expect(runs.map((run) => run.code)).toEqual([2, 2, 2, 2, 2, 2, 2]);
      expect(runs[0]!.stderr).toContain(
        "--archive-despite-robots works only with --archive-fallback",
      );
      expect(runs[1]!.stderr).toContain("--sign-key and --signature-agent go together");
      expect(runs[3]!.stderr).toContain("--archive-fallback is an option of fetch");
      expect(runs[5]!.stderr).toContain("does not parse");
      expect(runs[6]!.stderr).toContain("not an https URL");
      // an error names the file, never the key
      for (const run of runs) {
        expect(run.stderr).not.toContain("SECRETBYTES");
        expect(run.stderr).not.toContain("MC4CAQAw");
      }
      expect(existsSync(dir)).toBe(false);
    },
    SLOW,
  );

  it(
    "prints the key directory of a key, with only its public part",
    async () => {
      const run = await runCli([
        "key-directory",
        "--sign-key",
        keyPath,
        "--signature-agent",
        "https://bot.example",
      ]);
      expect(run.code).toBe(0);
      const directory = JSON.parse(run.stdout) as { keys: Array<Record<string, string>> };
      expect(directory.keys).toEqual([
        {
          kty: "OKP",
          crv: "Ed25519",
          kid: KEYID,
          x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
          use: "sig",
        },
      ]);
      expect(run.stderr).toContain(
        "serve this JSON at https://bot.example/.well-known/http-message-signatures-directory with Content-Type: application/http-message-signatures-directory+json",
      );
    },
    SLOW,
  );

  it(
    "signs each request of a fetch with --sign-key, robots.txt too",
    async () => {
      const dir = join(work, "signed");
      seen.length = 0;
      const run = await runCli([
        "fetch",
        `${site.origin}/page`,
        "--dir",
        dir,
        "--allow-private",
        "--no-browser",
        "--sign-key",
        keyPath,
        "--signature-agent",
        "https://bot.example",
        "--json",
      ]);
      expect(run.code).toBe(0);
      expect(seen.map((hit) => hit.url)).toEqual(["/robots.txt", "/page"]);
      const directory = keyDirectory([KEY]);
      for (const hit of seen) {
        expect(hit.headers["user-agent"]).toMatch(/^PoliteCrawler\//);
        expect(hit.headers["signature-agent"]).toBe('sig1="https://bot.example"');
        expect(
          verifySignature({ url: `${site.origin}${hit.url}`, headers: hit.headers }, directory),
        ).toMatchObject({ verified: true, keyId: KEYID, agent: "https://bot.example" });
      }
      // a URL with a path names a JSON Web Key Set: a project site of GitHub Pages can host it
      seen.length = 0;
      const onPath = await runCli([
        "fetch",
        `${site.origin}/page`,
        "--dir",
        dir,
        "--allow-private",
        "--no-browser",
        "--max-age",
        "0",
        "--sign-key",
        keyPath,
        "--signature-agent",
        "https://example.github.io/crawler/jwks.json",
      ]);
      expect(onPath.code).toBe(0);
      expect(seen.at(-1)!.headers["signature-agent"]).toBe(
        'sig1="https://example.github.io/crawler/jwks.json";type=jwks_uri',
      );
    },
    SLOW,
  );
});
