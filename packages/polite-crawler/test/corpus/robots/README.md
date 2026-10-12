# The golden robots.txt corpus

This folder holds 38 real robots.txt files, as the sites served them, and the verdicts that the robots.txt study recorded for each one. A test can parse each file with `parseRobots`, decide each agent with `decide`, and compare the result with `decisions.json`.

## The source

- **The study:** [Who lets AI agents in?](https://mark1russell7.github.io/crawler/notes/robots-txt-ai-agents/), made by `packages/site/scripts/robots-study.ts`. Its dataset is `packages/site/src/data/robots-study.json`.
- **The list:** the Tranco list `4672X` of 2026-10-11, the top 1,000 domains.
- **The fetch:** 2026-10-12, from 16:42 to 16:44 UTC. Each domain got one request for `/robots.txt` (and its redirects), with the default `User-Agent` of the crawler, `PoliteCrawler/0.1.0 (+https://mark1russell7.github.io/crawler/bot/)`, and no contact.
- **The bodies:** copied byte for byte from the blob store of that run. No new request was made for this folder. `decisions.json` gives the SHA-256 hash of each file, and that hash is the blob id in the store.

The files are test data. Each file is the robots.txt of its site on that date. A site can change its file at any time, so the files here are not a statement about the sites today.

## The files

- `<domain>.txt` is the body of `https://<host>/robots.txt`. The URL in `decisions.json` names the host after the redirects (`www.google.com` for `google.com`).
- `.gitattributes` marks the folder `-text`, so git keeps each byte. Some files have CRLF line ends, one starts with a byte order mark, and one is a single line break.

The choice covers these cases:

| Case | Examples |
| --- | --- |
| Groups that name AI agents | `amazon.com`, `github.com`, `tiktok.com`, `bloomberg.com`, `quora.com` |
| A `*` group that refuses all agents | `gstatic.com`, `reddit.com`, `googlevideo.com`, `naver.com` |
| Different verdicts for `/` and for a deeper page | `vimeo.com`, `chatgpt.com`, `soundcloud.com`, `statista.com`, `mail.ru` |
| `Crawl-delay` | `x.com`, `vimeo.com`, `europa.eu`, `apache.org`, `cloudflare.net` |
| `Content-Signal` lines | `cloudflare.com`, `linktr.ee`, `forter.com`, `sentry.io`, `weibo.com` |
| Large files | `facebook.com` (35 KB), `wikipedia.org` (28 KB, with a byte order mark) |
| Very small files | `ntp.org`, `quickconnect.to` (one line break) |
| CRLF line ends | `msn.com`, `nvidia.com`, `cloudflare.net` |

## decisions.json

- `agents` lists the 15 product tokens in the order of the verdict strings.
- `pagePath` is the path that the `page` verdicts are for: `/polite-crawler-study/a-page`.
- `sites.<domain>.page` has one character for each agent, for the page path.
- `sites.<domain>.home` has the verdicts for `/`. It is there only when they differ from `page`.

The characters:

| Character | Verdict |
| --- | --- |
| `.` | Permitted. No group names the agent. |
| `n` | Permitted. A group names the agent. |
| `N` | Refused by a group that names the agent. |
| `S` | Refused by the `*` group. |
| `U` | robots.txt was unreachable. |

The verdicts come from the parser of the study run. If a change to `robots.ts` changes a verdict, the change must give the reason, and the test must record the new verdict.
