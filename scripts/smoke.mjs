#!/usr/bin/env node
// The smoke test of the published artifact of polite-crawler.
//
//   node scripts/smoke.mjs                      pack packages/polite-crawler (build it first if needed)
//   node scripts/smoke.mjs --tarball <file>     test a tarball that `pnpm pack` made
//   node scripts/smoke.mjs --keep               keep the temporary folder, and print its path
//
// It checks the tarball the way a user gets it:
//   1. The packed manifest: every entry point is in the tarball, and server.json agrees with it.
//   2. An empty project installs the tarball from disk, with its dependencies from npm.
//   3. Every subpath imports, and a store opens (SQLite with FTS5).
//   4. A TypeScript project type-checks its use of each entry point (nodenext, and bundler).
//   5. The entry points for a browser stay inside their size budgets (gzip, bundled with esbuild).
//   6. The command runs: --version, --help, find, and an MCP handshake over standard input and output.
//   7. attw (the esm-only profile) and publint examine the tarball.

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

const { values } = parseArgs({
  options: { tarball: { type: "string" }, keep: { type: "boolean" } },
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
  // 1. The tarball and its manifest
  step("the tarball");
  let tarball = values.tarball === undefined ? undefined : resolve(values.tarball);
  if (tarball === undefined) {
    if (!existsSync(join(packageDir, "build", "cli.mjs"))) {
      must(
        "pnpm --filter polite-crawler build",
        run("pnpm", ["--filter", "polite-crawler", "build"], { cwd: root }),
      );
    }
    const out = join(work, "pack");
    mkdirSync(out);
    must(
      "pnpm pack",
      run("pnpm", ["--filter", "polite-crawler", "pack", "--pack-destination", out], { cwd: root }),
    );
    const packed = readdirSync(out).filter((name) => name.endsWith(".tgz"));
    if (packed.length !== 1) throw new Error(`pnpm pack made ${String(packed.length)} tarballs`);
    tarball = join(out, packed[0]);
  }
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

  // The root entry point must not load the MCP SDK or zod: only polite-crawler/mcp does. This walks
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

  const registry = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
  const entry = registry.packages?.find((item) => item.registryType === "npm");
  check(
    manifest.mcpName === registry.name,
    `mcpName ${String(manifest.mcpName)} is the name in server.json`,
  );
  check(registry.version === manifest.version, `server.json version ${String(registry.version)}`);
  check(entry?.identifier === manifest.name, `server.json package ${String(entry?.identifier)}`);
  check(
    entry?.version === manifest.version,
    `server.json package version ${String(entry?.version)}`,
  );

  // 2. An empty project installs the tarball
  step("install into an empty project");
  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "smoke-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  must(
    "npm install <tarball>",
    run(
      "npm",
      ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"],
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
const mcp = await import(${JSON.stringify(`${manifest.name}/mcp`)});
for (const name of ["createMcpServer", "startMcpServer"]) {
  if (typeof mcp[name] !== "function") throw new Error("polite-crawler/mcp has no " + name);
}
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
import { createMcpServer, startMcpServer } from "polite-crawler/mcp";
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
  const typeRoots = [join(packageDir, "node_modules", "@types")];
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  for (const [label, module, moduleResolution] of [
    ["module nodenext", "nodenext", "nodenext"],
    ["module preserve, resolution bundler", "preserve", "bundler"],
  ]) {
    const config = `tsconfig.${moduleResolution}.json`;
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
            typeRoots,
          },
          files: ["types.ts"],
        },
        null,
        2,
      )}\n`,
    );
    must(`tsc --noEmit, ${label}`, run("node", [tsc, "-p", config], { cwd: consumer }));
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
  const tools = await new Promise((done, fail) => {
    server = spawn([command, "mcp", "--dir", "./store-mcp", "--no-browser"].map(quote).join(" "), {
      cwd: consumer,
      env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(
      () => fail(new Error(`the MCP server gave no tool list in 30 s. stderr: ${stderr}`)),
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
          bad(`the MCP server wrote a line that is not JSON: ${line.slice(0, 200)}`);
          continue;
        }
        if (message.id === 1) {
          ok(
            `initialize: ${String(message.result?.serverInfo?.name)} ${String(message.result?.serverInfo?.version)}`,
          );
          server.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
          );
          server.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
          );
        } else if (message.id === 2) {
          clearTimeout(timer);
          done((message.result?.tools ?? []).map((tool) => tool.name));
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
  for (const name of ["crawl_fetch", "crawl_find", "crawl_read", "crawl_verify"]) {
    check(tools.includes(name), `the MCP server lists ${name}`);
  }
  const exited = await new Promise((done) => {
    const timer = setTimeout(() => done(false), 10_000);
    server.on("exit", () => {
      clearTimeout(timer);
      done(true);
    });
    server.stdin.end();
  });
  check(exited, "the MCP server stops when its standard input closes");
  server = undefined;

  // 5. attw and publint
  step("attw and publint");
  // attw prints a table for each entry point. must() prints the output only when a tool fails.
  must(
    "attw --profile esm-only",
    run(
      "pnpm",
      ["exec", "attw", tarball, "--profile", "esm-only", "--format", "ascii", "--no-color"],
      { cwd: root },
    ),
  );
  must(
    "publint --strict",
    run("pnpm", ["exec", "publint", "run", tarball, "--strict"], { cwd: root }),
  );
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
