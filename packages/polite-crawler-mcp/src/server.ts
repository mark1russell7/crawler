import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { defineModule } from "@procedures/client";
import type { McpHost, McpHostOptions, McpTaskStore } from "@procedures/mcp-server";
import { createMcpHost } from "@procedures/mcp-server";
import type { OpenOptions, PoliteCrawler } from "polite-crawler";
import { browserMissing, openCrawler } from "polite-crawler";
import type { CrawlToolOptions } from "./tools.ts";
import { chooseTools } from "./tool-names.ts";
import { crawlContent, crawlTools, instructionsFor } from "./tools.ts";
import { SERVER_NAME, VERSION } from "./version.ts";

/** These options change the tools of the MCP server. */
export interface CrawlServerOptions extends CrawlToolOptions {
  /**
   * This store makes the long tools (`crawl_site` and `crawl_discover`) MCP tasks. A client that
   * asks for a task gets a task id at once. A client with no tasks gets the result in the call. The
   * server over HTTP gives the store. Without it, the long tools are normal tools.
   */
  readonly tasks?: McpTaskStore | undefined;
}

/** These options start the MCP server on the standard input and output. */
export interface StartMcpOptions extends OpenOptions, CrawlToolOptions {
  /** This function writes the messages of the server. The default writes them to the standard error. */
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * This is an MCP server with the nine tools over one crawler, before it has a transport. Connect it
 * to one transport of the MCP SDK, for example the `InMemoryTransport` of a test.
 */
export interface CrawlMcpServer {
  /** This method connects the server to a transport and starts it. A server connects one time. */
  connect(transport: Transport): Promise<void>;
  /** This method stops the server. The calls in progress stop. A second close does nothing. */
  close(): Promise<void>;
  /** This value is the MCP host of the server after `connect`, else undefined. */
  readonly host: McpHost | undefined;
}

/**
 * This function gives the options of the MCP host of the tools. They are the procedures in the
 * namespace `crawl`, the tool names `crawl_<name>` and the instructions for the chosen tools. They
 * also have the content hook of the envelopes and the task store.
 *
 * @beta
 */
export const crawlHostOptions = (
  crawler: PoliteCrawler,
  options: CrawlServerOptions = {},
): McpHostOptions => ({
  modules: [defineModule("polite-crawler", crawlTools(crawler, options))],
  surface: { namespaces: ["crawl"] },
  // the tools keep their names: crawl_fetch, not crawl.fetch
  toolName: (path) => path.join("_"),
  name: SERVER_NAME,
  version: VERSION,
  instructions: instructionsFor(chooseTools(options.tools)),
  content: crawlContent,
  json: "compact",
  ...(options.tasks === undefined ? {} : { tasks: { store: options.tasks } }),
});

/**
 * This function makes an MCP server with nine tools over one crawler: `crawl_fetch`, `crawl_find`,
 * `crawl_read`, `crawl_verify`, `crawl_extract`, `crawl_discover`, `crawl_site`, `crawl_diff` and
 * `crawl_watch_list`. The option `tools` chooses fewer tools. The tools are procedures on the
 * shared MCP host (`createMcpHost` of `@procedures/mcp-server`). The server does not connect to a
 * transport: `connect` does. Each fetch applies the robots.txt rules for `Claude-User` too, unless
 * `onBehalfOf` gives other tokens. No tool adds a watch or an export, because they are actions of
 * the operator.
 */
export const createMcpServer = (
  crawler: PoliteCrawler,
  options: CrawlServerOptions = {},
): CrawlMcpServer => {
  // an unknown tool name is an error of the call, not of connect
  chooseTools(options.tools);
  let host: McpHost | undefined;
  return {
    get host() {
      return host;
    },
    async connect(transport) {
      if (host !== undefined) throw new Error("this MCP server has a transport: make a new server");
      host = createMcpHost({ ...crawlHostOptions(crawler, options), faces: { sdk: transport } });
      await host.start();
    },
    async close() {
      await host?.stop();
    },
  };
};

/**
 * This function starts the MCP server on the standard input and output. The fetches apply the
 * robots.txt rules for `Claude-User` too, because an assistant asks for these pages. When the
 * default renderer has no browser, the server turns rendering off at start and writes one note.
 * The server stops when its standard input closes, or at `SIGINT` or `SIGTERM`.
 */
export const startMcpServer = async (options: StartMcpOptions): Promise<void> => {
  const {
    onBehalfOf,
    allowUserProvided,
    tools,
    renderOff: given,
    log = (line: string) => void process.stderr.write(`${line}\n`),
    ...open
  } = options;
  const chosen = chooseTools(tools);
  // a missing browser turns rendering off one time, at start
  const renderOff = given ?? (open.renderer === undefined ? await browserMissing() : undefined);
  const crawler = openCrawler({
    ...open,
    ...(renderOff === undefined ? {} : { renderer: false as const }),
  });
  const host = createMcpHost({
    ...crawlHostOptions(crawler, { onBehalfOf, allowUserProvided, renderOff, tools }),
    // the process stops at the end of the input, after the crawler closed
    faces: { stdio: { stopOnEnd: false } },
  });
  log(`polite-crawler-mcp ${VERSION}: MCP server on standard input and output, store ${open.dir}`);
  if (renderOff !== undefined) log(`polite-crawler: rendering is off: ${renderOff}`);
  if (tools !== undefined) log(`polite-crawler: the tools are ${chosen.join(", ")}`);
  if (open.embedder !== undefined)
    log(`polite-crawler: crawl_find takes rank hybrid, with the embedder ${open.embedder.id}`);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await host.stop();
      await crawler.close();
    })();
    return stopping;
  };
  const exit = (): void => void stop().finally(() => process.exit(0));
  process.once("SIGINT", exit);
  process.once("SIGTERM", exit);
  process.stdin.once("end", exit);
  await host.start();
};
