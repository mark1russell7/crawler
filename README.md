# crawler

This repository holds [`polite-crawler`](packages/polite-crawler), a polite web crawler for research and for AI agents, and its site.

`polite-crawler` fetches a source one time, keeps it, and reads it many times. It obeys robots.txt, sends one request at a time to each site, and answers each later question from a local full-text index.

- **The package:** [`packages/polite-crawler`](packages/polite-crawler) is on npm as [`polite-crawler`](https://www.npmjs.com/package/polite-crawler).
- **The site:** [`packages/site`](packages/site) is the documentation, with interactive demos that use the real code: <https://mark1russell7.github.io/crawler/>.

```sh
npx polite-crawler fetch https://en.wikipedia.org/wiki/Web_crawler
npx polite-crawler find "robots exclusion"
claude mcp add polite-crawler -- npx -y polite-crawler mcp
```

## Development

The repository is a pnpm workspace. It needs Node.js 22.13 or later.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm lint:ste
pnpm --filter polite-crawler build
```

The prose of the repository (the README files, the doc comments and the site) follows ASD-STE100 Simplified Technical English. The linter [`ste-lint`](https://github.com/mark1russell7/ste-lint) examines it in CI.

## License

MIT
