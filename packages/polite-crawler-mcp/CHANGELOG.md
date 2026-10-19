# Changelog

This file records the changes to `polite-crawler-mcp` in each version. The changes to the library are in the [changelog of polite-crawler](../../CHANGELOG.md).

`polite-crawler-mcp` uses semantic versioning. Before version 1.0.0, a minor version can break the API, and its section here tells you what to change. A patch version corrects errors or adds features.

## Unreleased

## 0.2.1 - 2026-10-19

- **The tiers of the API.** The package has a report of its API that CI compares (`api/index.api.md`). `crawlHostOptions`, `crawlTools`, `crawlContent`, `serveMcpHttp` and `INSTRUCTIONS` have the tag `@beta`: a minor version can change them. The server, its options and the rules of the token are stable. [`docs/API-REVIEW.md`](https://github.com/mark1russell7/crawler/blob/main/docs/API-REVIEW.md) gives the reasons.
- **The loopback Host rule also on a remote bind.** With `allowRemote`, the HTTP server accepted any `Host` header. A request that comes to a loopback address (127.0.0.1 or ::1) needs a loopback name in `Host`, also when the server listens on other addresses too. Thus a web page cannot reach the server through 127.0.0.1 by DNS rebinding. A request to another address of the server does not change.

## 0.2.0 - 2026-10-19

- **The first version.** The MCP server of polite-crawler moves out of the entry point `polite-crawler/mcp` into this package, so the library depends on no MCP SDK and no `zod`. The version starts at 0.2.0, the version of polite-crawler that it goes with, so the MCP registry entry keeps a version above 0.1.4.
  - `npx -y polite-crawler-mcp` starts the server on the standard input and output. It takes the options of `polite-crawler mcp`.
  - The nine tools (`crawl_fetch`, `crawl_find`, `crawl_read`, `crawl_verify`, `crawl_extract`, `crawl_discover`, `crawl_site`, `crawl_diff` and `crawl_watch_list`) keep their names, their parameters, their answers and the envelope of the page text.
  - The tools are procedures on the shared MCP host of `@procedures/mcp-server` (`createMcpHost`). The host gives the stdio and Streamable HTTP faces, the MCP tasks of `crawl_site` and `crawl_discover`, elicitation and progress.
  - A client sees these differences from `polite-crawler mcp` 0.1.4. A GET of `/mcp` without a session gets 404, not 400. A tool error also carries `_meta.code`. The text of an error in the parameters comes from the validator of the procedure, not from the MCP SDK.
  - Over HTTP, the refusals of the endpoint itself (no session, the session limit, a body that is too large) carry the JSON-RPC code -32001 with `data.code`, not -32000. The listener of the package checks the token, the host and the origin as in 0.1.4. The face of the host does not check the host or the token again.
  - The HTTP server keeps at most 32 sessions, as before. Before, a new session above the limit closed the session that was idle longest. In 0.2.0, a session with an open stream or a call in progress is not idle. When each of the 32 sessions is busy, the new session gets 503 with `Retry-After`.
  - `createMcpServer` gives a `CrawlMcpServer` with `connect(transport)` and `close()`. Before, it gave an `McpServer` of the MCP SDK.
  - The store of the tasks is `McpTaskStore` of `@procedures/mcp-server`, in place of `CrawlTaskStore`. Its `running()` gives `createdAt` and `updatedAt`.
  - `startMcpHttpServer`, `mcpHttpHost` (the MCP host of the daemon of polite-crawler), `MCP_HTTP_DEFAULTS`, `makeToken`, `sameToken` and `checkToken` keep their behavior.
  - `crawlTools`, `crawlHostOptions` and `crawlContent` put the tools on an MCP host of your own.
