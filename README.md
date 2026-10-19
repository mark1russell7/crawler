# crawler

[![npm](https://img.shields.io/npm/v/polite-crawler)](https://www.npmjs.com/package/polite-crawler)
[![CI](https://github.com/mark1russell7/crawler/actions/workflows/ci.yml/badge.svg)](https://github.com/mark1russell7/crawler/actions/workflows/ci.yml)
[![Pages](https://github.com/mark1russell7/crawler/actions/workflows/pages.yml/badge.svg)](https://mark1russell7.github.io/crawler/)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

This repository holds [`polite-crawler`](packages/polite-crawler), a polite web crawler for research and for AI agents, and its site.

`polite-crawler` fetches a source one time, keeps it, and reads it many times. It obeys robots.txt, sends one request at a time to each site, and answers each later question from a local full-text index.

- **The package:** [`packages/polite-crawler`](packages/polite-crawler) is on npm as [`polite-crawler`](https://www.npmjs.com/package/polite-crawler).
- **The site:** [`packages/site`](packages/site) is the documentation: <https://mark1russell7.github.io/crawler/>. Its interactive figures and tools start the real code: hybrid search, the recipes, the daemon and the robots.txt tester.
- **The study:** [Who lets AI agents in?](https://mark1russell7.github.io/crawler/notes/robots-txt-ai-agents/) The crawler read the robots.txt files of the top 1,000 domains. The page shows the verdict for 15 agents, with the rule that decided it.

```sh
npx polite-crawler fetch https://en.wikipedia.org/wiki/Web_crawler
npx polite-crawler find "robots exclusion"
claude mcp add polite-crawler -- npx -y polite-crawler-mcp
```

What the crawler does for you and for the sites:

- It stops a host after a challenge, a 401, a 402 or a 403, for 1 to 24 hours. It does not try a different identity.
- By default, it fetches only public addresses. `--allow-private` permits loopback and private addresses.
- The MCP server gives page text in an `<untrusted-web-content>` envelope, so an assistant can tell data from instructions. A page that refuses AI input stays held back until a person confirms.
- The library is `polite-crawler`, and the MCP server is the package `polite-crawler-mcp` ([its README](packages/polite-crawler-mcp/README.md)).

The [package README](packages/polite-crawler/README.md) tells the details.

## Development

The repository is a pnpm workspace. It needs Node.js 22.19 or later and pnpm 10 or later.

```sh
pnpm install
pnpm browser   # the headless shell for the renderer test
pnpm check     # typecheck, lint, test, lint:ste, build and the smoke test of the package
```

The prose of the repository (the README files, the doc comments and the site) follows ASD-STE100 Simplified Technical English. The linter [`ste-lint`](https://github.com/mark1russell7/ste-lint) examines it in CI.

- [`CONTRIBUTING.md`](CONTRIBUTING.md) tells how to set up, test and write a change.
- [`SECURITY.md`](SECURITY.md) tells how to report a vulnerability privately.
- [`CHANGELOG.md`](CHANGELOG.md) records the changes in each version.

## License

MIT
