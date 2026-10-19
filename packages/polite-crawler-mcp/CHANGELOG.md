# Changelog

This file records the changes to `polite-crawler-mcp` in each version. The changes to the library are in the [changelog of polite-crawler](../../CHANGELOG.md).

`polite-crawler-mcp` uses semantic versioning. Before version 1.0.0, a minor version can break the API, and its section here tells you what to change. A patch version corrects errors or adds features.

## Unreleased

- **The first version.** The MCP server of polite-crawler moves out of the entry point `polite-crawler/mcp` into this package, so the library depends on no MCP SDK and no `zod`. The version starts at 0.2.0, the version of polite-crawler that it goes with, so the MCP registry entry keeps a version above 0.1.4.
  - `npx -y polite-crawler-mcp` starts the server on the standard input and output. It takes the options of `polite-crawler mcp`.
  - The nine tools (`crawl_fetch`, `crawl_find`, `crawl_read`, `crawl_verify`, `crawl_extract`, `crawl_discover`, `crawl_site`, `crawl_diff` and `crawl_watch_list`) keep their names, their parameters, their answers and the envelope of the page text.
  - The tools are procedures on the shared MCP host of `@procedures/mcp-server` (`createMcpHost`). The host gives the stdio and Streamable HTTP faces, the MCP tasks of `crawl_site` and `crawl_discover`, elicitation and progress.
  - A client sees three differences from `polite-crawler mcp` 0.1.4. A GET of `/mcp` without a session gets 404, not 400. A tool error also carries `_meta.code`. The text of an error in the parameters comes from the validator of the procedure, not from the MCP SDK.
  - `createMcpServer` gives a `CrawlMcpServer` with `connect(transport)` and `close()`. Before, it gave an `McpServer` of the MCP SDK.
  - The store of the tasks is `McpTaskStore` of `@procedures/mcp-server`, in place of `CrawlTaskStore`. Its `running()` gives `createdAt` and `updatedAt`.
  - `startMcpHttpServer`, `mcpHttpHost` (the MCP host of the daemon of polite-crawler), `MCP_HTTP_DEFAULTS`, `makeToken`, `sameToken` and `checkToken` keep their behavior.
  - `crawlTools`, `crawlHostOptions` and `crawlContent` put the tools on an MCP host of your own.
