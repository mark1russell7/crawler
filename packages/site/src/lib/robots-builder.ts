/**
 * The robots.txt builder of the page "Block AI training crawlers, let AI assistants in". The reader
 * picks a rule for each group of agents, and this module writes the robots.txt. The figure then
 * decides each agent and each path with the parser of polite-crawler.
 *
 * The tokens are the tokens of the robots.txt study (`src/data/robots-study.json`), and Bingbot. A
 * test makes sure that the two lists agree.
 */

/** The rule of one group: it lets the agents in, it keeps them out of one path, or it keeps them out. */
export type GroupRule = "allow" | "path" | "none";

/** The groups of agents, in the order of the robots.txt. */
export type GroupId = "training" | "search" | "user" | "engines" | "others";

/** One agent of a group. */
export interface BuilderAgent {
  readonly token: string;
  readonly owner: string;
  /** This text tells what the agent does. */
  readonly does: string;
  /** This value is true for a token that controls a use of the pages and fetches nothing. */
  readonly tokenOnly?: boolean | undefined;
}

/** One group of agents, with the comment of its group in the robots.txt. */
export interface BuilderGroup {
  readonly id: GroupId;
  readonly name: string;
  /** This text tells what the agents of the group do. */
  readonly detail: string;
  readonly comment: string;
  readonly agents: readonly BuilderAgent[];
}

export const BUILDER_GROUPS: readonly BuilderGroup[] = [
  {
    id: "training",
    name: "AI training",
    detail: "They collect pages to train AI models.",
    comment: "Crawlers and tokens for the training of AI models",
    agents: [
      { token: "GPTBot", owner: "OpenAI", does: "collects pages to train models" },
      { token: "ClaudeBot", owner: "Anthropic", does: "collects pages to train models" },
      {
        token: "Google-Extended",
        owner: "Google",
        does: "controls the use of the pages of Googlebot for training",
        tokenOnly: true,
      },
      { token: "CCBot", owner: "Common Crawl", does: "collects pages for an open dataset" },
      {
        token: "Applebot-Extended",
        owner: "Apple",
        does: "controls the use of the pages of Applebot for training",
        tokenOnly: true,
      },
      { token: "Bytespider", owner: "ByteDance", does: "collects pages to train models" },
      { token: "meta-externalagent", owner: "Meta", does: "collects pages to train models" },
    ],
  },
  {
    id: "search",
    name: "AI search",
    detail: "They collect pages for the answers of AI search, with a link to the page.",
    comment: "Crawlers for AI search: they show the site in answers, with a link",
    agents: [
      { token: "OAI-SearchBot", owner: "OpenAI", does: "collects pages for ChatGPT search" },
      {
        token: "Claude-SearchBot",
        owner: "Anthropic",
        does: "collects pages for search in Claude",
      },
      { token: "PerplexityBot", owner: "Perplexity", does: "collects pages for Perplexity search" },
    ],
  },
  {
    id: "user",
    name: "AI assistants",
    detail: "They fetch one page when a person asks for it.",
    comment: "Assistants that fetch a page because a person asked for it",
    agents: [
      { token: "ChatGPT-User", owner: "OpenAI", does: "fetches a page when a person asks ChatGPT" },
      {
        token: "Claude-User",
        owner: "Anthropic",
        does: "fetches a page when a person asks Claude",
      },
      {
        token: "Perplexity-User",
        owner: "Perplexity",
        does: "fetches a page when a person asks Perplexity",
      },
    ],
  },
  {
    id: "engines",
    name: "Search engines",
    detail: "They collect pages for Google Search and for Bing.",
    comment: "Search engines",
    agents: [
      { token: "Googlebot", owner: "Google", does: "collects pages for Google Search" },
      { token: "Bingbot", owner: "Microsoft", does: "collects pages for Bing" },
    ],
  },
  {
    id: "others",
    name: "All other crawlers",
    detail: "The group * applies to each crawler that no group names.",
    comment: "All other crawlers",
    agents: [],
  },
];

/** The choices of the reader. */
export interface BuilderChoices {
  readonly rules: Readonly<Record<GroupId, GroupRule>>;
  /** This path is the path of the rule "Keep out of the path", for example `/members/`. */
  readonly path: string;
  /** These paths are the paths that no bot must fetch, for example `/account/`. */
  readonly privatePaths: readonly string[];
  /** With the value true, each group repeats the private paths. A named group replaces the group `*`. */
  readonly repeat: boolean;
}

/** The choices of the recipe on the page: it refuses training and lets the assistants in. */
export const RECIPE_CHOICES: BuilderChoices = {
  rules: { training: "none", search: "allow", user: "allow", engines: "allow", others: "allow" },
  path: "/members/",
  privatePaths: ["/account/"],
  repeat: true,
};

/** The address of the sitemap in the file. */
export const BUILDER_SITEMAP = "https://www.example.com/sitemap.xml";

/**
 * This function gives a path that a rule can use: it adds the leading slash, and it removes the
 * spaces. An empty text gives an empty path.
 */
export const cleanPath = (text: string): string => {
  const path = text.trim().replace(/\s+/g, "");
  if (path.length === 0) return "";
  return path.startsWith("/") || path.startsWith("*") ? path : `/${path}`;
};

/** This function reads a list of paths, with commas or spaces between them. */
export const pathsOf = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map(cleanPath)
      .filter((path) => path.length > 0),
  ),
];

/** This function gives the rule lines of one group. */
const rulesOf = (id: GroupId, rule: GroupRule, choices: BuilderChoices): readonly string[] => {
  if (rule === "none") return ["Disallow: /"];
  const shared = id === "others" || choices.repeat ? choices.privatePaths : [];
  const lines: string[] = [];
  const path = cleanPath(choices.path);
  if (rule === "path" && path.length > 0) lines.push(`Disallow: ${path}`);
  for (const one of shared) if (one !== path || rule !== "path") lines.push(`Disallow: ${one}`);
  if (rule === "allow") lines.push("Allow: /");
  // a group with no rule lets the agents in: the file says it
  if (lines.length === 0) lines.push("Allow: /");
  return lines;
};

/** This function writes the robots.txt of the choices. */
export const buildRobots = (choices: BuilderChoices): string => {
  const blocks = BUILDER_GROUPS.map((group) => {
    const agents = group.id === "others" ? ["*"] : group.agents.map((agent) => agent.token);
    return [
      `# ${group.comment}`,
      ...agents.map((token) => `User-agent: ${token}`),
      ...rulesOf(group.id, choices.rules[group.id], choices),
    ].join("\n");
  });
  return `${blocks.join("\n\n")}\n\nSitemap: ${BUILDER_SITEMAP}\n`;
};

/** The tokens of the MCP server of polite-crawler: its own token, and the token of the agent it fetches for. */
export const MCP_TOKENS: readonly string[] = ["PoliteCrawler", "Claude-User"];

/** A crawler that no group names, for the row of the group `*`. The token is an example. */
export const OTHER_TOKEN = "ExampleBot";
