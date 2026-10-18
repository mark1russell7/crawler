# Roadmap

This file is the roadmap of polite-crawler, its site, and the jarvis side that uses it.
The tracker page https://claude.ai/artifact/Tby9J8r39c3fz4ggXoi1QZ shows the same items, with a dependency map and a timeline.
Change this file and the tracker together. Each item has an id, a status, an area, the items it waits for, dates and links.

## Blocked

### `mcp-host`: The MCP server moves onto the shared MCP host

Mark's decision D12 in the server-stack plan (OTH-3): the polite-crawler MCP entry moves onto @procedures/mcp-server, and the library stays a leaf. The MCP entry becomes its own package, so polite-crawler itself depends on no package of Mark's. Moving the export and the npx command is breaking, so it is a minor version (0.2.0), with a deprecation path, a new MCP registry entry and the same MCP features.

- Area: Package
- Waits for: `rel013`
- Blocked: It waits for the client's host factory, stdio under run() and MCP elicitation (CLI-10, CLI-11, CLI-12).
- Owner: markt-02 (the client session), since 2026-10-18
- [Server-stack tracker](https://claude.ai/artifact/QbZd2i5apzg3ip5yiE57Pb)

## Later

### `recheck-watch`: The jarvis hours recheck becomes a watch

jarvis's morning recheck of venue hours runs on the package's watch feature instead of its own loop.

- Area: jarvis
- Waits for: `watch`, `j7`

### `showhn`: Directories and Show HN

List the package in the MCP and tool directories, then post it to Show HN.

- Area: Site and growth
- Waits for: `eval`

### `eval-b`: Eval, part B: real Claude Code runs

Run the same 30 claims through Claude Code with polite-crawler's MCP tools and with WebFetch, and measure the real tokens with Claude's own count. It uses Mark's subscription once, and gives the number to publish on the site.

- Area: Site and growth
- Waits for: `eval`

### `decision-eval`: Idea: a local decision model for link and hours choices

Score a local open-weight decision model (for example Laya) on labelled data from the surveys. Adopt it for a choice only where it beats the current rule, and never for robots.txt or privacy decisions.

- Area: jarvis

## Shipped

### `eval`: Eval, part A: tokens per verified claim in CI

30 of 30 claims on stable public pages verified. The full page as Markdown (the WebFetch way) costs 8.9 times the tokens of polite-crawler in total, and 2.2 times for the median claim, up to 57 times on a long RFC. On a very short page polite-crawler costs more. Each run archives its pages as a WACZ, so the numbers can be recomputed offline, and it runs again on each release.

- Area: Site and growth
- Waits for: `rel011`
- Started: 2026-10-18
- Shipped: 2026-10-18
- [Eval run](https://github.com/mark1russell7/crawler/actions/runs/39085336453)
- [eval/README.md](https://github.com/mark1russell7/crawler/blob/main/packages/polite-crawler/eval/README.md)

### `study-monthly`: The robots.txt study, every month

On main. On the 2nd of each month a CI job runs the study again on the top 1,000 sites (robots.txt only), checks the site, and opens a pull request with the month's data and CI on it. The study page has the runs, a trend chart of six AI agents, an RSS feed, and a CSV and JSON per run. The concept DOI 10.5281/zenodo.23443374 names the study; each month gets a version DOI. The first scheduled run is 2 November 2026.

- Area: Site and growth
- Waits for: `w12`
- Started: 2026-10-18
- Shipped: 2026-10-18
- [Main at 65803c5](https://github.com/mark1russell7/crawler/commit/65803c5)
- [Concept DOI](https://doi.org/10.5281/zenodo.23443374)

### `sdk`: A recipe SDK

Shipped in 0.1.3 on 2026-10-18. defineRecipe and runRecipe let anyone write a recipe: what to fetch and how to read it into documents. Reindex, time travel and the archived fallback work with it. The README has a worked example.

- Area: Package
- Waits for: `recipes-up`
- Started: 2026-10-18
- Shipped: 2026-10-18
- [Release v0.1.3](https://github.com/mark1russell7/crawler/releases/tag/v0.1.3)

### `recipes-up`: Venue-hours and product recipes move into the package

Shipped in 0.1.3 on 2026-10-18. readVenue reads a venue's hours from its own site, each reading with its source and a quote that verify finds. readProduct reads a schema.org Product, its price as money, its variants and availability, and skips related products. Only generic logic moved, with made-up test sites. jarvis switches in its new public code repo, with a migration note ready.

- Area: jarvis
- Waits for: `rel011`
- Started: 2026-10-18
- Shipped: 2026-10-18
- [Release v0.1.3](https://github.com/mark1russell7/crawler/releases/tag/v0.1.3)

### `hybrid`: Hybrid search: full text plus a local vector index

Shipped in 0.1.3 on 2026-10-18. One Embedder interface with two adapters: transformers.js (an optional peer, bge-small by default, a real-model test in CI) and Ollama (nomic-embed-text by default, loopback only unless allowed). rank "hybrid" fuses 50 full-text and 50 vector results (k = 60). Vectors are kept per text and model in vectors.sqlite, and held-back pages are never embedded. A search over 89,000 chunks takes about 0.1 s. Exact full-text ranking stays the default.

- Area: Package
- Waits for: `s30`
- Started: 2026-10-17
- Shipped: 2026-10-18
- [Release v0.1.3](https://github.com/mark1russell7/crawler/releases/tag/v0.1.3)

### `daemon`: A daemon mode, with MCP tasks for long jobs

Shipped in 0.1.3 on 2026-10-18. polite-crawler daemon runs the watch list on a schedule, writes confirmed changes as JSON lines, and can run the operator's command for each change. Opt-in MCP over local HTTP needs a token, binds to loopback, and blocks foreign origins. Long jobs are native MCP tasks with cancel, and clients without tasks get progress.

- Area: Package
- Waits for: `watch`
- Started: 2026-10-18
- Shipped: 2026-10-18
- [Release v0.1.3](https://github.com/mark1russell7/crawler/releases/tag/v0.1.3)

### `rel013`: Release 0.1.3

A patch release, on npm since 2026-10-18: hybrid search, the daemon with MCP tasks, the recipe SDK with the venue and product recipes, and the consent fix. Compat tests prove that 0.1.1 and 0.1.2 code still compiles. The release workflow published it with provenance, put it in the MCP registry and made the tag.

- Area: Release and CI
- Waits for: `hybrid`, `daemon`, `consent-fix`, `recipes-up`, `sdk`
- Started: 2026-10-18
- Shipped: 2026-10-18
- [Pull request #8](https://github.com/mark1russell7/crawler/pull/8)
- [Release v0.1.3](https://github.com/mark1russell7/crawler/releases/tag/v0.1.3)
- [npm 0.1.3](https://www.npmjs.com/package/polite-crawler/v/0.1.3)

### `actions-pr`: Let the monthly study open its pull request

GitHub Actions may open pull requests in the repository since 2026-10-18, so the monthly study opens its own pull request. The first one comes on 2 November 2026.

- Area: Release and CI
- Waits for: `study-monthly`
- Shipped: 2026-10-18
- [Actions settings](https://github.com/mark1russell7/crawler/settings/actions)

### `consent-fix`: A failed consent question keeps a page held back

When the MCP client can ask the user before releasing a held-back page, but the question times out or fails, the page now stays held back. The operator's opt-in applies only to a client that cannot ask. This is the rule of the shared MCP host too, so the later move keeps it. Shipped in 0.1.3.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-18
- Shipped: 2026-10-18
- [Commit 38caa18](https://github.com/mark1russell7/crawler/commit/38caa18)
- [Release v0.1.3](https://github.com/mark1russell7/crawler/releases/tag/v0.1.3)

### `timetravel`: Read a page as it was on a date

On main since 2026-10-17, in 0.1.2. read, verify and extract take `at` and use the version that was current then. Search at a past time is left out, because the index keeps one current text per page.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Main at 52b5bd5](https://github.com/mark1russell7/crawler/commit/52b5bd5)

### `extraction`: Verified structured extraction

On main since 2026-10-17, in 0.1.2. extract checks the field values a caller proposes against the stored capture: verified, normalized (with the named rule), ambiguous (both readings, never a guess), not found or invalid. It never invents a value.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Main at 52b5bd5](https://github.com/mark1russell7/crawler/commit/52b5bd5)

### `conformance`: A conformance page for the standards

The site's Standards page shows, rule by rule, how the crawler follows RFC 9309, RFC 9111, RFC 9110 and the AI preference signals. Each rule links to its test, and a test keeps the page and the tests in step. 172 of Google's 201 robots.txt cases agree, and 12 differ on purpose, each with its reason.

- Area: Site and growth
- Waits for: `rel011`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Standards page](https://mark1russell7.github.io/crawler/reference/standards/)

### `botauth`: Signed requests (Web Bot Auth)

On main since 2026-10-17, in 0.1.2. Ed25519 HTTP message signatures (RFC 9421, Web Bot Auth draft 00), matched against the test vectors. A signature only adds headers. A key-directory command prints the keys to host.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Main at 52b5bd5](https://github.com/mark1russell7/crawler/commit/52b5bd5)

### `warc`: Export the store as WARC or WACZ

On main since 2026-10-17, in the next release. WARC/1.1 and WACZ 1.1.1 export, checked by warcio and wacz validate in CI, with no new dependency.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Main at 3c3a800](https://github.com/mark1russell7/crawler/commit/3c3a800)

### `watch`: Watch pages for changes, with diffs

On main since 2026-10-17, in 0.1.2. A watch list kept in its own watch.sqlite, a check at most each hour by default, and a change confirmed only when the next check sees it too. Line and word diffs, and structured-data diffs.

- Area: Package
- Waits for: `sitemaps`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Main at 52b5bd5](https://github.com/mark1russell7/crawler/commit/52b5bd5)

### `fallback`: An archived copy after a refusal

On main since 2026-10-17, in 0.1.2. Opt-in archived copies from the Wayback Machine or Common Crawl after a refusal, labelled archived with their date everywhere. By default never for a page that the site's current robots.txt disallows.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Main at 52b5bd5](https://github.com/mark1russell7/crawler/commit/52b5bd5)

### `frontier`: A small crawl frontier with a budget

On main since 2026-10-17, in the next release. crawler.crawl follows a site's links within page, depth and time budgets, one request per host at a time, with a summary of why it stopped.

- Area: Package
- Waits for: `sitemaps`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Main at 3c3a800](https://github.com/mark1russell7/crawler/commit/3c3a800)

### `sitemaps`: Find pages from sitemaps and feeds

On main since 2026-10-17, in the next release. crawler.discover finds a site's pages from its sitemaps and feeds, robots.txt first, with a strict sitemap reader that stays bounded on hostile files.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Main at 3c3a800](https://github.com/mark1russell7/crawler/commit/3c3a800)

### `tag-rule`: Let CI create release tags

With Mark's direct OK, the release tags ruleset now blocks only changing and deleting v* tags. Creating one is open to accounts with write access: Mark and the workflow token. From the next release on, the workflow makes v<version> itself. markt-54 also added SemVer checks: a version must be greater than npm's latest, a prerelease goes to the next tag, and no version is reused.

- Area: Release and CI
- Waits for: `rel011`
- Owner: Session markt-54
- Shipped: 2026-10-17
- [Rulesets](https://github.com/mark1russell7/crawler/settings/rules)

### `rel012`: Release 0.1.2

polite-crawler 0.1.2 is on npm, published by CI with provenance: discovery and the site crawl, WARC export, watch and diff, reading at a time, the archived fallback, signed requests and verified extraction. It only adds to the API, and compat.test.ts proves that 0.1.1 code still compiles.

- Area: Release and CI
- Waits for: `sitemaps`, `frontier`, `warc`, `watch`, `timetravel`, `fallback`, `botauth`, `extraction`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [npm package](https://www.npmjs.com/package/polite-crawler)
- [GitHub release v0.1.2](https://github.com/mark1russell7/crawler/releases/tag/v0.1.2)
- [Pull request #6](https://github.com/mark1russell7/crawler/pull/6)

### `w12`: A DOI for the study, and a press contact (W-12)

The robots.txt study is a citable CC BY 4.0 dataset on Zenodo with the DOI 10.5281/zenodo.23443375. The study page cites it with BibTeX, and shows the press contact.

- Area: Site and growth
- Started: 2026-10-17
- Shipped: 2026-10-17
- [DOI 10.5281/zenodo.23443375](https://doi.org/10.5281/zenodo.23443375)
- [The study](https://mark1russell7.github.io/crawler/)

### `j7swap`: jarvis uses the @procedures 0.7.0 helpers

jarvis deleted its local stream code and uses writeNdjsonStream, the stream marker and asSettled from @procedures 0.7.0. The client's wait for a first row is now the procedure's budget plus 60 seconds.

- Area: jarvis
- Waits for: `j7`, `client070`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [jarvis pull request #39](https://github.com/mark1russell7/jarvis/pull/39)
- [Merge commit bf82aa8](https://github.com/mark1russell7/jarvis/commit/bf82aa8)

### `client070`: Stream helpers in @procedures 0.7.0

The NDJSON writer, the keep-alive and the 'as they finish' helper moved into the shared client packages in @procedures 0.7.0, where the extraction law puts them. jarvis pull request #39 replaced its stand-ins with writeNdjsonStream and asSettled.

- Area: jarvis
- Owner: The client-repo sessions
- Shipped: 2026-10-17
- [jarvis #39](https://github.com/mark1russell7/jarvis/pull/39)

### `j7`: Stream long jarvis calls (J-7)

place.check, the morning recheck and crawl.fetch send each result as it is ready, so a long call no longer fails at the 5-minute client limit.

- Area: jarvis
- Waits for: `jarvis-move`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [jarvis pull request #34](https://github.com/mark1russell7/jarvis/pull/34)
- [Merge commit b2a6d0d](https://github.com/mark1russell7/jarvis/commit/b2a6d0d)

### `rel011`: Release 0.1.1

polite-crawler 0.1.1 is on npm, published by CI with provenance, with the cache check memo and the ranking option. The trust now matches the standard release workflow, and the package disallows tokens.

- Area: Release and CI
- Waits for: `a13`, `s30`, `stdrelease`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [npm package](https://www.npmjs.com/package/polite-crawler)
- [GitHub release v0.1.1](https://github.com/mark1russell7/crawler/releases/tag/v0.1.1)

### `s30`: Ranking options, full quality by default (S-30)

Exact ranking stays the default. The opt-in rank 'fast' is 2.45x faster on long questions. It keeps 85% of the exact top 10 on a realistic corpus, and 43% where nearly every word is in every page. A CI benchmark can measure it again at any time.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Commit 46fc00c](https://github.com/mark1russell7/crawler/commit/46fc00c)
- [Benchmark run](https://github.com/mark1russell7/crawler/actions/runs/39057146797)

### `a13`: Learn which cache check works on each site (A-13)

Some sites change their ETag on each request, so the server ignores the date check and sends the whole page again. After 3 such misses the crawler sends only the date check to that site, and tries the ETag again every 20 requests or 7 days. The memo lives in hosts.sqlite, so processes share it.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Commit 65b06df](https://github.com/mark1russell7/crawler/commit/65b06df)
- [CI run](https://github.com/mark1russell7/crawler/actions/runs/39057736301)

### `stdrelease`: Standard npm release from the template

A release now starts when a version change merges to main, after your approval. CI publishes with provenance.

- Area: Release and CI
- Waits for: `registry`
- Owner: Session markt-54
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Pull request #2](https://github.com/mark1russell7/crawler/pull/2)

### `jarvis-move`: jarvis runs on polite-crawler

jarvis deleted its own copy of the engine and installs polite-crawler 0.1.0 from npm. Its 30 review findings were fixed in the same move.

- Area: jarvis
- Waits for: `pub010`
- Started: 2026-10-12
- Shipped: 2026-10-13
- [jarvis commit 617937c](https://github.com/mark1russell7/jarvis/commit/617937c)

### `registry`: MCP registry entry and GitHub release

The release workflow listed polite-crawler in the MCP registry and made the GitHub release.

- Area: Release and CI
- Waits for: `settings`
- Started: 2026-10-13
- Shipped: 2026-10-13
- [GitHub release v0.1.0](https://github.com/mark1russell7/crawler/releases/tag/v0.1.0)

### `settings`: Repository security and release rules

Security alerts and CodeQL, actions pinned to a commit, rulesets for main and for release tags, and npm publishing only from CI.

- Area: Release and CI
- Waits for: `pub010`
- Owner: Mark
- Started: 2026-10-13
- Shipped: 2026-10-13
- [Rulesets](https://github.com/mark1russell7/crawler/settings/rules)

### `pub010`: polite-crawler 0.1.0 on npm

The first release, byte for byte the tarball that the tests passed.

- Area: Release and CI
- Waits for: `accept`
- Started: 2026-10-13
- Shipped: 2026-10-13
- [npm package](https://www.npmjs.com/package/polite-crawler)
- [GitHub release v0.1.0](https://github.com/mark1russell7/crawler/releases/tag/v0.1.0)

### `accept`: Acceptance pass: 244 of 250 fixed

Three reviewers re-ran every reproduction against the result. A fourth pass fixed what they found, plus six bugs that moving jarvis onto the package turned up.

- Area: Package
- Waits for: `wave2`
- Started: 2026-10-12
- Shipped: 2026-10-13
- [Commit 1e829de](https://github.com/mark1russell7/crawler/commit/1e829de)

### `wave2`: Fixes: versioned store, safe reindex, MCP and CLI

Search sees the current text of a page, a rebuild never wipes the index, processes share pacing, held-back pages stay private, and MCP page text is marked untrusted.

- Area: Package
- Waits for: `wave1`
- Started: 2026-10-12
- Shipped: 2026-10-12
- [Commit 4e7abd8](https://github.com/mark1russell7/crawler/commit/4e7abd8)

### `wave1`: Fixes: fetch, readers, CI and site

The network-exposure guard, robots.txt that fails closed, linear-time parsing, charset decoding, a test matrix on three Node versions and three systems, and the site fixes.

- Area: Package
- Waits for: `review`
- Started: 2026-10-12
- Shipped: 2026-10-12
- [Commit 4e08422](https://github.com/mark1russell7/crawler/commit/4e08422)

### `review`: Deep review: 250 findings

Eight reviewers read the crawler, the site and the jarvis side line by line and reported 250 findings, 134 of them reproduced by a script.

- Area: Package
- Started: 2026-10-12
- Shipped: 2026-10-12
- [The review, with each finding's outcome](https://claude.ai/artifact/98FDfTTVFAusA21ZoDkPoM)

## Never

Proxies, session rotation or stealth. They contradict the honest identity of the crawler, and courts treat them as circumvention.
