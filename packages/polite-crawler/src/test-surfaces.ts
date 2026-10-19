/*
 * The tests of the command line and of the MCP server over standard input and output use these
 * helpers. The tests start the TypeScript source in a child process with the loader of `tsx`, and
 * they use only local servers on 127.0.0.1 and mock sites. No test uses the network.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MockAgent } from "undici";
import { openCrawler } from "./open.ts";
import type { Extractor } from "./runtime.ts";
import { fetchAndIndex } from "./runtime.ts";

/** This path is the source of the command line. */
export const CLI: string = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

/** This URL is the loader of `tsx`. A child process starts the TypeScript source with it. */
export const TSX: string = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** This function makes a temporary folder. */
export const tempDir = (tag: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `polite-crawler-${tag}-`));

/** This function removes a temporary folder. Windows can hold a file for a short time, so it tries again. */
export const removeDir = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/** The environment of a child process has no variable of polite-crawler, unless the test gives one. */
export const childEnv = (extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("POLITE_CRAWLER_")) env[name] = value;
  }
  return { ...env, ...extra };
};

/**
 * The environment of a child process in which polite-crawler finds polite-crawler-mcp next to it, as
 * in an installed project. NODE_PATH names the folder of the packages of this workspace.
 */
export const besidePoliteCrawler = (
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => {
  const packages = fileURLToPath(new URL("../..", import.meta.url));
  const paths = [packages, process.env["NODE_PATH"]].filter(
    (path) => path !== undefined && path !== "",
  );
  return childEnv({ ...extra, NODE_PATH: paths.join(delimiter) });
};

export interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** This function starts the command line with these arguments. It gives the exit code and the output. */
export const runCli = (
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<Ran> =>
  new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", TSX, CLI, ...args], {
      cwd: options.cwd,
      env: options.env ?? childEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });

export interface LocalSite {
  readonly origin: string;
  readonly hits: string[];
  close(): Promise<void>;
}

/** This function starts a web server on 127.0.0.1 with a free port. */
export const localSite = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LocalSite> => {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    handler(request, response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    hits,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
};

/** A plain page of the local site. */
export const PLAIN_PAGE: string = `<!doctype html><html lang="en"><head><title>Plain page</title></head><body><p>${"Plain words on a plain page. ".repeat(20)}</p></body></html>`;

/** The page of the mock bakery. */
export const BAKERY: string = `<!doctype html><html lang="en"><head><title>Forno Esempio</title>
<meta name="description" content="A bakery">
<script type="application/ld+json">{"@type":"Bakery","name":"Forno Esempio"}</script></head>
<body><h1>Forno Esempio</h1><p>${"Wood-fired bread, baked every morning before dawn. ".repeat(6)}</p>
<h2>Hours</h2><p>Tuesday to Sunday 7am–3pm</p>${Array.from({ length: 30 }, (_, at) => `<a href="/bread/${String(at)}">Bread ${String(at)}</a>`).join(" ")}</body></html>`;

/** The page of the mock bakery that asks not to be AI input. */
export const MEMBERS: string = `<!doctype html><html lang="en"><head><title>Members</title></head>
<body><p>The access code is 7319. ${"Words for members only. ".repeat(10)}</p></body></html>`;

type Reply = {
  readonly status: number;
  readonly body: string;
  readonly headers?: Record<string, string>;
};

const ALLOW_ALL_RULES = "User-agent: *\nAllow: /\n";

/**
 * This function gives a mock agent with three sites. Each site is a different host, so the crawler
 * fetches them at the same time, with no rest between them.
 *
 * - `https://bakery.example/`: a page with JSON-LD and links. robots.txt has the given rules.
 * - `https://members.example/`: a page that asks not to be AI input.
 * - `https://menu.example/menu.json`: the menu of the bakery, as JSON.
 */
export const mockSites = (
  robots: string = ALLOW_ALL_RULES,
): { readonly agent: MockAgent; readonly hits: string[] } => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const hits: string[] = [];
  const site = (origin: string, answer: (path: string) => Reply, rules = ALLOW_ALL_RULES): void => {
    agent
      .get(origin)
      .intercept({ path: () => true, method: "GET" })
      .reply((request) => {
        hits.push(`${origin}${request.path}`);
        // each robots.txt is different: two equal bodies at the same time race in the blob store (T-5)
        const robotsFile = `# ${origin}\n${rules}`;
        const reply: Reply =
          request.path === "/robots.txt" ? { status: 200, body: robotsFile } : answer(request.path);
        return {
          statusCode: reply.status,
          data: reply.body,
          responseOptions: { headers: reply.headers ?? {} },
        };
      })
      .persist();
  };
  site(
    "https://bakery.example",
    () => ({ status: 200, body: BAKERY, headers: { "content-type": "text/html" } }),
    robots,
  );
  site("https://members.example", () => ({
    status: 200,
    body: MEMBERS,
    headers: { "content-type": "text/html", "content-signal": "ai-input=no" },
  }));
  site("https://menu.example", () => ({
    status: 200,
    body: '{"items":["focaccia","rye"]}',
    headers: { "content-type": "application/json" },
  }));
  return { agent, hits };
};

/** This function registers the extractor of the application recipe `menu`. */
export const MENU_EXTRACTOR: Extractor = (body) => [
  {
    doc: "menu:bakery",
    kind: "menu",
    title: "The menu of the bakery",
    text: new TextDecoder().decode(body),
    url: "https://menu.example/menu.json",
    meta: {},
  },
];

/**
 * This function makes a store with three documents. They are the bakery page, a page that asks not
 * to be AI input, and a menu that the recipe `menu` of an application wrote.
 */
export const seedStore = async (dir: string): Promise<void> => {
  const { agent } = mockSites();
  const crawler = openCrawler({ dir, renderer: false, dispatcher: agent });
  try {
    crawler.runtime.extractors.register("menu", MENU_EXTRACTOR);
    await Promise.all([
      crawler.fetch("https://bakery.example/"),
      crawler.fetch("https://members.example/"),
      fetchAndIndex(crawler.runtime, {
        url: "https://menu.example/menu.json",
        mode: "api",
        recipe: "menu",
      }),
    ]);
  } finally {
    await crawler.close();
    await agent.close();
  }
};

export interface McpChild {
  readonly child: ChildProcessWithoutNullStreams;
  /** These are all the lines that the server wrote to its standard output. */
  readonly lines: string[];
  stderr(): string;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
  /** This method closes the standard input, and gives the exit code and the time to exit. */
  end(): Promise<{ readonly code: number | null; readonly ms: number }>;
  /** This method stops the server when it still runs, and waits for its exit. It is for the end of a test that failed. */
  stop(): Promise<void>;
}

/**
 * This function starts an MCP server in a child process, and talks JSON-RPC with it. The function
 * `answer` gives the result of each request that the server sends to the client. `entry` is the
 * source of the server and its first arguments: the default is `polite-crawler mcp`.
 */
export const startMcpChild = (
  args: readonly string[],
  env: NodeJS.ProcessEnv = childEnv(),
  answer: (method: string, params: unknown) => unknown = () => ({}),
  entry: readonly string[] = [CLI, "mcp"],
): McpChild => {
  const child = spawn(process.execPath, ["--import", TSX, ...entry, ...args], { env });
  const lines: string[] = [];
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = "";
  let stderr = "";
  let id = 0;
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.trim() === "") continue;
      lines.push(line);
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message["method"] === "string" && message["id"] !== undefined) {
          // a request of the server, for example elicitation/create
          write({
            jsonrpc: "2.0",
            id: message["id"],
            result: answer(message["method"], message["params"]),
          });
        } else if (typeof message["id"] === "number") waiting.get(message["id"])?.(message);
      } catch {
        // the test checks each line
      }
    }
  });
  const write = (message: Record<string, unknown>): void =>
    void child.stdin.write(`${JSON.stringify(message)}\n`);
  const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
  return {
    child,
    lines,
    stderr: () => stderr,
    request: (method, params) =>
      new Promise((done, fail) => {
        id += 1;
        const timer = setTimeout(
          () => fail(new Error(`no answer to ${method}. stderr: ${stderr}`)),
          20_000,
        );
        waiting.set(id, (message) => {
          clearTimeout(timer);
          done(message);
        });
        write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      }),
    notify: (method, params) =>
      write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
    end: async () => {
      const started = Date.now();
      child.stdin.end();
      const code = await Promise.race([
        exited,
        new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 10_000)),
      ]);
      if (code === "timeout") {
        child.kill();
        throw new Error("the MCP server did not stop in 10 s after its standard input closed");
      }
      return { code, ms: Date.now() - started };
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
};
