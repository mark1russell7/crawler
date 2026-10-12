#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startMcpServer } from "./mcp.ts";
import type { OpenOptions } from "./open.ts";
import { openCrawler } from "./open.ts";
import type { PageResult } from "./runtime.ts";
import { VERSION } from "./version.ts";

const HELP = `polite-crawler ${VERSION}: fetch a source once, keep it, read it many times.

Usage:
  polite-crawler fetch <url...>      fetch pages into the store (robots.txt obeyed)
  polite-crawler find <query>        search the stored pages, with no request
  polite-crawler read <doc>          print a range of a stored document
  polite-crawler verify <doc> <quote>  check that a quote is in a stored document
  polite-crawler reindex             rebuild the search index from the capture log
  polite-crawler mcp                 serve the tools over MCP (standard input and output)

Options:
  --dir <path>        the store (default $POLITE_CRAWLER_DIR, or ~/.polite-crawler)
  --contact <text>    an email or URL for the From header ($POLITE_CRAWLER_CONTACT)
  --render <mode>     auto (default), never or always
  --max-age <age>     reuse a stored copy this young, such as 30m, 24h, 7d (default 24h)
  --limit <n>         how many results find gives (default 10)
  --kind <kind>       find only this kind of document, such as page or pdf
  --from <n>          where read starts (default 0)
  --length <n>        how many characters read gives (default 4000)
  --no-browser        never open the headless browser
  --json              print JSON
  --version, --help
`;

const fail = (message: string): never => {
  process.stderr.write(`polite-crawler: ${message}\n`);
  process.exit(2);
};

const describePage = (page: PageResult): string => {
  const head = `${page.outcome === "ok" || page.outcome === "not-modified" ? "✓" : "✗"} ${page.url}`;
  const facts = [
    `${page.outcome} ${String(page.status)}`,
    page.doc === null ? null : `doc ${page.doc}`,
    page.chars > 0 ? `${String(page.chars)} chars` : null,
    page.rendered ? "rendered" : null,
    page.structured.length > 0 ? `JSON-LD: ${page.structured.join(", ")}` : null,
  ].filter((fact) => fact !== null);
  return [head, `  ${facts.join(" · ")}`, ...(page.note === null ? [] : [`  ${page.note}`])].join("\n");
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      contact: { type: "string" },
      render: { type: "string" },
      "max-age": { type: "string" },
      limit: { type: "string" },
      kind: { type: "string" },
      from: { type: "string" },
      length: { type: "string" },
      "no-browser": { type: "boolean" },
      json: { type: "boolean" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version === true) return void process.stdout.write(`${VERSION}\n`);
  const [command, ...rest] = positionals;
  if (values.help === true || command === undefined) return void process.stdout.write(HELP);
  const number = (name: string, text: string | undefined, fallback: number): number => {
    if (text === undefined) return fallback;
    const value = Number(text);
    return Number.isInteger(value) && value >= 0 ? value : fail(`--${name} wants a whole number`);
  };
  const options: OpenOptions = {
    dir: values.dir ?? process.env["POLITE_CRAWLER_DIR"] ?? join(homedir(), ".polite-crawler"),
    contact: values.contact ?? process.env["POLITE_CRAWLER_CONTACT"],
    ...(values["no-browser"] === true ? { renderer: false as const } : {}),
  };
  if (command === "mcp") return startMcpServer(options);
  const print = (value: unknown, text: () => string): void => {
    process.stdout.write(`${values.json === true ? JSON.stringify(value, null, 2) : text()}\n`);
  };
  const crawler = openCrawler(options);
  try {
    switch (command) {
      case "fetch": {
        if (rest.length === 0) fail("fetch wants at least one URL");
        const render = values.render ?? "auto";
        if (render !== "auto" && render !== "never" && render !== "always")
          fail("--render is auto, never or always");
        const pages = await Promise.all(
          rest.map((url) =>
            crawler.fetch(url, {
              render: render as "auto" | "never" | "always",
              maxAge: values["max-age"] ?? "24h",
            }),
          ),
        );
        print(pages, () => pages.map(describePage).join("\n"));
        break;
      }
      case "find": {
        const q = rest.join(" ");
        if (q.length === 0) fail("find wants a query");
        const found = crawler.find(q, {
          limit: number("limit", values.limit, 10),
          kind: values.kind ?? null,
        });
        print(found, () =>
          found.length === 0
            ? "nothing stored matches"
            : found
                .map((hit) => `${hit.doc}  ${hit.title}\n  ${hit.snippet.replace(/\s+/g, " ")}`)
                .join("\n"),
        );
        break;
      }
      case "read": {
        const doc = rest[0] ?? fail("read wants a document id");
        const read = await crawler.read(doc, {
          from: number("from", values.from, 0),
          length: number("length", values.length, 4000),
        });
        print(read, () =>
          read.held_back
            ? (read.note ?? "")
            : `${read.title}\n${read.url ?? ""}\n[${String(read.from)}–${String(read.to)} of ${String(read.total)}]\n\n${read.text}`,
        );
        break;
      }
      case "verify": {
        const [doc, ...quote] = rest;
        if (doc === undefined || quote.length === 0) fail("verify wants a document id and a quote");
        const verified = crawler.verify(doc as string, quote.join(" "));
        print(verified, () =>
          verified.found
            ? `found at ${String(verified.start)}–${String(verified.end)}: ${verified.excerpt ?? ""}`
            : "not found",
        );
        break;
      }
      case "reindex": {
        const counts = await crawler.reindex();
        print(counts, () =>
          `${String(counts.captures)} captures replayed, ${String(counts.docs)} documents, ${String(counts.urls)} URLs`,
        );
        break;
      }
      default:
        fail(`no command "${command}" (polite-crawler --help lists them)`);
    }
  } finally {
    await crawler.close();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`polite-crawler: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
