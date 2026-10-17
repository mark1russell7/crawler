# Roadmap

This file is the roadmap of polite-crawler, its site, and the jarvis side that uses it.
The tracker page https://claude.ai/artifact/Tby9J8r39c3fz4ggXoi1QZ shows the same items, with a dependency map and a timeline.
Change this file and the tracker together. Each item has an id, a status, an area, the items it waits for, dates and links.

## Waiting on Mark

### `rel011`: Release 0.1.1

Pull request #3 is merged. CI publishes 0.1.1 when the trust step is done. New features stay on branches until then, so 0.1.1 ships only what its changelog lists.

- Area: Release and CI
- Waits for: `a13`, `s30`, `stdrelease`
- What Mark does: At 20:16 UTC today or later, run the npm trust step with the session markt-54. It needs your security key.
- Started: 2026-10-17
- [Pull request #3](https://github.com/mark1russell7/crawler/pull/3)

## In progress

### `w12`: A DOI for the study, and a press contact (W-12)

Mark said yes. The study is packaged as a CC BY 4.0 dataset, and a workflow creates a Zenodo draft with a reserved DOI for Mark to publish. The study page shows the DOI, a citation and the press contact.

- Area: Site and growth
- Started: 2026-10-17
- [The study](https://mark1russell7.github.io/crawler/)

### `sitemaps`: Find pages from sitemaps and feeds

Discover a site's pages from its sitemap and feeds, with robots.txt checked before any fetch.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17

### `frontier`: A small crawl frontier with a budget

Follow links within a site up to a page and time budget, still one polite request at a time per host.

- Area: Package
- Waits for: `sitemaps`
- Started: 2026-10-17

### `warc`: Export the store as WARC or WACZ

Give the stored captures to archive tools in the standard web archive formats.

- Area: Package
- Waits for: `pub010`
- Started: 2026-10-17

### `conformance`: A conformance page for the standards

Show on the site, test by test, how the crawler follows RFC 9309 (robots.txt), RFC 9111 (caching) and the AI preference signals.

- Area: Site and growth
- Waits for: `rel011`
- Started: 2026-10-17

## Blocked

### `client070`: Stream helpers in @procedures 0.7.0

The NDJSON writer, the keep-alive and the 'as they finish' helper move into the shared client packages, where the extraction law puts them.

- Area: jarvis
- Blocked: The client repository is frozen for its 0.6.0 release. These changes land after it, as 0.7.0.
- Owner: The client-repo sessions

### `j7swap`: jarvis uses the @procedures 0.7.0 helpers

jarvis deletes its local stream code (marked TODO(npm)) and imports the released helpers.

- Area: jarvis
- Waits for: `j7`, `client070`
- Blocked: It waits for @procedures 0.7.0 on npm.

## Later

### `fallback`: An archived copy after a refusal

When a site refuses, offer a Common Crawl or Wayback copy, clearly labelled as archived, never as a fresh fetch.

- Area: Package
- Waits for: `rel011`

### `watch`: Watch pages for changes, with diffs

Re-read pages on a schedule, keep each version, and report what changed.

- Area: Package
- Waits for: `rel011`

### `recheck-watch`: The jarvis hours recheck becomes a watch

jarvis's morning recheck of venue hours runs on the package's watch feature instead of its own loop.

- Area: jarvis
- Waits for: `watch`, `j7`

### `botauth`: Signed requests (Web Bot Auth)

A hook to sign requests, so a site can verify that a request really comes from this crawler.

- Area: Package
- Waits for: `rel011`

### `daemon`: A daemon mode, with MCP tasks for long jobs

Run as a background service, so long crawls and watches run as MCP tasks that a client can check on.

- Area: Package
- Waits for: `watch`

### `extraction`: Verified structured extraction

Extract fields from a page only when each field can be found in the stored capture, so every value has its proof.

- Area: Package
- Waits for: `rel011`

### `hybrid`: Hybrid search: full text plus a local vector index

Add meaning-based search next to full-text search, run locally, to raise ranking quality further.

- Area: Package
- Waits for: `s30`

### `recipes-up`: Venue-hours and product recipes move into the package

The jarvis recipes that know nothing about Mark move into polite-crawler, so others can use them.

- Area: jarvis
- Waits for: `rel011`

### `sdk`: A recipe SDK

A documented way for anyone to write a recipe: what to fetch, how to read it, and what to keep.

- Area: Package
- Waits for: `recipes-up`

### `timetravel`: Read a page as it was on a date

read(doc, {at}) returns the version that was current at a given time.

- Area: Package
- Waits for: `rel011`

### `study-monthly`: The robots.txt study, every month

Re-run the study monthly and publish it with an RSS feed and a CSV.

- Area: Site and growth
- Waits for: `w12`

### `eval`: Published eval: tokens per verified claim

Measure and publish how many tokens a verified claim costs with polite-crawler against WebFetch.

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

### `j7`: Stream long jarvis calls (J-7)

place.check, the morning recheck and crawl.fetch send each result as it is ready, so a long call no longer fails at the 5-minute client limit.

- Area: jarvis
- Waits for: `jarvis-move`
- Started: 2026-10-17
- Shipped: 2026-10-17
- [jarvis pull request #34](https://github.com/mark1russell7/jarvis/pull/34)
- [Merge commit b2a6d0d](https://github.com/mark1russell7/jarvis/commit/b2a6d0d)

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
