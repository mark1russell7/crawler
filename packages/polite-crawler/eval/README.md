# The eval: tokens per verified claim

This folder holds the evals of polite-crawler. Part A is a count in CI, with no model. It counts the text that an agent reads to verify a claim with polite-crawler, and the text of the WebFetch way. Part B starts real sessions of Claude Code in CI. It measures the tokens and the cost with the count of the API.

Part C, the decision eval, asks a different question. It measures two choices of the venue recipe against the hours of OpenStreetMap.

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

#### The run of `polite-crawler-mcp` 0.2.3

`polite-crawler-mcp` 0.2.3 made the tool text and the instructions shorter. The sessions of 2026-10-25 in [workflow 40163619030](https://github.com/mark1russell7/crawler/actions/runs/40163619030) used Claude Code 2.1.296, Sonnet (`claude-sonnet-5-5`) and `polite-crawler-mcp` 0.2.3. The run started only the arms `mcp` and `mcp-quote`, with 3 sessions for each claim in each arm: 180 sessions. The run cost 3.3529 USD, with a dry run of 0.0879 USD ([workflow 40163467327](https://github.com/mark1russell7/crawler/actions/runs/40163467327)).

The run did not start the WebFetch arm again, because it changed nothing for WebFetch. The rows of `webfetch` and of `mcp` 0.2.1 come from the Sonnet run of 0.2.1 above.

| Arm | Run | Quotes on the page | The quote of the claim | Median cost of a session | Cost for each quote on the page | Median tokens that the models read |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `mcp` | 0.2.1 | 88 of 90 | 79 | 0.0177 USD | 0.0220 USD | 35,628 |
| `mcp` | 0.2.3 | 86 of 90 | 81 | 0.0166 USD | 0.0197 USD | 24,829 |
| `mcp-quote` | 0.2.3 | 88 of 90 | 81 | 0.0158 USD | 0.0188 USD | 21,752 |
| `webfetch` | 0.2.1 | 82 of 90 | 83 | 0.0099 USD | 0.0132 USD | 19,945 |

- 0.2.3 cut the median tokens of a session by 30%, and by 39% with `--tools quote`. It cut the median cost of a session by 6% and 11%, and the cost for each quote on the page by 10% and 14%.
- The quotes on the page stayed almost the same. The misses are almost all on the status code 418 of RFC 9110, whose quote is past the cut of 50,000 characters. One session of `mcp` gave a quote on WCAG 2.1 that is not on the page.
- WebFetch still costs less. A token that Sonnet writes to its cache costs 25 times a token that it reads from the cache (2.50 USD against 0.10 USD for one million). The writes to the cache are 69% of the cost of the arm `mcp-quote`.
- A median session of `mcp-quote` writes 4,502 tokens to the cache. The main model of WebFetch writes 2,206. The small model of WebFetch reads the page (a median of 13,133 tokens) as input, at 0.10 USD for one million.
- For 90 sessions, `mcp-quote` cost 0.5717 USD more than WebFetch, and its writes to the cache cost 0.6215 USD more. The shorter tool text cut mostly the reads from the cache, the cheapest kind of token.

## Part C: the decision eval

Part C asks a different question. The venue recipe (`readVenue`) makes two choices with a fixed rule. How frequently does the rule choose correctly? The hours of OpenStreetMap are the reference.

Step 1 of part C uses no model. It makes the labelled data. Step 2 uses these labels to compare a model, Laya, with the rule (refer to "Step 2: Laya against the rule"). The code is in `decisions/`.

### The two choices

| Choice | The rule | The question |
| --- | --- | --- |
| Links | `rankHoursLinks` ranks the links of the home page. `readVenue` fetches the first 3 (`VENUE_LIMITS.pages`). | The home page alone does not agree, and a candidate page agrees. Does a page of the first 3 links of the rule agree? |
| Best | `chooseVenueReadings` orders the readings and chooses the best reading, as `readVenue` does. | A reading of the pages of the rule agrees. Does the best reading agree? |

### The labels

A week agrees with OpenStreetMap when these two conditions are true:

- `compareHours` finds no day that changed between the week of OpenStreetMap (`fromCompact(opening_hours, "osm")`) and the week of the reading.
- The two weeks share one day or more. A week that shares no day with OpenStreetMap tells nothing (`no-overlap`).

Thus a reading that gives only some days agrees when those days are the same. The eval uses the reader and the comparison of the crawler. It has no reader of hours of its own.

The candidate links of a home page are the first 8 links of `rankHoursLinks`. Then they are the first 8 other links of the site, in the order of the page. The eval leaves out the links to other sites, to files (a PDF, an image) and to the home page, as `rankHoursLinks` does. Thus the crawler fetches a maximum of 17 pages for each site.

Each page gets one label:

| Label | What it tells |
| --- | --- |
| `agrees` | A reading of the page agrees. |
| `disagrees` | No reading agrees, and a reading disagrees. |
| `no-hours` | The page has no reading that shares a day with OpenStreetMap. |
| `no-page` | The archive has no page that the crawler can read: a refusal, an error, or a page that asked not to be AI input. |

Each venue gets one outcome for each choice:

| Choice | Outcome | What it tells |
| --- | --- | --- |
| Links | `no-home` | The archive has no home page that the crawler can read. |
| Links | `home-agrees` | The home page alone agrees. |
| Links | `rule-hit` | The home page does not agree, and a page of the first 3 links of the rule agrees. |
| Links | `rule-miss` | The home page does not agree, another candidate page agrees, and no page of the first 3 links of the rule agrees. |
| Links | `no-page-agrees` | No page agrees. |
| Best | `no-home` | The archive has no home page that the crawler can read. |
| Best | `no-reading` | The home page and the pages of the rule give no reading. |
| Best | `none-agrees` | No reading of these pages agrees. |
| Best | `hit` | A reading agrees, and the best reading agrees. |
| Best | `miss` | A reading agrees, and the best reading does not agree. |

The score of the links is the `rule-hit` venues, of the `rule-hit` and `rule-miss` venues. The score of the best reading is the `hit` venues, of the `hit` and `miss` venues. The result also gives the venues where no page agrees, because this count is a finding. The hours of OpenStreetMap can be old. A site can give its hours in a form that the crawler cannot read.

### The areas

`decisions/areas.json` has three areas: central Edinburgh (United Kingdom), central Portland (Oregon, United States) and central Melbourne (Australia). Each area has a name and a box.

The eval keeps a venue when these conditions are true:

- It is a node or a way with `amenity` of `restaurant`, `cafe`, `bar`, `pub` or `fast_food`, or with a `shop` tag.
- It has a `website` tag and an `opening_hours` tag.
- `fromCompact` reads its `opening_hours` as a week with one day or more.

A seeded draw keeps a maximum of 400 venues of each area.

### The steps

1. `collect.mts` (online, CI only) sends one Overpass query for each area through `send` of `polite-crawler/api`, at the pace of the host. Its User-Agent names the crawler and its repository. A query that times out (a 504, or a remark of a runtime error) splits its tile into four tiles, to a depth of 3. The step writes `venues.json`.
2. `crawl.mts` (online, CI only) visits each venue with `visitVenue`. It fetches the home page, then each candidate link. robots.txt, the pace of each site, the stops and the rule for a held-back page apply. The rules for `Claude-User` in robots.txt apply too, because a model reads the labels later. No visit starts after the budget (80 minutes in the workflow). The step exports one WACZ file with the refusals and the redirects, `decisions.wacz`. It writes the status of each venue to `decisions-crawl.json`.
3. `replay.mts` (offline) replays the WACZ file into a new store with `replayVenues` (`replay-venues.mts`), as part A does. It visits each venue of the log again with `visitVenue`, in the order of the ids. A URL that is not in the archive gets a 404, and no request goes to the network. Then the step labels each venue, splits the venues and scores the two choices. It writes `labels.jsonl` and `result.json`.

The split puts each venue in the train half or the test half. In each area, it orders the venues by a seeded hash of the OpenStreetMap id (`deriveSeed` of `@mark1russell7/rigor-generators`). The first half of the order is the train half. The split uses each venue of `venues.json`, so the half of a venue does not change with the crawl.

### The result

`labels.jsonl` has one line for each venue. The line has the OpenStreetMap id, the area, the half, the site and the week of OpenStreetMap as words. It also has the label of the home page, the candidate links, the readings, the place of the best reading and the two outcomes. Each candidate link has its features and its label:

| Field | What it holds |
| --- | --- |
| `url`, `text`, `path` | The link and its text |
| `position` | The place of the link among the links of the home page (1 is the first) |
| `rule_rank` | The place of the link in the result of `rankHoursLinks` (1 is the first), or null |
| `label`, `readings` | The label of the page and the count of its readings |

`result.json` has these fields:

| Field | What it holds |
| --- | --- |
| `attribution` | © OpenStreetMap contributors (ODbL) |
| `package`, `commit` | The version of the crawler and the commit |
| `archive` | The WACZ file: its SHA-256, the counts of responses and redirects, and the first capture |
| `venues` | The venues of the file, the venues of the replay, and the venues that the budget stopped or did not start |
| `split` | The seed, and the count of each half |
| `rule_pages`, `candidates` | The pages of the rule (3), and the counts of candidate links (8 and 8) |
| `pages` | The fetches of the replay, and the pages that asked not to be AI input |
| `links`, `best` | The scores of the two choices, for all the venues, each half and each area |

Each rate has `k`, `n`, `value`, and the 95% Wilson interval `low` and `high` (`wilson` of `@mark1russell7/rigor-statistics`). The value is null when `n` is 0. The score of the links has `no_home`, `home_agrees`, `no_page_agrees` and `rule`. The score of the best reading has `no_home`, `no_reading`, `none_agrees` and `rule`.

### The data rules

- The data of OpenStreetMap is © OpenStreetMap contributors (ODbL). Each summary of these data carries this attribution: the job summary, and each page of the docs that gives the numbers.
- `venues.json`, `decisions.wacz`, `decisions-crawl.json`, `labels.jsonl` and `result.json` are artifacts of CI only. They do not go into the repository, and `.gitignore` has their names.
- robots.txt, the pace rules and the privacy rules are the rules of the crawler. The eval does not decide them, and a model does not decide them.
- The online steps operate only in CI, not on a shared computer.

### Start part C

```sh
gh workflow run decisions.yml -R mark1russell7/crawler -f per_area=400 -f budget=80
```

The job `archive` uploads the artifact `decisions-archive`: `venues.json`, `decisions.wacz` and `decisions-crawl.json`. The job `score` uploads the artifact `decisions-result`: `labels.jsonl`, `result.json` and `decisions-summary.md`. The job summary shows the tables.

The tests `label.test.ts`, `score.test.ts`, `venues.test.ts`, `visit.test.ts` and `replay-venues.test.ts` use made-up venues and pages on mock hosts, with no network. `visit.test.ts` makes sure that the eval chooses the same best reading as `readVenue` on the same pages. `replay-venues.test.ts` records a crawl as a WACZ file, replays it, and makes sure that the labels do not change. The test command of the package starts them.

### Step 2: Laya against the rule

Step 2 asks: does a decision model make the two choices better than the rule, on the same venues? The model is Laya (`convaiinnovations/laya` on Hugging Face, Apache-2.0). Laya reads a state and typed questions, and gives a probability for each option in one forward pass. It does not generate text. The code is in `decisions/laya.mts` (pure functions) and `decisions/laya-run.mts` (the command).

The questions:

- Each candidate link is one state with one choice of two options: does the page of the link show the opening hours (`hours` or `other`)? The model fetches the links with the highest probability, as many as the rule fetches (3). Links with equal probabilities go in the order of the page.
- Each reading is one state with one choice of two options: is it the regular week (`regular` or `other`)? The model chooses the reading with the highest probability.

A choice over all the links of a venue at one time is not used, because a choice of many options loses accuracy (the model card). A state holds only what the crawler sees when it chooses. For a link, this is the text, the path and the place on the page. For a reading, it is the fields of the reading. A state does not hold the rank of the rule, so the arm measures the model alone.

The targets come from the labels of step 1:

| Question | Yes | No | No target |
| --- | --- | --- | --- |
| The link | The page `agrees` | The page has `no-hours` | `disagrees` (the hours of OpenStreetMap can be old) and `no-page` |
| The reading | The reading `agrees` | The reading `disagrees` | `no-overlap` |

The arms:

| Arm | The model |
| --- | --- |
| `untrained` | The checkpoint `laya-typed-decisions` at a pinned revision, with no training |
| `trained-full` or `trained-head` | The same checkpoint, trained with `laya-train` on the rows of the train half, with seed 0 |

The base checkpoints of Laya are near chance with no training (the model card), so the untrained arm uses the checkpoint that is fine-tuned for typed decisions. The CI runners have no GPU. Thus, before the training, the job times one epoch of 64 rows in each mode. The mode `full` trains the whole model, and the mode `head` does not change the encoder. `trainingPlan` takes the mode whose time fits in the budget (120 minutes), first `full`, then `head`, else no training. The trial time holds the load of the checkpoint, so the time of the plan can be too high, but it is not too low.

The test half decides. Nothing of the test half goes into the training rows or into the temperature. For each choice, the result gives the rate of the rule and the rate of the model on the same venues of the test half. Each rate has its Wilson interval. The result also counts the venues where only the model hits (better) and the venues where only the rule hits (worse). A two-sided sign test (`signTest` of `@mark1russell7/rigor-statistics`) compares the two counts.

For each question, one temperature is fitted on the train half (the lowest log-loss, from 1/8 to 8). The result gives the Brier score of the test half with the probabilities of the server and with the fitted temperature.

The runtime: the job installs a pinned version of the Python package `laya` on the CPU build of torch. Then it downloads the checkpoint at its pinned revision into a folder. `laya-serve` listens only on 127.0.0.1, with a key that the job makes for the run. It loads a checkpoint at the first request, and takes a built-in checkpoint only at its reviewed revision (`LAYA_REVISION=reviewed`).

`laya-run.mts score` waits for `/health`, sends the states in batches of 64 (`POST /v1/systemone/batch`), and scores the arm. The server is a process of the job, not a site of others, so the requests do not go through the polite transport. The eval itself stays TypeScript.

Start step 2 with the labels of an earlier run, with no new crawl:

```sh
gh workflow run decisions.yml -R mark1russell7/crawler -f labels_run=<run id> -f train=auto -f train_budget=120 -f epochs=4
```

With no `labels_run`, step 2 runs after step 1 in the same run. `-f laya=false` stops it. `-f train=none` scores only the untrained arm. The job `laya` uploads the artifact `laya-result`. It holds:

- the result and the tables of each arm (`laya-untrained.json`, `laya-trained.json` and their `.md` files)
- the plan of the training (`laya-plan.json`)
- the training rows (`laya-train.jsonl`)
- the versions of the Python packages (`laya-pip-freeze.txt`)
- the logs of the server.

The trained checkpoint is not kept: the rows and the seed make it again. The training rows hold data of OpenStreetMap and URLs of other sites, so they are artifacts of CI only, as the labels are.

`laya.test.ts` tests the pure functions with made-up venues:

- the batches and the reading of a response
- the choices and their ties
- the paired comparison and the fit of a known temperature
- the training rows (none from the test half) and the training plan.
