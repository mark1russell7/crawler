# The eval: tokens per verified claim

This folder holds the two parts of the eval of polite-crawler. Part A is a count in CI, with no model. It counts the text that an agent reads to verify a claim with polite-crawler, and the text of the WebFetch way. Part B starts real sessions of Claude Code in CI. It measures the tokens and the cost with the count of the API.

The eval asks one question. To prove an answer with an exact quote from a page, how many tokens does an agent read?

## The question set

`claims.json` has 30 claims. Each claim has these fields:

| Field | What it holds |
| --- | --- |
| `id` | A short name, in lowercase with hyphens |
| `source` | The kind of source: `rfc`, `wikipedia`, `mdn`, `node`, `python`, `government` or `w3c` |
| `url` | The page |
| `question` | A short question that an agent asks. The eval gives it to `crawl_find` as it is. |
| `quote` | The exact words of the page that prove the answer |

The claims come from 28 pages:

- 11 claims on 9 RFCs at `www.rfc-editor.org`, from RFC 1149 (short) to RFC 9110 (long)
- 4 Wikipedia articles, 3 MDN pages, 3 pages of the Node.js documentation and 4 pages of the Python documentation
- 4 government pages (`archives.gov` and `legislation.gov.uk`) and 1 W3C recommendation

The rules for a claim:

- Use a page with stable text and a robots.txt that lets the crawler in.
- Give the final URL of the page, with no redirect.
- Use a short quote from one paragraph. A footnote mark or a page break in the quote stops the match.
- Use one fact for each claim. Two claims on one page are correct: an agent reads one page for many facts.

The quotes come from the memory of the author, not from a fetch on a shared computer. The first eval in CI checks each quote. A quote that is not on the page gets a row in the table of claims that are not verified.

## The method

1. **The fetch.** Online mode fetches each URL one time into a new store, with the default identity of the crawler. The `User-Agent` is `PoliteCrawler/<version> (+https://mark1russell7.github.io/crawler/bot/)`, with no contact. The crawler obeys robots.txt for `PoliteCrawler` and `Claude-User`, and the pace of each site. It opens no browser.
2. **The archive.** The run exports the store as a WACZ file with `exportWacz`, with the refusals and the redirects (`includeRefusals`).
3. **The replay.** The measurement reads the WACZ file into a new store. A mock agent answers each request from the archive, and it refuses each other request. Thus the measurement uses no network.
4. **The polite-crawler path.** The measurement starts the MCP server of the package in memory. For each claim, it uses the tools in the sequence of an agent:
   - `crawl_fetch` with the URL. The store answers, with no request.
   - `crawl_find` with the question. This search gives 10 results or fewer.
   - `crawl_read` with a window of 2,000 characters around the quote. The library `verify` gives the position of the quote. This check is not counted.
   - `crawl_verify` with the quote.
5. **The count.** The count of the polite-crawler path is all the text of the `content` blocks of the four results. Each result has a block of JSON and a block of web text in an `<untrusted-web-content>` envelope. The `structuredContent` of a result holds the same data, so the count leaves it out.
6. **The WebFetch proxy.** The proxy is the whole page as Markdown: the HTML of the archive, converted by `turndown` with its default options. The conversion first removes the `script`, `style`, `noscript` and `template` elements.
7. **The text proxy.** A second proxy is the visible text of the page, as the reader of polite-crawler extracts it (`extractPage`), with no cut.

The Claude Code WebFetch tool converts the page to Markdown and gives it to a small model with the prompt. The main model gets the answer of that model, not the page. That answer is not an exact quote that the main model can check. To check a quote, a model reads the text of the page. The proxy counts that text. The real conversion of WebFetch can be different from `turndown`, and the proxy does not apply its limits.

### The units

- **Characters.** The count of Unicode code points.
- **Tokens.** The count of the `cl100k_base` encoding, from the package `gpt-tokenizer`. This count is a proxy. It is not the tokenizer of Claude, and Claude gives different counts. The two paths use the same tokenizer, so a ratio depends less on the tokenizer than a count.

### The checks

- A claim is verified when `crawl_verify` gives `found: true`.
- The statistics (the medians, the totals and the ratios) use only the verified claims.
- Each claim that is not verified gets a row in the table "Claims that are not verified", with the reason. The step `Measure` then fails.
- The table of each claim gives the place of the page of the claim in the results of `crawl_find`. The value `none` tells that the page is not in the first 10 results. The count includes the results of the search in each case.

### What the numbers leave out

- The read window starts at the position of the quote, so the agent knows where to read. The row "reads from the start" is the bound for an agent that reads from character 0 in ranges of 4,000 characters, until a range holds the quote.
- The reader of polite-crawler cuts the text of a page at 50,000 characters. `crawl_read` reads only the cut text, but `crawl_verify` also examines the whole text. For a quote past the cut, the path has no read, and the excerpt of `crawl_verify` shows the text around the quote. The column "Read window" then says `past-cut`, and the summary gives the count of these claims.
- The tool definitions and the instructions of the MCP server cost tokens one time in each session. The summary gives this count separately.
- The count leaves out the text that the agent writes (the arguments of each call) and the system prompt.

## Start it

Online mode fetches pages. Start it in CI only:

```sh
gh workflow run eval.yml -R mark1russell7/crawler --ref <branch>
```

The workflow also starts after each release. The job summary shows the tables. The artifact `eval` holds these files for 90 days:

| File | What it holds |
| --- | --- |
| `eval-result.json` | The result: each claim, the summary, the archive and the outcome of each live fetch |
| `eval-offline.json` | The same result, from the WACZ file alone |
| `eval-summary.md` | The tables of the job summary |
| `eval.wacz` | The store of the run: the inputs of each number |

Offline mode reads a WACZ file, and it sends no request. Download the artifact of a run, and check out the commit of the run (the field `commit`). Then start this command at the root of the repository:

```sh
pnpm exec tsx packages/polite-crawler/eval/run.mts --from eval.wacz --expect eval-result.json
```

With `--expect`, the command compares its result with the saved result. It prints `same` or `DIFFERENT` for each part, and it exits with 1 when a part is different. A different commit can change the reader of the pages, and thus the numbers.

The other options are `--claims` (a different question set), `--out`, `--markdown`, `--summary` and `--window` (the read window in characters).

### Why a replay gives the same numbers

- The replay fetches the URLs one at a time, in the sequence of the claims.
- The clock of the replay starts at the first capture of the archive. It moves only when the crawler waits. Thus each capture id and each fetch time is the same at each run.
- During the tool calls, `Date.now` gives the time of that clock. Thus the age of each copy in a result is the same.
- Each tool result has a random envelope id. The count replaces it with an id of the same length, from a hash of the claim and the tool.
- The online run measures from its own WACZ file, the same way. The step "Measure again from the WACZ file" then does the replay a second time and compares the two results.

## Part B: real sessions of Claude Code

Part B gives the same claims to Claude Code (`claude -p`), and measures the tokens that the API counts. Each session costs money on the API. Thus part B starts only when a person starts it, in CI.

### The arms

Each claim gets one session in each arm. The arms use the same model and the same prompt.

| Arm | The tools of the session |
| --- | --- |
| `mcp` | The tools of `polite-crawler-mcp`, with a new store. The session has no built-in tool. |
| `mcp-quote` | The same server with `--tools quote` (0.2.3 or later): only `crawl_fetch`, `crawl_find`, `crawl_read` and `crawl_verify`. |
| `webfetch` | The built-in tool WebFetch. The session has no MCP server. |

The prompt gives the URL and the question. It asks for the exact words of the page between `<quote>` and `</quote>`. `session-result.mts` has the prompt.

### The method of part B

1. A job for each arm starts the sessions one after the other. No more than two jobs operate at the same time. Thus each site gets no more than two sessions at the same time.
2. Each session starts in a new empty folder, with no settings and no `CLAUDE.md`.
3. The session operates with `--output-format stream-json`. The job keeps the stream of each session.
4. The record of a session takes the tokens and the cost from the result of the stream. The tokens include each model of the session. WebFetch gives each page to a small model, and the record counts that model too.
5. The check normalizes the quote marks, the dashes and the white space. Then it compares the quote of the answer with the quote of the claim.
6. The summary fetches each page one time with the crawler. It examines each quote of each answer on the page, word for word. A quote on the page proves an answer, also when it is not the sentence of the claim. WebFetch gives the page as Markdown. Thus the check also tries the quote with no inline Markdown: no code marks, bold or italic marks, or link addresses.

The check of the claim gives one of these values:

| Check | What it tells |
| --- | --- |
| `verified` | A quote of the answer holds the quote of the claim. |
| `partial` | A quote of the answer is a part of the quote of the claim, with 20 characters or more. |
| `wrong` | The answer has a quote, but the quote of the claim is not in it. |
| `no-quote` | The answer has no quote. |

The column "On the page" tells if each quote of the answer is on the page.

### The limits

- `--max-turns` stops a session after 12 turns.
- `--max-budget-usd` stops a session at 1 USD.
- The budget of each arm (20 USD) stops the arm before its next session. The remaining claims get the status `skipped`.
- The workflow pins the versions of Claude Code and `polite-crawler-mcp`.

### Start part B

Start a dry run with two claims first:

```sh
gh workflow run eval-sessions.yml -R mark1russell7/crawler -f limit=2
```

The inputs are `arms` (a JSON list, default `["mcp","webfetch"]`), `mcp_version`, `limit`, `only` (claim ids), `repeat` (the sessions of each claim in each arm), `model`, `budget`, `max_turns`, `max_session_usd` and `summary_of`. With the id of an earlier run in `summary_of`, the workflow starts no session. It makes the summary of that run again, with the code of the branch. The job summary shows the tables. The artifact `eval-b` holds `eval-b-result.json` and `eval-b-summary.md`. The artifacts `sessions-mcp` and `sessions-webfetch` hold the stream of each session.

The table "Projected for the set" gives the cost of the 30 claims at the mean cost of a session. Use it to decide on the full run.

## The test

`measure.test.ts` makes a small WACZ file from a mock site. The site has a long page, a page longer than the cut, a short page and a redirect. `pnpm test` starts the test. The test measures five claims two times, and it checks these facts:

- The two results are the same.
- A claim with a missing quote fails, with its reason.
- A quote past the cut is verified, with no read.
- A page outside the archive gets no request.

## The latest numbers

The eval of 2026-10-18 ([workflow 39085336453](https://github.com/mark1russell7/crawler/actions/runs/39085336453), commit `a8194ad`) verified 30 of 30 claims. Its archive `eval.wacz` has the SHA-256 `d32f43f95b8b8435`.

| Path | Median tokens | Total tokens |
| --- | ---: | ---: |
| polite-crawler: fetch, find, read of 2,000 characters, verify | 3,679 | 110,718 |
| polite-crawler, reads from the start in ranges of 4,000 | 4,746 | 201,572 |
| WebFetch proxy: the page as Markdown (turndown) | 8,348 | 989,280 |
| The page as visible text | 5,979 | 562,544 |

- The Markdown proxy has 8.94 times the tokens of the polite-crawler path, as a ratio of the totals. For one claim, the median ratio is 2.22.
- On a long page, the difference is large: RFC 9110 has approximately 57 times the tokens, and a long Wikipedia article approximately 49 times.
- On a very short page, polite-crawler costs more. Its search snippets and its read window are larger than the page.
- The tool definitions of the MCP server cost 8,539 tokens, one time in each session. The table does not include them.
- The tokenizer is `cl100k_base`, a proxy. The subsection "Part B" below gives the real cost in Claude Code.

### Part B

The sessions of 2026-10-25 used Claude Code 2.1.296 and `polite-crawler-mcp` 0.2.1: 180 sessions with Sonnet ([workflow 40153411428](https://github.com/mark1russell7/crawler/actions/runs/40153411428)) and 60 with Opus ([workflow 40154501047](https://github.com/mark1russell7/crawler/actions/runs/40154501047)). Each claim got 3 sessions in each arm with Sonnet, and 1 with Opus. The whole eval cost 5.1755 USD, with a dry run of 0.0804 USD.

| Model | Arm | Quotes on the page | Median cost of a session | Cost for each quote on the page |
| --- | --- | ---: | ---: | ---: |
| Sonnet | `mcp` | 88 of 90 | 0.0177 USD | 0.0220 USD |
| Sonnet | `webfetch` | 82 of 90 | 0.0099 USD | 0.0132 USD |
| Opus | `mcp` | 29 of 30 | 0.0408 USD | 0.0464 USD |
| Opus | `webfetch` | 30 of 30 | 0.0201 USD | 0.0244 USD |

WebFetch costs approximately half as much, because a small model (`claude-haiku-5-5`) reads the page and the main model reads only its answer. The page [Real Claude Code sessions](https://mark1russell7.github.io/crawler/notes/claude-code-sessions/) gives each claim and the limits.
