#!/usr/bin/env node
// The smoke test of the published artifacts of polite-crawler and polite-crawler-mcp.
//
//   node scripts/smoke.mjs                         pack the two packages (build them first if needed)
//   node scripts/smoke.mjs --tarball <file>        test this tarball of polite-crawler
//   node scripts/smoke.mjs --mcp-tarball <file>    test this tarball of polite-crawler-mcp
//   node scripts/smoke.mjs --keep                  keep the temporary folder, and print its path
//
// It checks the tarballs the way a user gets them:
//   1. The packed manifests: every entry point is in its tarball, the root entry point of
//      polite-crawler loads no MCP SDK and no zod, and server.json agrees with polite-crawler-mcp.
//   2. An empty project installs the two tarballs from disk, with their dependencies from npm.
//   3. Every subpath imports, and a store opens (SQLite with FTS5).
//   4. A TypeScript project type-checks its use of each entry point (nodenext, and bundler).
//   5. The entry points for a browser stay inside their size budgets (gzip, bundled with esbuild).
//   6. The commands run: --version, --help, find, and an MCP handshake over standard input and
//      output, with polite-crawler-mcp and with the deprecated polite-crawler mcp.
//   7. attw (the esm-only profile) and publint examine each tarball.

import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "packages", "polite-crawler");
const mcpDir = join(root, "packages", "polite-crawler-mcp");

const { values } = parseArgs({
  options: {
    tarball: { type: "string" },
    "mcp-tarball": { type: "string" },
    keep: { type: "boolean" },
  },
});

let failures = 0;
const step = (text) => process.stdout.write(`\n== ${text}\n`);
const ok = (text) => process.stdout.write(`  ok    ${text}\n`);
const bad = (text) => {
  failures += 1;
  process.stdout.write(`  FAIL  ${text}\n`);
};
const check = (condition, text) => (condition ? ok(text) : bad(text));
const show = (text) => {
  if (text.trim() !== "") process.stdout.write(`${text.trimEnd().replace(/^/gm, "        ")}\n`);
};

// One command line. On Windows npm, pnpm and the bin shims are .cmd files, which need a shell.
const quote = (arg) => (/^[\w./:=@\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);
const run = (command, args, options = {}) => {
  const result = spawnSync([command, ...args].map(quote).join(" "), {
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const must = (label, result) => {
  if (result.status !== 0) {
    bad(`${label} (exit ${String(result.status)})`);
    show(result.stdout + result.stderr);
    throw new Error(`${label} failed`);
  }
  ok(label);
  return result;
};

// A tarball is a gzip of 512-byte blocks: a header, then the content of the file.
const readTarball = (file) => {
  const data = gunzipSync(readFileSync(file));
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => {
      const text = header.subarray(start, start + length).toString("utf8");
      const end = text.indexOf("\0");
      return end === -1 ? text : text.slice(0, end);
    };
    const name = field(345, 155) === "" ? field(0, 100) : `${field(345, 155)}/${field(0, 100)}`;
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    offset += 512;
    if (type === "0" || type === "")
      files.set(name.replace(/^package\//, ""), data.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
};

const targetsOf = (value, where, into) => {
  if (typeof value === "string") into.push([where, value]);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      targetsOf(item, `${where}[${JSON.stringify(key)}]`, into);
  }
  return into;
};

const work = mkdtempSync(join(tmpdir(), "polite-crawler-smoke-"));
let server;
try {
  // 1. The tarballs and their manifests
  /** This function packs a package of the workspace (it builds it first if needed), or takes the given tarball. */
  const tarballOf = (name, dir, given) => {
    if (given !== undefined) return resolve(given);
    if (!existsSync(join(dir, "build", "cli.mjs"))) {
      must(`pnpm --filter ${name} build`, run("pnpm", ["--filter", name, "build"], { cwd: root }));
    }
    const out = join(work, `pack-${name}`);
    mkdirSync(out);
    must(
      `pnpm pack ${name}`,
      run("pnpm", ["--filter", name, "pack", "--pack-destination", out], { cwd: root }),
    );
    const packed = readdirSync(out).filter((file) => file.endsWith(".tgz"));
    if (packed.length !== 1) throw new Error(`pnpm pack made ${String(packed.length)} tarballs`);
    return join(out, packed[0]);
  };
  /** This function checks the manifest of a tarball: each entry point is in it, with no src/ and no declaration maps. */
  const examine = (tarball) => {
    ok(tarball);
    const files = readTarball(tarball);
    const manifest = JSON.parse(files.get("package.json").toString("utf8"));
    ok(`${manifest.name}@${manifest.version}, ${String(files.size)} files`);
    const targets = ["main", "types", "bin", "exports"].flatMap((field) =>
      targetsOf(manifest[field], field, []),
    );
    for (const [where, target] of targets) {
      check(files.has(target.replace(/^\.\//, "")), `${where} -> ${target} is in the tarball`);
    }
    check(![...files.keys()].some((name) => name.startsWith("src/")), "the tarball has no src/");
    check(
      ![...files.keys()].some((name) => name.endsWith(".d.mts.map")),
      "the tarball has no declaration maps",
    );
    check(
      typeof manifest.engines?.node === "string",
      `engines.node is ${String(manifest.engines?.node)}`,
    );
    // a dependency that is a link or a git ref does not install from npm
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      check(
        !/^(?:link|file|workspace|github|git\+?\w*):/.test(String(range)),
        `${dependency} ${String(range)} installs from npm`,
      );
    }
    return { files, manifest };
  };

  step("the tarball of polite-crawler");
  const tarball = tarballOf("polite-crawler", packageDir, values.tarball);
  const { files, manifest } = examine(tarball);
  check(manifest.exports?.["./mcp"] === undefined, "polite-crawler has no ./mcp entry point");
  check(manifest.mcpName === undefined, "polite-crawler has no mcpName");

  // The root entry point must not load the MCP SDK or zod: polite-crawler-mcp does. This walks
  // the static imports of the root module through the files of the tarball.
  const rootTarget = manifest.exports?.["."]?.default ?? manifest.main;
  const graph = new Set();
  const packages = new Set();
  const walk = (file) => {
    if (graph.has(file) || !files.has(file)) return;
    graph.add(file);
    const source = files.get(file).toString("utf8");
    for (const [, specifier] of source.matchAll(
      /^\s*(?:import|export)\b[^"'`]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm,
    )) {
      if (specifier === undefined) continue;
      if (specifier.startsWith(".")) walk(join(dirname(file), specifier).replace(/\\/g, "/"));
      else
        packages.add(
          specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")
            : specifier.split("/")[0],
        );
    }
  };
  walk(rootTarget.replace(/^\.\//, ""));
  check(
    graph.size > 1 && !packages.has("@modelcontextprotocol/sdk") && !packages.has("zod"),
    `the root entry point loads ${String(graph.size)} files and no MCP SDK or zod (${[...packages].sort((a, b) => a.localeCompare(b)).join(", ")})`,
  );
  // the optional peers load only when a page needs a browser, or a hybrid search needs a model
  check(
    !packages.has("@huggingface/transformers") && !packages.has("playwright-core"),
    "the root entry point loads no optional peer at start",
  );

  step("the tarball of polite-crawler-mcp");
  const mcpTarball = tarballOf("polite-crawler-mcp", mcpDir, values["mcp-tarball"]);
  const { manifest: mcpManifest } = examine(mcpTarball);
  check(
    mcpManifest.dependencies?.["polite-crawler"] !== undefined,
    `polite-crawler-mcp depends on polite-crawler ${String(mcpManifest.dependencies?.["polite-crawler"])}`,
  );
  const registry = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
  const entry = registry.packages?.find((item) => item.registryType === "npm");
  check(
    mcpManifest.mcpName === registry.name,
    `mcpName ${String(mcpManifest.mcpName)} is the name in server.json`,
  );
  check(
    registry.version === mcpManifest.version,
    `server.json version ${String(registry.version)}`,
  );
  check(entry?.identifier === mcpManifest.name, `server.json package ${String(entry?.identifier)}`);
  check(
    entry?.version === mcpManifest.version,
    `server.json package version ${String(entry?.version)}`,
  );

  // 2. An empty project installs the tarballs
  step("install into an empty project");
  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "smoke-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  must(
    "npm install <the two tarballs>",
    run(
      "npm",
      [
        "install",
        tarball,
        mcpTarball,
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--loglevel=error",
      ],
      {
        cwd: consumer,
      },
    ),
  );

  // 3. Every subpath imports, and a store opens
  step("import every subpath, and open a store");
  const subpaths = Object.keys(manifest.exports ?? { ".": manifest.main });
  writeFileSync(
    join(consumer, "check.mjs"),
    `const subpaths = ${JSON.stringify(subpaths)};
for (const subpath of subpaths) {
  const specifier = subpath === "." ? ${JSON.stringify(manifest.name)} : ${JSON.stringify(manifest.name)} + subpath.slice(1);
  if (subpath === "./package.json") {
    const json = await import(specifier, { with: { type: "json" } });
    if (json.default.version !== ${JSON.stringify(manifest.version)}) throw new Error(specifier + " has the wrong version");
  } else if (subpath.endsWith(".schema.json")) {
    const json = await import(specifier, { with: { type: "json" } });
    if (typeof json.default.$schema !== "string") throw new Error(specifier + " is not a JSON Schema");
  } else {
    const names = Object.keys(await import(specifier));
    if (names.length === 0) throw new Error(specifier + " exports nothing");
  }
  console.log("imported " + specifier);
}
const root = await import(${JSON.stringify(manifest.name)});
if (typeof root.openCrawler !== "function") throw new Error("the root entry point has no openCrawler");
if ("createMcpServer" in root) throw new Error("the root entry point exports the MCP server");
const gone = await import(${JSON.stringify(`${manifest.name}/mcp`)}).then(() => false, () => true);
if (!gone) throw new Error("polite-crawler/mcp still imports");
const mcp = await import(${JSON.stringify(mcpManifest.name)});
for (const name of ["createMcpServer", "startMcpServer", "startMcpHttpServer", "crawlTools"]) {
  if (typeof mcp[name] !== "function") throw new Error("polite-crawler-mcp has no " + name);
}
if (typeof mcp.mcpHttpHost?.start !== "function") throw new Error("polite-crawler-mcp has no mcpHttpHost");
if (mcp.VERSION !== ${JSON.stringify(mcpManifest.version)}) throw new Error("polite-crawler-mcp has the wrong VERSION");
const { openCrawler } = root;
const crawler = openCrawler({ dir: "./store-library", renderer: false });
const found = await crawler.find("smoke");
await crawler.close();
console.log("opened a store, find gave " + String(found.length) + " results");
`,
  );
  const imported = run("node", ["check.mjs"], { cwd: consumer });
  show(imported.stdout);
  must("every subpath imports, and a store opens", imported);

  // 3b. A TypeScript project checks its use of each entry point, with each kind of module resolution
  step("a TypeScript project type-checks");
  writeFileSync(
    join(consumer, "types.ts"),
    `import { catchUpIndex, createRuntime, openCrawler, type PageResult, type ReadResult, type VerifyResult } from "polite-crawler";
import { createMcpServer, startMcpServer } from "polite-crawler-mcp";
import { decide, parseRobots } from "polite-crawler/robots";
import { describeWeek, fromText } from "polite-crawler/hours";
import { extractPage, type PageExtract } from "polite-crawler/html";
import { classify } from "polite-crawler/classify";
import { DEFAULT_POLICY } from "polite-crawler/politeness";
import { readSignals, type Signals } from "polite-crawler/signals";
import schema from "polite-crawler/record.schema.json" with { type: "json" };

export const check = async (): Promise<string> => {
  const crawler = openCrawler({ dir: "./store-types", renderer: false, contact: "ops@example.com" });
  const page: PageResult = await crawler.fetch("https://example.com/");
  const read: ReadResult = await crawler.read(page.doc ?? "");
  const verified: VerifyResult = await crawler.verify(read.doc, "Example");
  const server = createMcpServer(crawler, { onBehalfOf: ["Claude-User"] });
  const runtime = createRuntime({ dir: "./store-runtime", renderer: false });
  const caught = await catchUpIndex(runtime);
  const allowed: boolean = decide(parseRobots("User-agent: *\\nDisallow: /x\\n"), ["PoliteCrawler"], "/").allowed;
  const week: string = describeWeek(fromText("Mon-Fri 9am-5pm")[0]!.week);
  const extract: PageExtract = extractPage("<p>x</p>", "https://example.com/");
  const signals: Signals = readSignals([], () => undefined);
  const outcome: string = classify(200, () => undefined, Date.now()).outcome;
  return [allowed, week, extract.title, signals.ai_input, verified.found, DEFAULT_POLICY.pageIntervalMs, schema.title, typeof server, typeof startMcpServer, caught?.mode, outcome].join();
};
`,
  );
  // The check uses the oldest and the newest @types/node of the workspace: the types of the lowest
  // Node.js in engines, and the types that a new project gets. A declaration file of the package can
  // name a type that only one of them has (0.1.3 imported JsonWebKey, which @types/node 26 removed).
  const versionOf = (dir) =>
    JSON.parse(readFileSync(join(dir, "node", "package.json"), "utf8")).version;
  const newer = (a, b) => {
    const [x, y] = [a, b].map((version) => version.split(".").map(Number));
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  };
  const nodeTypes = readdirSync(join(root, "packages"))
    .map((name) => join(root, "packages", name, "node_modules", "@types"))
    .filter((dir) => existsSync(join(dir, "node", "package.json")))
    .sort((a, b) => newer(versionOf(a), versionOf(b)));
  if (nodeTypes.length === 0) nodeTypes.push(join(packageDir, "node_modules", "@types"));
  const typeSets = [...new Set([nodeTypes[0], nodeTypes.at(-1)])];
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  for (const types of typeSets) {
    const version = versionOf(types);
    for (const [label, module, moduleResolution] of [
      ["module nodenext", "nodenext", "nodenext"],
      ["module preserve, resolution bundler", "preserve", "bundler"],
    ]) {
      const config = `tsconfig.${moduleResolution}.node-${version}.json`;
      writeFileSync(
        join(consumer, config),
        `${JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: false,
              target: "es2022",
              module,
              moduleResolution,
              resolveJsonModule: true,
              types: ["node"],
              typeRoots: [types],
            },
            files: ["types.ts"],
          },
          null,
          2,
        )}\n`,
      );
      must(
        `tsc --noEmit, ${label}, @types/node ${version}`,
        run("node", [tsc, "-p", config], { cwd: consumer }),
      );
    }
  }

  // 3c. The entry points that a browser uses stay small: the gzip size of each one, bundled and minified
  step("the size of the entry points for a browser");
  const { build } = await import("esbuild");
  // the sizes of version 0.1.0, and 20 percent more
  const budgets = {
    robots: 2900,
    hours: 8700,
    classify: 1300,
    politeness: 3000,
    signals: 1100,
    html: 138_000,
  };
  for (const [name, budget] of Object.entries(budgets)) {
    const bundled = await build({
      stdin: {
        contents: `export * from "${manifest.name}/${name}";`,
        resolveDir: consumer,
        loader: "js",
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      minify: true,
      write: false,
      logLevel: "silent",
    });
    const size = gzipSync(bundled.outputFiles[0].contents).length;
    check(
      size <= budget,
      `${manifest.name}/${name}: ${String(size)} bytes after gzip, the budget is ${String(budget)}`,
    );
  }

  // 4. The command
  step("the command line");
  const bins = join(consumer, "node_modules", ".bin");
  const env = { ...process.env, PATH: `${bins}${delimiter}${process.env.PATH ?? ""}` };
  const command = Object.keys(
    typeof manifest.bin === "string" ? { [manifest.name]: 0 } : manifest.bin,
  )[0];
  const version = must(`${command} --version`, run(command, ["--version"], { cwd: consumer, env }));
  check(version.stdout.trim() === manifest.version, `--version prints ${version.stdout.trim()}`);
  const help = must(`${command} --help`, run(command, ["--help"], { cwd: consumer, env }));
  check(help.stdout.includes("Usage"), "--help prints the usage");
  // find with no match exits 1, and a wrong command line exits 2 before it opens a store
  const found = run(command, ["find", "smoke", "--dir", "./store-cli"], { cwd: consumer, env });
  check(
    found.status === 1 && found.stdout.includes("nothing stored matches"),
    `${command} find smoke --dir ./store-cli: no match, exit ${String(found.status)}`,
  );
  if (found.status !== 1) show(found.stdout + found.stderr);
  const wrong = run(command, ["bogus", "--dir", "./store-wrong"], { cwd: consumer, env });
  check(
    wrong.status === 2 && !existsSync(join(consumer, "store-wrong")),
    `${command} bogus: exit ${String(wrong.status)}, and no store`,
  );

  // The MCP server: initialize, then tools/list. Each line of stdout must be JSON-RPC.
  const mcpCommand = Object.keys(mcpManifest.bin)[0];
  const mcpVersion = must(
    `${mcpCommand} --version`,
    run(mcpCommand, ["--version"], { cwd: consumer, env }),
  );
  check(
    mcpVersion.stdout.trim() === mcpManifest.version,
    `--version prints ${mcpVersion.stdout.trim()}`,
  );
  const handshake = (args, label) =>
    new Promise((done, fail) => {
      let stderr = "";
      server = spawn(args.map(quote).join(" "), {
        cwd: consumer,
        env,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let buffer = "";
      const timer = setTimeout(
        () => fail(new Error(`${label} gave no tool list in 30 s. stderr: ${stderr}`)),
        30_000,
      );
      server.stderr.on("data", (chunk) => (stderr += chunk));
      server.on("error", fail);
      server.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line === "") continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            bad(`${label} wrote a line that is not JSON: ${line.slice(0, 200)}`);
            continue;
          }
          if (message.id === 1) {
            ok(
              `${label}: initialize: ${String(message.result?.serverInfo?.name)} ${String(message.result?.serverInfo?.version)}`,
            );
            server.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
            );
            server.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
            );
          } else if (message.id === 2) {
            clearTimeout(timer);
            done({
              tools: (message.result?.tools ?? []).map((tool) => tool.name),
              stderr: () => stderr,
            });
          }
        }
      });
      server.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "smoke", version: "0" },
          },
        })}\n`,
      );
    });
  const stopped = () =>
    new Promise((done) => {
      const timer = setTimeout(() => done(false), 10_000);
      server.on("exit", () => {
        clearTimeout(timer);
        done(true);
      });
      server.stdin.end();
    });
  const TOOLS = [
    "crawl_fetch",
    "crawl_find",
    "crawl_read",
    "crawl_verify",
    "crawl_discover",
    "crawl_site",
    "crawl_diff",
    "crawl_watch_list",
    "crawl_extract",
  ];
  for (const [args, label] of [
    [[mcpCommand, "--dir", "./store-mcp", "--no-browser"], mcpCommand],
    [[command, "mcp", "--dir", "./store-mcp", "--no-browser"], `${command} mcp`],
  ]) {
    const { tools, stderr } = await handshake(args, label);
    for (const name of TOOLS) check(tools.includes(name), `${label} lists ${name}`);
    check(await stopped(), `${label} stops when its standard input closes`);
    if (label === `${command} mcp`)
      check(stderr().includes("is deprecated"), `${label} says that the command is deprecated`);
    server = undefined;
  }

  // 5. attw and publint
  step("attw and publint");
  // attw prints a table for each entry point. must() prints the output only when a tool fails.
  for (const file of [tarball, mcpTarball]) {
    must(
      `attw --profile esm-only ${file}`,
      run(
        "pnpm",
        ["exec", "attw", file, "--profile", "esm-only", "--format", "ascii", "--no-color"],
        { cwd: root },
      ),
    );
    must(
      `publint --strict ${file}`,
      run("pnpm", ["exec", "publint", "run", file, "--strict"], { cwd: root }),
    );
  }
} catch (error) {
  // must() counted its own failure. Any other error is a new one.
  if (!(error instanceof Error && error.message.endsWith(" failed"))) failures += 1;
  process.stdout.write(
    `\nThe smoke test stopped: ${error instanceof Error ? error.message : String(error)}\n`,
  );
} finally {
  server?.kill();
  if (values.keep === true) process.stdout.write(`\nThe temporary folder is ${work}\n`);
  else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

process.stdout.write(
  failures === 0 ? "\nsmoke: all good\n" : `\nsmoke: ${String(failures)} failed\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
