/**
 * The robots.txt study: the types of the dataset that scripts/robots-study.ts writes, and the
 * numbers that the article and its charts show. The functions read the dataset at build time, so the
 * numbers are in the HTML of the page.
 */

export type Role = "training" | "search" | "user" | "control";

export interface StudyAgent {
  readonly token: string;
  readonly owner: string;
  readonly role: Role;
}

/**
 * A site has one code for each agent, in the sequence of the agents.
 *
 * - `N`: a group that names the agent refuses it.
 * - `S`: the group `*` refuses it.
 * - `n`: a group that names the agent permits it.
 * - `.`: no group refuses it.
 * - `U`: the site has no robots.txt that the crawler can read.
 */
export type Verdict = "N" | "S" | "n" | "." | "U";

export interface StudySite {
  readonly rank: number;
  readonly domain: string;
  readonly host?: string;
  readonly status: number;
  readonly state: "ok" | "missing" | "unreachable";
  readonly reason?: string;
  readonly html?: boolean;
  readonly bytes?: number;
  readonly groups?: number;
  readonly delay?: number;
  readonly signals?: readonly string[];
  readonly sitemaps?: number;
  readonly p: string;
  readonly h?: string;
  readonly r?: ReadonlyArray<readonly [number, number] | 0>;
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
  readonly agents: readonly StudyAgent[];
  readonly sites: readonly StudySite[];
}

export const ROLES: ReadonlyArray<{ readonly role: Role; readonly label: string }> = [
  { role: "training", label: "Training data" },
  { role: "search", label: "AI search" },
  { role: "user", label: "Acts for a person" },
  { role: "control", label: "For comparison" },
];

export const refused = (verdict: string | undefined): boolean => verdict === "N" || verdict === "S";

/** The sites that answered: a robots.txt, or a 4xx status that permits each path. */
export const answered = (study: Study): readonly StudySite[] =>
  study.sites.filter((site) => site.state !== "unreachable");

export const percent = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

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
  readonly share: number;
}

export const agentRows = (study: Study): readonly AgentRow[] => {
  const sites = answered(study);
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
    };
  });
};

export interface Summary {
  readonly listSize: number;
  readonly answered: number;
  readonly withFile: number;
  readonly html: number;
  readonly noFile: number;
  readonly unreachable: number;
  readonly dns: number;
  readonly namesAnAgent: number;
  readonly refusesAnAgentByName: number;
  readonly refusesAllTraining: number;
  readonly blocksEveryBot: number;
  readonly signals: number;
  readonly crawlDelay: number;
  /** For each pair: the sites that refuse the training crawler and permit the agent for a person. */
  readonly trainingNotUser: Readonly<Record<string, number>>;
  readonly signalValues: ReadonlyArray<{
    readonly key: string;
    readonly yes: number;
    readonly no: number;
  }>;
  readonly fetchedOn: string;
}

const indexOf = (study: Study, token: string): number =>
  study.agents.findIndex((agent) => agent.token === token);

export const summarize = (study: Study): Summary => {
  const sites = answered(study);
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
    let yes = 0;
    let no = 0;
    for (const site of withSignals) {
      const text = (site.signals ?? []).join(",").toLowerCase();
      const match = new RegExp(`${key}\\s*=\\s*(yes|no)`).exec(text);
      if (match?.[1] === "yes") yes += 1;
      if (match?.[1] === "no") no += 1;
    }
    return { key, yes, no };
  });
  return {
    listSize: study.sites.length,
    answered: sites.length,
    withFile: sites.filter((site) => site.state === "ok").length,
    html: sites.filter((site) => site.html === true).length,
    noFile: sites.filter((site) => site.state === "missing").length,
    unreachable: study.sites.filter((site) => site.state === "unreachable").length,
    dns: study.sites.filter((site) => site.reason?.includes("ENOTFOUND") === true).length,
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

/**
 * The sites for the grid and the table, packed into one text: `rank domain state codes` on each
 * line. A page gives it to the browser in its HTML, at a small fraction of the size of the dataset.
 */
export const pack = (study: Study): string =>
  study.sites
    .map((site) => {
      const state = site.state === "ok" ? (site.html === true ? "h" : "o") : site.state === "missing" ? "m" : "u";
      return `${String(site.rank)} ${site.domain} ${state} ${site.state === "unreachable" ? "" : site.p}`;
    })
    .join("\n");

export interface PackedSite {
  readonly rank: number;
  readonly domain: string;
  /** o: a robots.txt, h: an HTML page in its place, m: no file (4xx), u: no answer */
  readonly state: "o" | "h" | "m" | "u";
  readonly codes: string;
}

export const unpack = (packed: string): readonly PackedSite[] =>
  packed.split("\n").map((line) => {
    const [rank, domain, state, codes] = line.split(" ");
    return {
      rank: Number(rank),
      domain: domain ?? "",
      state: (state ?? "u") as PackedSite["state"],
      codes: codes ?? "",
    };
  });
