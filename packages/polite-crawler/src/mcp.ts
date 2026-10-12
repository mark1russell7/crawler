import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { OpenOptions, PoliteCrawler } from "./open.ts";
import { openCrawler } from "./open.ts";
import { VERSION } from "./version.ts";

const json = (value: unknown): { content: Array<{ type: "text"; text: string }> } => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

/**
 * This function makes an MCP server with four tools over one crawler: `crawl_fetch`,
 * `crawl_find`, `crawl_read` and `crawl_verify`. The server does not connect to a transport.
 */
export const createMcpServer = (crawler: PoliteCrawler): McpServer => {
  const server = new McpServer({ name: "polite-crawler", version: VERSION });

  server.registerTool(
    "crawl_fetch",
    {
      title: "Fetch web pages politely",
      description:
        "Fetch web pages into a local store and read them: robots.txt obeyed (rules for Claude-User too), one request at a time per site, JSON-LD and visible text extracted, and a headless browser only when a page shows nothing without JavaScript. A page fetched within max_age comes from the store with no request. Returns each page's document id for crawl_read, its schema.org types and the capture ids to cite.",
      inputSchema: {
        urls: z.array(z.string().url()).min(1).max(20),
        render: z.enum(["auto", "never", "always"]).default("auto"),
        max_age: z.string().default("24h").describe('how old a stored copy may be, such as "30m", "24h" or "7d"'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ urls, render, max_age }) => {
      // different sites run at once; the crawler keeps one request in flight per site
      const pages = await Promise.all(
        urls.map((url) => crawler.fetch(url, { render, maxAge: max_age })),
      );
      return json(pages);
    },
  );

  server.registerTool(
    "crawl_find",
    {
      title: "Search stored pages",
      description:
        "Search every page the crawler has stored, with full-text ranking (SQLite FTS5, BM25). Returns ranked passages with document ids; read one with crawl_read. Sends no request.",
      inputSchema: {
        q: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
        kind: z.string().nullable().default(null).describe("only this kind of document, such as page or pdf"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ q, limit, kind }) => json(crawler.find(q, { limit, kind })),
  );

  server.registerTool(
    "crawl_read",
    {
      title: "Read a stored document",
      description:
        "Read a range of characters of a stored document (the first 4,000 by default), with the capture ids behind it. A page that asked not to be used as AI input is held back unless the user gave its URL directly.",
      inputSchema: {
        doc: z.string().min(1),
        from: z.number().int().min(0).default(0),
        length: z.number().int().min(100).max(20_000).default(4000),
        user_provided: z.boolean().default(false).describe("the user gave this URL directly"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ doc, from, length, user_provided }) =>
      json(await crawler.read(doc, { from, length, userProvided: user_provided })),
  );

  server.registerTool(
    "crawl_verify",
    {
      title: "Check a quote",
      description:
        "Check that a quote really appears in a stored document, forgiving case, whitespace and typographic punctuation. Returns the exact span with character offsets and the capture ids to cite, so a citation rests on stored text, not memory.",
      inputSchema: { doc: z.string().min(1), quote: z.string().min(3) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ doc, quote }) => json(crawler.verify(doc, quote)),
  );

  return server;
};

/**
 * This function starts the MCP server on the standard input and output. The fetches apply the
 * robots.txt rules for `Claude-User` too, because an assistant asks for these pages.
 */
export const startMcpServer = async (options: OpenOptions): Promise<void> => {
  const crawler = openCrawler({ ...options, onBehalfOf: options.onBehalfOf ?? ["Claude-User"] });
  const server = createMcpServer(crawler);
  const stop = async (): Promise<void> => {
    await server.close();
    await crawler.close();
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
  await server.connect(new StdioServerTransport());
};
