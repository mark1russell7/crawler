# Roadmap

This file is the roadmap of polite-crawler, its site, and the jarvis side that uses it.
The tracker page https://claude.ai/artifact/Tby9J8r39c3fz4ggXoi1QZ shows the same items, with a dependency map and a timeline.
Change this file and the tracker together. Each item has an id, a status, an area, the items it waits for, dates and links.

## Waiting on Mark

### `w12`: A DOI for the study, and a press contact (W-12)

On main: the dataset, the citation block and the press contact. Zenodo blocks GitHub's runners as a network, so the draft is made from Mark's machine. Then Mark clicks Publish, and the DOI goes on the site.

- Area: Site and growth
- What Mark does: In your own Git Bash: cd ~/git/crawler, git pull, pnpm install --frozen-lockfile, then pnpm exec tsx packages/site/scripts/study-dataset.ts study-dataset, then read -rsp "Zenodo token: " ZENODO_TOKEN, then ZENODO_TOKEN="$ZENODO_TOKEN" ZENODO_PUBLISH=false pnpm exec tsx packages/site/scripts/study-zenodo.ts study-dataset deposition.json. Open the draft URL it prints and click Publish.
- Started: 2026-10-17
- [Branch feat/doi](https://github.com/mark1russell7/crawler/tree/feat/doi)
- [Zenodo](https://zenodo.org)

## In progress

### `rel012`: Release 0.1.2

A patch release that only adds to the API: discovery and the site crawl, WARC export, watch and diff, reading at a time, the archived fallback, signed requests and verified extraction. All of it is on main at 52b5bd5, with CI green, and compat.test.ts proves that 0.1.1 code still compiles. markt-54 merges pull request #6, and CI publishes.

- Area: Release and CI
- Waits for: `sitemaps`, `frontier`, `warc`, `watch`, `timetravel`, `fallback`, `botauth`, `extraction`
- Started: 2026-10-17
- [Pull request #6](https://github.com/mark1russell7/crawler/pull/6)

### `tag-rule`: Let CI create release tags

Mark said yes. markt-54 changes the ruleset so the release workflow makes its own v* tag, and checks that the workflow follows SemVer: no reused or lower versions, and prereleases to the next tag.

- Area: Release and CI
- Waits for: `rel011`
- Owner: Session markt-54
- [Rulesets](https://github.com/mark1russell7/crawler/settings/rules)

### `sitemaps`: Find pages from sitemaps and feeds

On main since 2026-10-17, in the next release. crawler.discover finds a site's pages from its sitemaps and feeds, robots.txt first, with a strict sitemap reader that stays bounded on hostile files.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- [Main at 3c3a800](https://github.com/mark1russell7/crawler/commit/3c3a800)

### `frontier`: A small crawl frontier with a budget

On main since 2026-10-17, in the next release. crawler.crawl follows a site's links within page, depth and time budgets, one request per host at a time, with a summary of why it stopped.

- Area: Package
- Waits for: `sitemaps`
- Started: 2026-10-17
- [Main at 3c3a800](https://github.com/mark1russell7/crawler/commit/3c3a800)

### `fallback`: An archived copy after a refusal

On main since 2026-10-17, in 0.1.2. Opt-in archived copies from the Wayback Machine or Common Crawl after a refusal, labelled archived with their date everywhere. By default never for a page that the site's current robots.txt disallows.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- [Main at 52b5bd5](https://github.com/mark1russell7/crawler/commit/52b5bd5)

### `watch`: Watch pages for changes, with diffs

On main since 2026-10-17, in 0.1.2. A watch list kept in its own watch.sqlite, a check at most each hour by default, and a change confirmed only when the next check sees it too. Line and word diffs, and structured-data diffs.

- Area: Package
- Waits for: `sitemaps`
- Started: 2026-10-17
- [Main at 52b5bd5](https://github.com/mark1russell7/crawler/commit/52b5bd5)

### `warc`: Export the store as WARC or WACZ

On main since 2026-10-17, in the next release. WARC/1.1 and WACZ 1.1.1 export, checked by warcio and wacz validate in CI, with no new dependency.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- [Main at 3c3a800](https://github.com/mark1russell7/crawler/commit/3c3a800)

### `botauth`: Signed requests (Web Bot Auth)

On main since 2026-10-17, in 0.1.2. Ed25519 HTTP message signatures (RFC 9421, Web Bot Auth draft 00), matched against the test vectors. A signature only adds headers. A key-directory command prints the keys to host.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- [Main at 52b5bd5](https://github.com/mark1russell7/crawler/commit/52b5bd5)

### `extraction`: Verified structured extraction

On main since 2026-10-17, in 0.1.2. extract checks the field values a caller proposes against the stored capture: verified, normalized (with the named rule), ambiguous (both readings, never a guess), not found or invalid. It never invents a value.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- [Main at 52b5bd5](https://github.com/mark1russell7/crawler/commit/52b5bd5)

### `hybrid`: Hybrid search: full text plus a local vector index

Mark chose both: transformers.js as an optional peer (A) and Ollama over its local API (B), behind one pluggable Embedder interface. Opt-in rank "hybrid" fuses full-text and vector results. Exact full-text ranking stays the default.

- Area: Package
- Waits for: `s30`
- Started: 2026-10-17

### `timetravel`: Read a page as it was on a date

On main since 2026-10-17, in 0.1.2. read, verify and extract take `at` and use the version that was current then. Search at a past time is left out, because the index keeps one current text per page.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17
- [Main at 52b5bd5](https://github.com/mark1russell7/crawler/commit/52b5bd5)

## Blocked

### `client070`: Stream helpers in @procedures 0.7.0

The NDJSON writer, the keep-alive and the 'as they finish' helper move into the shared client packages, where the extraction law puts them.

- Area: jarvis
- Blocked: The client repository is frozen for its 0.6.0 release. These changes land after it, as 0.7.0.
- Owner: The client-repo sessions

## Later

### `recheck-watch`: The jarvis hours recheck becomes a watch

jarvis's morning recheck of venue hours runs on the package's watch feature instead of its own loop.

- Area: jarvis
- Waits for: `watch`, `j7`

### `daemon`: A daemon mode, with MCP tasks for long jobs

Run as a background service, so long crawls and watches run as MCP tasks that a client can check on.

- Area: Package
- Waits for: `watch`

### `recipes-up`: Venue-hours and product recipes move into the package

The jarvis recipes that know nothing about Mark move into polite-crawler, so others can use them.

- Area: jarvis
- Waits for: `rel011`

### `sdk`: A recipe SDK

A documented way for anyone to write a recipe: what to fetch, how to read it, and what to keep.

- Area: Package
- Waits for: `recipes-up`

### `study-monthly`: The robots.txt study, every month

Re-run the study monthly and publish it with an RSS feed and a CSV.

- Area: Site and growth
- Waits for: `w12`

### `eval`: Published eval: tokens per verified claim

Mark chose C: a reproducible count in CI for every release (A), and real Claude Code runs once for the published number (B). A is next after hybrid search.

- Area: Site and growth
- Waits for: `rel011`

### `showhn`: Directories and Show HN

List the package in the MCP and tool directories, then post it to Show HN.

- Area: Site and growth
- Waits for: `eval`

### `decision-eval`: Idea: a local decision model for link and hours choices

Score a local open-weight decision model (for example Laya) on labelled data from the surveys. Adopt it for a choice only where it beats the current rule, and never for robots.txt or privacy decisions.

- Area: jarvis

## Shipped

### `conformance`: A conformance page for the standards

The site's Standards page shows, rule by rule, how the crawler follows RFC 9309, RFC 9111, RFC 9110 and the AI preference signals. Each rule links to its test, and a test keeps the page and the tests in step. 172 of Google's 201 robots.txt cases agree, and 12 differ on purpose, each with its reason.

- Area: Site and growth
- Waits for: `rel011`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [Standards page](https://mark1russell7.github.io/crawler/reference/standards/)

### `j7swap`: jarvis uses the @procedures 0.7.0 helpers

jarvis deleted its local stream code and uses writeNdjsonStream, the stream marker and asSettled from @procedures 0.7.0. The client's wait for a first row is now the procedure's budget plus 60 seconds.

- Area: jarvis
- Waits for: `j7`, `client070`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [jarvis pull request #39](https://github.com/mark1russell7/jarvis/pull/39)
- [Merge commit bf82aa8](https://github.com/mark1russell7/jarvis/commit/bf82aa8)

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
- [The review, with each finding's outcome](https://claude.ai/artifact/7SHEaVHYqLwMxmvGhzzL9G)

## Never

Proxies, session rotation or stealth. They contradict the honest identity of the crawler, and courts treat them as circumvention.
