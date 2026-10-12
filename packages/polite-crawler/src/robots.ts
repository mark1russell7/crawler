/**
 * This module reads robots.txt as RFC 9309 (September 2022) specifies it. It is for a crawler that
 * tells who it is and obeys what a site says. The important rules, each with a test:
 *
 * - A group is one or more `user-agent` lines and the rules after them. A `user-agent` line after
 *   a rule starts a new group. A rule before the first `user-agent` line is in no group.
 * - The product token matches with no attention to case. The matching groups merge. The group
 *   `*` applies only when no group names the crawler.
 * - The longest matching rule wins, and `allow` wins a tie. A `*` matches any sequence, and a `$`
 *   at the end anchors the end.
 * - `/robots.txt` is always permitted, and an empty `disallow` matches nothing.
 * - The parser reads at least the first 500 KiB.
 *
 * The function `robotsFromStatus` gives the meaning of the status of the fetch. A 4xx is
 * "unavailable", so all paths are permitted. A 5xx or no response is "unreachable", so no path is
 * permitted. A 429 is unreachable too, as Google does it. A site that limits the rate of its robots
 * file does not ask for a crawl.
 */

export const ROBOTS_MAX_BYTES: number = 500 * 1024;

export interface RobotsRule {
  readonly allow: boolean;
  /** This value is the path pattern, normalized for comparison. */
  readonly pattern: string;
  /** This value is the number of the line in robots.txt, from 1. A rule that the code makes has none. */
  readonly line?: number | undefined;
}

export interface RobotsGroup {
  /** These values are the user agents of the group, in lowercase. */
  readonly agents: readonly string[];
  /** This value is the number of the first `user-agent` line of the group, from 1. */
  readonly line?: number | undefined;
  readonly rules: readonly RobotsRule[];
  /** This value is the nonstandard `crawl-delay` in seconds, when the group sets one. */
  readonly crawlDelaySeconds: number | undefined;
}

export interface Robots {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
  /** These lines state usage preferences (`content-signal: …`, `content-usage: …`), as written. */
  readonly signals: readonly string[];
  /**
   * This text tells why the crawler could not read robots.txt: a dead domain, a broken certificate
   * or a server error. Then no path is permitted, and the note of a skip gives this reason. It does
   * not name a rule of the site.
   */
  readonly unreachable?: string | undefined;
}

export const ALLOW_ALL: Robots = { groups: [], sitemaps: [], signals: [] };

export const DISALLOW_ALL: Robots = {
  groups: [
    { agents: ["*"], rules: [{ allow: false, pattern: "/" }], crawlDelaySeconds: undefined },
  ],
  sitemaps: [],
  signals: [],
};

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * This function normalizes a path, or the pattern of a rule, for comparison, as §2.2.2 asks. It
 * encodes the characters outside US-ASCII. It decodes an escape of an unreserved character, so
 * `/%7Efoo` and `/~foo` are equal. The other escapes stay, with uppercase hexadecimal digits.
 */
export const normalizePath = (value: string): string => {
  let out = "";
  const chars = [...value];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (
      char === "%" &&
      /^[0-9A-Fa-f]{2}$/.test(`${chars[index + 1] ?? ""}${chars[index + 2] ?? ""}`)
    ) {
      const hex = `${chars[index + 1]!}${chars[index + 2]!}`;
      const decoded = String.fromCharCode(Number.parseInt(hex, 16));
      out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
      index += 2;
      continue;
    }
    out += char.charCodeAt(0) > 0x7f ? encodeURIComponent(char) : char;
  }
  return out;
};

/** This function gives the first product token of a user agent: `Googlebot/2.1` gives `googlebot`. */
const tokenOf = (value: string): string =>
  (/^[A-Za-z_-]+/.exec(value.trim())?.[0] ?? "").toLowerCase();

const truncateUtf8 = (text: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  // cut at the last line break inside the limit, so no rule is half-read
  const head = new TextDecoder().decode(bytes.slice(0, maxBytes));
  const lastBreak = Math.max(head.lastIndexOf("\n"), head.lastIndexOf("\r"));
  return lastBreak === -1 ? "" : head.slice(0, lastBreak);
};

export const parseRobots = (input: string): Robots => {
  const groups: Array<{
    agents: string[];
    line: number;
    rules: RobotsRule[];
    crawlDelaySeconds: number | undefined;
  }> = [];
  const sitemaps: string[] = [];
  const signals: string[] = [];
  let current: (typeof groups)[number] | undefined;
  let collectingAgents = false;
  for (const [index, raw] of truncateUtf8(input, ROBOTS_MAX_BYTES).split(/\r\n|\r|\n/).entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (current === undefined || !collectingAgents) {
        current = { agents: [], line: index + 1, rules: [], crawlDelaySeconds: undefined };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }
    // records that belong to no group
    if (key === "sitemap") {
      if (value.length > 0) sitemaps.push(value);
      continue;
    }
    if (key === "content-signal" || key === "content-usage") {
      signals.push(`${key}: ${value}`);
      continue;
    }
    if (current === undefined) continue;
    collectingAgents = false;
    if (key === "allow" || key === "disallow") {
      if (value.length > 0)
        current.rules.push({ allow: key === "allow", pattern: normalizePath(value), line: index + 1 });
    } else if (key === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return { groups, sitemaps, signals };
};

const compiled = new Map<string, RegExp>();
const escapeRegex = (text: string): string => text.replace(/[.+?^{}()|[\]\\]/g, "\\$&");

const matches = (pattern: string, path: string): boolean => {
  let regex = compiled.get(pattern);
  if (regex === undefined) {
    const anchored = pattern.endsWith("$");
    const body = anchored ? pattern.slice(0, -1) : pattern;
    regex = new RegExp(
      `^${body
        .split("*")
        .map((part) => escapeRegex(part).replace(/\$/g, "\\$"))
        .join(".*")}${anchored ? "$" : ""}`,
    );
    compiled.set(pattern, regex);
  }
  return regex.test(path);
};

interface Chosen {
  readonly rules: readonly RobotsRule[];
  readonly groups: readonly RobotsGroup[];
  readonly crawlDelaySeconds: number | undefined;
  /** This value is true when a group names this token, and `*` did not apply. */
  readonly explicit: boolean;
}

const groupsFor = (robots: Robots, token: string): Chosen => {
  const wanted = token.toLowerCase();
  const named = robots.groups.filter((group) =>
    group.agents.some((agent) => agent !== "*" && tokenOf(agent) === wanted),
  );
  const chosen =
    named.length > 0 ? named : robots.groups.filter((group) => group.agents.includes("*"));
  const delays = chosen.flatMap((group) =>
    group.crawlDelaySeconds === undefined ? [] : [group.crawlDelaySeconds],
  );
  return {
    rules: chosen.flatMap((group) => group.rules),
    groups: chosen,
    crawlDelaySeconds: delays.length > 0 ? Math.max(...delays) : undefined,
    explicit: named.length > 0,
  };
};

/** This function gives the rule that decides for the path: the longest match, and `allow` in a tie. */
const decidingRule = (rules: readonly RobotsRule[], path: string): RobotsRule | undefined => {
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    if (
      best === undefined ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best;
};

export interface RobotsDecision {
  readonly allowed: boolean;
  /** This value is the product token whose rules refused the path. */
  readonly by: string | undefined;
  readonly crawlDelaySeconds: number | undefined;
  /** This rule decided. When no rule matches the path, the path is permitted and this value is empty. */
  readonly rule?: RobotsRule | undefined;
  /** These groups applied to the decision: the groups that name the token, or the group `*`. */
  readonly groups?: readonly RobotsGroup[] | undefined;
}

/**
 * This function tells if these tokens can fetch `pathAndQuery`. The first token is the token of
 * the crawler, and `*` applies when no group names it. A further token, for example `Claude-User`,
 * applies only when the site names it. A site that writes rules for an agent means them for the
 * fetches of that agent.
 */
export const decide = (
  robots: Robots,
  tokens: readonly string[],
  pathAndQuery: string,
): RobotsDecision => {
  const path = normalizePath(pathAndQuery.length === 0 ? "/" : pathAndQuery);
  const primary = groupsFor(robots, tokens[0] ?? "*");
  const crawlDelaySeconds = primary.crawlDelaySeconds;
  if (path === "/robots.txt") {
    return { allowed: true, by: undefined, crawlDelaySeconds, rule: undefined, groups: [] };
  }
  const rule = decidingRule(primary.rules, path);
  if (rule !== undefined && !rule.allow) {
    return { allowed: false, by: tokens[0], crawlDelaySeconds, rule, groups: primary.groups };
  }
  for (const token of tokens.slice(1)) {
    const extra = groupsFor(robots, token);
    const refusal = extra.explicit ? decidingRule(extra.rules, path) : undefined;
    if (refusal !== undefined && !refusal.allow) {
      return { allowed: false, by: token, crawlDelaySeconds, rule: refusal, groups: extra.groups };
    }
  }
  return { allowed: true, by: undefined, crawlDelaySeconds, rule, groups: primary.groups };
};

/** This function gives the robots of a site whose robots.txt the crawler cannot read. No path is permitted, and the reason stays. */
export const unreachableRobots = (reason: string): Robots => ({
  ...DISALLOW_ALL,
  unreachable: reason,
});

/** This function gives the meaning of the status of a robots.txt fetch (RFC 9309 §2.3.1). */
export const robotsFromStatus = (status: number, body: string | undefined): Robots => {
  if (status >= 200 && status < 300) return parseRobots(body ?? "");
  if (status === 429) return unreachableRobots("status 429, rate-limited");
  if (status >= 400 && status < 500) return ALLOW_ALL;
  return unreachableRobots(status === 0 ? "no response" : `status ${String(status)}`);
};
