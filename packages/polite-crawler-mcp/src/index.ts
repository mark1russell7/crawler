/*
 * polite-crawler-mcp is the MCP server of polite-crawler. Its nine tools are procedures on the
 * shared MCP host (`createMcpHost` of `@procedures/mcp-server`). It exports these parts:
 *
 * - `createMcpServer`: the nine tools over one crawler, for a transport of the MCP SDK.
 * - `startMcpServer`: the server on the standard input and output, as `npx polite-crawler-mcp`
 *   starts it.
 * - `startMcpHttpServer` and `mcpHttpHost`: the tools over Streamable HTTP, with the bearer token,
 *   the tasks and the status route of the daemon of polite-crawler.
 * - `crawlTools`, `crawlHostOptions` and `crawlContent`: the procedures, the options of the host
 *   and the content hook, to put the tools on an MCP host of your own.
 */
export type { CrawlMcpServer, CrawlServerOptions, StartMcpOptions } from "./server.ts";
export { crawlHostOptions, createMcpServer, startMcpServer } from "./server.ts";
export type { CrawlToolOptions } from "./tools.ts";
export { INSTRUCTIONS, crawlContent, crawlTools } from "./tools.ts";
export type { McpHttpOptions, McpHttpServer, StartMcpHttpOptions } from "./http.ts";
export {
  MCP_HTTP_DEFAULTS,
  checkToken,
  makeToken,
  mcpHttpHost,
  sameToken,
  serveMcpHttp,
  startMcpHttpServer,
} from "./http.ts";
export { McpTaskStore } from "@procedures/mcp-server";
export type { McpTaskInfo, McpTaskStoreOptions } from "@procedures/mcp-server";
export { SERVER_NAME, VERSION } from "./version.ts";
