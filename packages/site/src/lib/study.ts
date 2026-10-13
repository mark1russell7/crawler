/**
 * The robots.txt study. This module has the types of the dataset that scripts/robots-study.ts writes,
 * and the classification of each answer. It also gives each number of the article, its charts, the
 * home page, the share card and llms.txt. All of them read the dataset through these functions, so no
 * page keeps a copy of a number.
 */
import { HTML_ROBOTS, isHtmlRobots } from "polite-crawler/robots";

export type Role = "training" | "search" | "user" | "control";

export interface StudyAgent {
  readonly token: string;
  readonly owner: string;
  readonly role: Role;
}

/**
 * The answer of a domain to the request for /robots.txt.
 *
 * - `file`: a robots.txt file. The verdicts come from its rules.
 * - `none`: no file. A 404 or a 410, or an HTML page in place of the file. The site states no rules.
 * - `blocked`: blocked at the edge. The server answered with a refusal, a challenge or an error
 *   in place of the file. Examples are a 401, 403, 418, 429, 498 or 5xx, and a challenge page.
 * - `unreachable`: no answer. No address in the DNS, a TLS error, a timeout, or a redirect loop.
 */
export type State = "file" | "none" | "blocked" | "unreachable";

/**
 * A site has one code for each agent, in the sequence of the agents.
 *
 * - `N`: a group that names the agent refuses it.
 * - `S`: the group `*` refuses it.
 * - `n`: a group that names the agent permits it.
 * - `.`: no group refuses it.
 * - `B`: the site blocked the request at the edge, so the rules are not known.
 * - `U`: the site gave no answer.
 */
export type Verdict = "N" | "S" | "n" | "." | "B" | "U";

export interface StudySite {
  readonly rank: number;
  readonly domain: string;
  /** the host of the last answer, when a redirect went to another host */
  readonly host?: string;
  readonly status: number;
  readonly state: State;
  /** why the site is blocked or unreachable */
  readonly reason?: string;
  /** the site gave an HTML page in place of the file */
  readonly html?: boolean;
  readonly bytes?: number;
  readonly groups?: number;
  readonly delay?: number;
  readonly signals?: readonly string[];
  readonly sitemaps?: number;
  /** the codes for the page path, one for each agent */
  readonly p: string;
  /** the codes for the home page, when they differ from the page path */
  readonly h?: string;
  /** for each agent: [line of the group, line of the rule], or 0 when no rule decided */
  readonly r?: ReadonlyArray<readonly [number, number] | 0>;
  /** the text of each line that `r` names */
  readonly lines?: Readonly<Record<string, string>>;
}

export interface Study {
  readonly list: {
    readonly name: string;
    readonly id: string;
    readonly date: string;
    readonly url: string;
    readonly size: number;
  };
  readonly fetched: { readonly from: string; readonly to: string };
  readonly userAgent: string;
  readonly pagePath: string;
  /** the license of the dataset, as an SPDX id */
  readonly license?: string;
  readonly agents: readonly StudyAgent[];
  readonly sites: readonly StudySite[];
}

export const ROLES: ReadonlyArray<{ readonly role: Role; readonly label: string }> = [
  { role: "training", label: "Training data" },
  { role: "search", label: "AI search" },
  { role: "user", label: "Acts for a person" },
  { role: "control", label: "For comparison" },
];

/** The four answers, in the sequence of the charts, with the text that each chart and table shows. */
export const STATES: ReadonlyArray<{ readonly state: State; readonly label: string; readonly meaning: string }> = [
  { state: "file", label: "A robots.txt file", meaning: "The verdicts come from its rules." },
  {
    state: "none",
    label: "No file",
    meaning: "A 404 or a 410, or an HTML page in place of the file. The site states no rules, so each agent is permitted.",
  },
  {
    state: "blocked",
    label: "Blocked at the edge",
    meaning:
      "The server answered with a refusal, a challenge or an error in place of the file. The rules of the site are not known.",
  },
  {
    state: "unreachable",
    label: "Unreachable",
    meaning:
      "The crawler got no file that it could read: no address in the DNS, a TLS error, a timeout, a redirect loop or a body that it could not decode.",
  },
];

/** The licenses: the dataset and the text of the study are CC BY 4.0, and the code is MIT. */
export const DATA_LICENSE = {
  id: "CC-BY-4.0",
  name: "CC BY 4.0",
  url: "https://creativecommons.org/licenses/by/4.0/",
} as const;

export const STUDY_AUTHOR = { name: "Mark Russell", url: "https://github.com/mark1russell7" } as const;

/* ---------------------------------------------------------------------------------------------- */
/* The classification of one answer                                                               */
/* ---------------------------------------------------------------------------------------------- */

/** What the crawler got for one request for /robots.txt, before the study reads it. */
export interface RawAnswer {
  readonly status: number;
  /** the outcome of polite-crawler: `ok`, `challenge`, `blocked`, `redirect` and the others */
  readonly outcome: string;
  readonly contentType?: string | undefined;
  readonly text?: string | undefined;
  readonly note?: string | undefined;
}

export interface Answer {
  readonly state: State;
  readonly html: boolean;
  readonly reason?: string;
}

/**
 * Marks of the pages that a bot wall shows in place of the content. Each pattern is specific to a
 * challenge or a block, so a normal page that loads a script of the same company does not match.
 */
const WALLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\/cdn-cgi\/challenge-platform\/|cf-chl-|cf_chl_|<title>\s*just a moment\.\.\.|attention required! \| cloudflare/i, "a Cloudflare challenge"],
  [/_incapsula_resource|incapsula incident id/i, "an Imperva challenge"],
  [/captcha-delivery\.com/i, "a DataDome challenge"],
  [/px-captcha|_pxcaptcha|access to this page has been denied/i, "a HUMAN challenge"],
  [/awswafintegration|token\.awswaf\.com/i, "an AWS WAF challenge"],
  [/errors\.edgesuite\.net|<title>\s*access denied\s*<\/title>/i, "an Akamai block"],
  [/kpsdk/i, "a Kasada challenge"],
  // a proof of work in JavaScript that sets a cookie and loads the page again
  [/__js_p_|get_jhash\(/, "a JavaScript challenge"],
];

/** A page that asks for a CAPTCHA and is not a full web page. */
const CAPTCHA = /g-recaptcha|google\.com\/recaptcha\/|hcaptcha\.com|challenges\.cloudflare\.com\/turnstile/i;
const CAPTCHA_TITLE = /<title>[^<]*(captcha|security|verif|robot|unusual|challenge|blocked|denied)[^<]*<\/title>/i;

/** This function gives the name of the bot wall that a page shows, or undefined for a normal page. */
export const wallOf = (text: string): string | undefined => {
  for (const [pattern, name] of WALLS) if (pattern.test(text)) return name;
  if (CAPTCHA.test(text) && CAPTCHA_TITLE.test(text)) return "a CAPTCHA page";
  return undefined;
};

/**
 * This function puts one answer into one of the four states. RFC 9309 reads a 4xx as "no file", and
 * the crawler then fetches each path. The study asks a different question: what does the site tell
 * each AI agent? A 403 to the request of the study tells nothing about the rules for GPTBot, so only
 * a 404 and a 410 are "no file".
 *
 * A web page in place of the file (a home page or a sign-in page) is a file that the crawler cannot
 * read, as `isHtmlRobots` of polite-crawler decides. The crawler then fetches nothing from the site.
 * Thus the study counts such a site as unreachable, not as a site with no rules.
 */
export const answerOf = (raw: RawAnswer): Answer => {
  const { status, outcome, note } = raw;
  if (status === 0) return { state: "unreachable", html: false, reason: note ?? "no response" };
  if (outcome === "redirect")
    return {
      state: "unreachable",
      html: false,
      reason: note?.startsWith("location ") === true ? "more than 5 redirects" : `status ${String(status)} with no Location header`,
    };
  if (outcome === "challenge")
    return { state: "blocked", html: false, reason: `${note ?? "a challenge"}, status ${String(status)}` };
  if (status === 404 || status === 410) return { state: "none", html: false };
  // a 304 confirms the copy that the crawler fetched before in the same run, for example through a
  // redirect from a different domain: the stored body is the file
  const kept = outcome === "not-modified" && raw.text !== undefined;
  if (!kept && (status < 200 || status >= 300)) return { state: "blocked", html: false, reason: `status ${String(status)}` };
  if (raw.text === undefined) {
    // a page too large to decode is still a page, and a bot wall is small
    if (/html/i.test(raw.contentType ?? "")) return { state: "unreachable", html: true, reason: HTML_ROBOTS };
    return { state: "unreachable", html: false, reason: note ?? `status ${String(status)} with no body` };
  }
  if (!isHtmlRobots(raw.contentType, raw.text)) return { state: "file", html: false };
  const wall = wallOf(raw.text);
  if (wall !== undefined) return { state: "blocked", html: true, reason: `${wall} in place of the file, status ${String(status)}` };
  return { state: "unreachable", html: true, reason: HTML_ROBOTS };
};

/* ---------------------------------------------------------------------------------------------- */
/* The numbers                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

export const refused = (verdict: string | undefined): boolean => verdict === "N" || verdict === "S";

/** The sites that answered: a robots.txt file, or no file. The shares count only these sites. */
export const answered = (study: Study): readonly StudySite[] =>
  study.sites.filter((site) => site.state === "file" || site.state === "none");

export const percent = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

/** The top of the axis of a chart: the next multiple of 5 above the largest value, or of 10 above 50. */
export const niceMax = (value: number): number => {
  const step = value > 50 ? 10 : 5;
  return Math.max(step, Math.ceil(value / step) * step);
};

/** The ticks of an axis from 0 to `max`. */
export const ticks = (max: number): readonly number[] => {
  const step = max > 50 ? 10 : 5;
  return Array.from({ length: max / step + 1 }, (_, index) => index * step);
};

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** A share as words: 19.0 gives "one site in five". */
export const oneIn = (share: number): string => {
  const whole = Math.round(100 / Math.max(share, 0.1));
  return `one site in ${SMALL[whole] ?? whole.toLocaleString("en-US")}`;
};

/** A date of the study, as the pages show it: 12 October 2026. */
export const formatDay = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export interface AgentRow {
  readonly token: string;
  readonly owner: string;
  readonly role: Role;
  /** refused by a group that names the agent */
  readonly byName: number;
  /** refused by the group `*` */
  readonly byStar: number;
  /** permitted by a group that names the agent */
  readonly welcomed: number;
  readonly refused: number;
  /** the share of the sites that answered */
  readonly share: number;
  /** the share of the sites with a robots.txt file */
  readonly fileShare: number;
}

export const agentRows = (study: Study): readonly AgentRow[] => {
  const sites = answered(study);
  const files = sites.filter((site) => site.state === "file").length;
  return study.agents.map((agent, index) => {
    const count = (code: Verdict): number => sites.filter((site) => site.p[index] === code).length;
    const byName = count("N");
    const byStar = count("S");
    return {
      ...agent,
      byName,
      byStar,
      welcomed: count("n"),
      refused: byName + byStar,
      share: percent(byName + byStar, sites.length),
      fileShare: percent(byName + byStar, files),
    };
  });
};

export interface SignalValue {
  readonly key: string;
  readonly yes: number;
  readonly no: number;
  /** sites whose lines give different values for the key, for example one line for each group */
  readonly mixed: number;
}

export interface Summary {
  readonly listSize: number;
  readonly answered: number;
  readonly withFile: number;
  readonly noFile: number;
  /** of the unreachable sites: an HTML page in place of the file, which the crawler cannot read */
  readonly html: number;
  readonly blocked: number;
  /** of the blocked sites: a challenge page or a WAF challenge, not only a status */
  readonly challenges: number;
  /** the status codes of the blocked sites, the most frequent first */
  readonly blockedStatuses: ReadonlyArray<{ readonly status: number; readonly sites: number }>;
  readonly unreachable: number;
  /** of the unreachable domains: no address in the DNS */
  readonly dns: number;
  /** of the unreachable domains: more than 5 redirects */
  readonly redirects: number;
  /** of the unreachable domains: a body that the crawler could not decode */
  readonly undecodable: number;
  readonly namesAnAgent: number;
  readonly refusesAnAgentByName: number;
  readonly refusesAllTraining: number;
  readonly blocksEveryBot: number;
  readonly signals: number;
  readonly crawlDelay: number;
  /** For each pair: the sites that refuse the training crawler and permit the agent for a person. */
  readonly trainingNotUser: Readonly<Record<string, number>>;
  readonly signalValues: readonly SignalValue[];
  readonly fetchedOn: string;
}

const indexOf = (study: Study, token: string): number =>
  study.agents.findIndex((agent) => agent.token === token);

/** The values that the lines of one site give for one key of a content signal. */
const signalOf = (lines: readonly string[], key: string): "yes" | "no" | "mixed" | undefined => {
  const values = new Set<string>();
  for (const line of lines) {
    const match = new RegExp(`(?:^|[\\s,:])${key}\\s*=\\s*(yes|no)\\b`, "i").exec(line);
    if (match?.[1] !== undefined) values.add(match[1].toLowerCase());
  }
  if (values.size === 0) return undefined;
  if (values.size > 1) return "mixed";
  return values.has("yes") ? "yes" : "no";
};

export const summarize = (study: Study): Summary => {
  const sites = answered(study);
  const of = (state: State): readonly StudySite[] => study.sites.filter((site) => site.state === state);
  const ai = study.agents
    .map((agent, index) => ({ agent, index }))
    .filter(({ agent }) => agent.role !== "control")
    .map(({ index }) => index);
  const training = study.agents
    .map((agent, index) => ({ agent, index }))
    .filter(({ agent }) => agent.role === "training")
    .map(({ index }) => index);
  const polite = indexOf(study, "PoliteCrawler");
  const pair = (bot: string, user: string): number => {
    const b = indexOf(study, bot);
    const u = indexOf(study, user);
    return sites.filter((site) => refused(site.p[b]) && !refused(site.p[u])).length;
  };
  const withSignals = sites.filter((site) => (site.signals ?? []).length > 0);
  const signalValues = ["search", "ai-input", "ai-train"].map((key) => {
    const value = { key, yes: 0, no: 0, mixed: 0 };
    for (const site of withSignals) {
      const found = signalOf(site.signals ?? [], key);
      if (found !== undefined) value[found] += 1;
    }
    return value;
  });
  const blocked = of("blocked");
  const statuses = new Map<number, number>();
  for (const site of blocked) statuses.set(site.status, (statuses.get(site.status) ?? 0) + 1);
  const unreachable = of("unreachable");
  return {
    listSize: study.sites.length,
    answered: sites.length,
    withFile: of("file").length,
    noFile: of("none").length,
    html: unreachable.filter((site) => site.html === true).length,
    blocked: blocked.length,
    challenges: blocked.filter((site) => /challenge|CAPTCHA|block in place/i.test(site.reason ?? "")).length,
    blockedStatuses: [...statuses]
      .map(([status, count]) => ({ status, sites: count }))
      .sort((a, b) => b.sites - a.sites || a.status - b.status),
    unreachable: unreachable.length,
    dns: unreachable.filter((site) => /ENOTFOUND|EAI_AGAIN|ENODATA/.test(site.reason ?? "")).length,
    redirects: unreachable.filter((site) => /redirect/i.test(site.reason ?? "")).length,
    undecodable: unreachable.filter((site) => /undecodable/i.test(site.reason ?? "")).length,
    namesAnAgent: sites.filter((site) => ai.some((index) => site.p[index] === "N" || site.p[index] === "n")).length,
    refusesAnAgentByName: sites.filter((site) => ai.some((index) => site.p[index] === "N")).length,
    refusesAllTraining: sites.filter((site) => training.every((index) => refused(site.p[index]))).length,
    blocksEveryBot: sites.filter((site) => site.p[polite] === "S").length,
    signals: withSignals.length,
    crawlDelay: sites.filter((site) => site.delay !== undefined).length,
    trainingNotUser: {
      OpenAI: pair("GPTBot", "ChatGPT-User"),
      Anthropic: pair("ClaudeBot", "Claude-User"),
      Perplexity: pair("PerplexityBot", "Perplexity-User"),
    },
    signalValues,
    fetchedOn: study.fetched.from.slice(0, 10),
  };
};

/** For each company: the share of sites that refuse its training, search and user agents. */
export const companies = (
  study: Study,
): ReadonlyArray<{
  readonly owner: string;
  readonly agents: ReadonlyArray<{ readonly token: string; readonly role: Role; readonly share: number }>;
}> => {
  const rows = agentRows(study);
  return ["OpenAI", "Anthropic", "Perplexity"].map((owner) => ({
    owner,
    agents: rows
      .filter((row) => row.owner === owner)
      .map((row) => ({ token: row.token, role: row.role, share: row.share })),
  }));
};

/** The sentence of the headline, for the share card, llms.txt and the descriptions of the pages. */
export const headline = (study: Study): { readonly gpt: AgentRow; readonly claudeUser: AgentRow; readonly googlebot: AgentRow; readonly summary: Summary } => {
  const rows = agentRows(study);
  const find = (token: string): AgentRow => {
    const row = rows.find((entry) => entry.token === token);
    if (row === undefined) throw new Error(`the study has no agent ${token}`);
    return row;
  };
  return { gpt: find("GPTBot"), claudeUser: find("Claude-User"), googlebot: find("Googlebot"), summary: summarize(study) };
};

/* ---------------------------------------------------------------------------------------------- */
/* The data for the browser, and the CSV                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** The id of the script element that holds the packed sites in the page of the study. */
export const STUDY_DATA_ID = "pc-study-packed";

/** The packed state of a site: f a file, h an HTML page in place of it, m no file, b blocked, u unreachable. */
export type PackedState = "f" | "m" | "b" | "u";

const packState = (site: StudySite): PackedState =>
  site.state === "file" ? "f" : site.state === "none" ? "m" : site.state === "blocked" ? "b" : "u";

/**
 * The sites for the grid and the table, packed into one text: `rank domain state codes` on each
 * line. A page gives it to the browser one time, at a small fraction of the size of the dataset.
 */
export const pack = (study: Study): string =>
  study.sites
    .map((site) => {
      const state = packState(site);
      return `${String(site.rank)} ${site.domain} ${state} ${state === "b" || state === "u" ? "" : site.p}`;
    })
    .join("\n");

export interface PackedSite {
  readonly rank: number;
  readonly domain: string;
  readonly state: PackedState;
  readonly codes: string;
}

export const unpack = (packed: string): readonly PackedSite[] =>
  packed.split("\n").map((line) => {
    const [rank, domain, state, codes] = line.split(" ");
    return {
      rank: Number(rank),
      domain: domain ?? "",
      state: (state ?? "u") as PackedState,
      codes: codes ?? "",
    };
  });

/** The verdict of one agent for one packed site. */
export const verdictOf = (site: PackedSite, index: number): Verdict =>
  site.state === "u" ? "U" : site.state === "b" ? "B" : ((site.codes[index] ?? ".") as Verdict);

/** The words of each code in the CSV. A site that the shares do not count has no verdict. */
const CSV_VERDICT: Readonly<Record<string, string>> = {
  N: "refused-named",
  S: "refused-star",
  n: "permitted-named",
  ".": "permitted",
};

const csvCell = (value: string | number | undefined): string => {
  const text = value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The dataset as CSV: one row for each domain, with one column for each agent. */
export const toCsv = (study: Study): string => {
  const head = [
    "rank",
    "domain",
    "host",
    "state",
    "status",
    "html",
    "reason",
    "bytes",
    "groups",
    "crawl_delay_s",
    "content_signals",
    ...study.agents.map((agent) => agent.token),
  ];
  const rows = study.sites.map((site) => [
    site.rank,
    site.domain,
    site.host ?? site.domain,
    site.state,
    site.status,
    site.html === true ? "yes" : "",
    site.reason,
    site.bytes,
    site.groups,
    site.delay,
    (site.signals ?? []).join(" | "),
    ...study.agents.map((_, index) =>
      site.state === "file" || site.state === "none" ? (CSV_VERDICT[site.p[index] ?? "."] ?? "") : "",
    ),
  ]);
  return `${[head, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
};
