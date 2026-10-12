# Security policy

## Supported versions

Only the latest version of `polite-crawler` on npm gets security fixes. Before version 1.0.0, a fix goes into a new patch or minor version, not into older versions.

## Report a vulnerability

Do not open a public issue for a security problem. Use the private vulnerability report of GitHub:

1. Open <https://github.com/mark1russell7/crawler/security/advisories/new>.
2. Give the version of `polite-crawler`, the Node.js version and the operating system.
3. Give the steps, the command or the MCP tool call that shows the problem.

The maintainer examines each report and replies in the advisory. When the fix is on npm, the advisory becomes public and names you, if you agree.

## Scope

These problems are in scope:

- The crawler fetches a URL that robots.txt disallows for its agent, or it continues after a refusal (a challenge, a 402 or a 403).
- `crawl_fetch` or `polite-crawler fetch` reaches an address that the user did not ask for, because a remote party sent it there. An example is a private network address after a redirect.
- A path from outside (a document id, a capture, a URL) makes the crawler read or write a file outside its store.
- The MCP server writes data that is not JSON-RPC to standard output, or a page makes the server stop.
- The crawler keeps or shows a secret (a token in a URL or a header) that it must remove.

These problems are not in scope:

- A site blocks the crawler. The crawler obeys the site.
- Text in a stored page tells an AI agent to do something. The page text is data. The agent and its client decide what to do with it.
- The interactive demos of the site run in your browser only. A problem in a demo is a normal bug.
