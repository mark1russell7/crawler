/**
 * This module reads robots.txt as RFC 9309 (September 2022) specifies it. It is for a crawler that
 * tells who it is and obeys what a site says. The important rules, each with a test:
 *
 * - A group is one or more `user-agent` lines and the rules after them. A `user-agent` line after
 *   an `allow` or `disallow` line starts a new group, as the parser of Google does. A different
 *   line (`crawl-delay`) between two `user-agent` lines does not split the group. A rule before
 *   the first `user-agent` line is in no group.
 * - The product token matches with no attention to case. The matching groups merge. The group
 *   `*` applies only when no group names the crawler.
 * - The longest matching rule wins, and `allow` wins a tie. A `*` matches any sequence, and a `$`
 *   at the end anchors the end. The matcher uses no regular expression, and its time is linear.
 * - `/robots.txt` is always permitted, and an empty `disallow` matches nothing.
 * - The parser reads at least the first 500 KiB.
 * - A usage line (`content-signal`, `content-usage`) belongs to its group, with an optional path
 *   before its value. A line before the first group applies to each crawler.
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

/** A usage line states a preference about the use of the content (`content-signal`, `content-usage`). */
export interface RobotsSignal {
  /** This value is the name of the line, in lowercase. */
  readonly key: string;
  /** This text is the value of the line, after the path. */
  readonly value: string;
  /** This value is the normalized path pattern of the line. A line with no path applies to each path. */
  readonly path: string | undefined;
  /** This value is the number of the line in robots.txt, from 1. */
  readonly line: number;
}

export interface RobotsGroup {
  /** These values are the user agents of the group, in lowercase. */
  readonly agents: readonly string[];
  /** This value is the number of the first `user-agent` line of the group, from 1. */
  readonly line?: number | undefined;
  readonly rules: readonly RobotsRule[];
  /** This value is the nonstandard `crawl-delay` in seconds, when the group sets one. */
  readonly crawlDelaySeconds: number | undefined;
  /** These usage lines are in the group. They apply when the group applies. */
  readonly signals?: readonly RobotsSignal[] | undefined;
}

export interface Robots {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
  /** These lines state usage preferences (`content-signal: …`, `content-usage: …`), as written, from each group. */
  readonly signals: readonly string[];
  /** These usage lines come before the first group, so they apply to each crawler. */
  readonly fileSignals?: readonly RobotsSignal[] | undefined;
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
const URL_ENCODED = new Set("\"'<>\\^`{|}");
/**
 * The URL parser encodes these ASCII characters in a path or a query: the controls, a space, DEL,
 * and `"'<>\^`{|}`. A rule can contain them as written.
 */
const encodedAscii = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code <= 0x20 || code === 0x7f || URL_ENCODED.has(char);
};
const HEX = /^[0-9A-Fa-f]$/;

const escapeOf = (char: string): string => {
  const code = char.codePointAt(0)!;
  if (code <= 0x7f) return `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
  try {
    return encodeURIComponent(char);
  } catch {
    // a lone surrogate: the URL parser writes the replacement character
    return "%EF%BF%BD";
  }
};

/**
 * This function normalizes a path, or the pattern of a rule, for comparison, as §2.2.2 asks. It
 * encodes the characters outside US-ASCII, and the ASCII characters that the URL parser encodes
 * (a space, `"`, `<`, `{`). It decodes an escape of an unreserved character, so `/%7Efoo` and
 * `/~foo` are equal. The other escapes stay, with uppercase hexadecimal digits.
 */
export const normalizePath = (value: string): string => {
  let out = "";
  const chars = Array.from(value);
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (char === "%" && HEX.test(chars[index + 1] ?? "") && HEX.test(chars[index + 2] ?? "")) {
      const hex = `${chars[index + 1]!}${chars[index + 2]!}`;
      const decoded = String.fromCharCode(Number.parseInt(hex, 16));
      out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
      index += 2;
      continue;
    }
    out += char.charCodeAt(0) > 0x7f || encodedAscii(char) ? escapeOf(char) : char;
  }
  return out;
};

/** This function tells if a text is a product token: letters, `_` and `-` only, and one or more (RFC 9309, section 2.2.1). */
export const isProductToken = (value: string): boolean => /^[A-Za-z_-]+$/.test(value);

/** This function gives the first product token of a user agent: `Googlebot/2.1` gives `googlebot`. */
const tokenOf = (value: string): string =>
  (/^[A-Za-z_-]+/.exec(value.trim())?.[0] ?? "").toLowerCase();

/** These names are parts of the header of a browser, not the name of a crawler. */
const BROWSER_PARTS: ReadonlySet<string> = new Set([
  "mozilla",
  "applewebkit",
  "khtml",
  "gecko",
  "chrome",
  "chromium",
  "safari",
  "version",
  "mobile",
  "firefox",
  "edg",
  "opr",
  "like",
]);

/**
 * This function gives the product token that robots.txt rules match, in lowercase. `MyBot/1.0`
 * gives `mybot`. The full header `Mozilla/5.0 (compatible; MyBot/1.0; +https://…)` also gives
 * `mybot`. The token is the name after `compatible;`, or else the first product that is not a part
 * of a browser.
 */
export const productToken = (value: string): string => {
  const text = value.trim();
  const first = tokenOf(text);
  if (first !== "mozilla") return first;
  const compatible = /compatible;\s*([A-Za-z_-]+)/i.exec(text)?.[1];
  if (compatible !== undefined) return compatible.toLowerCase();
  const products = [...text.matchAll(/([A-Za-z][A-Za-z_-]*)\/[\w.]+/g)].map((match) =>
    (match[1] ?? "").toLowerCase(),
  );
  return products.find((product) => !BROWSER_PARTS.has(product)) ?? first;
};

const truncateUtf8 = (text: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  // cut at the last line break inside the limit, so no rule is half-read
  const head = new TextDecoder().decode(bytes.slice(0, maxBytes));
  const lastBreak = Math.max(head.lastIndexOf("\n"), head.lastIndexOf("\r"));
  return lastBreak === -1 ? "" : head.slice(0, lastBreak);
};

/** This function reads a usage line: an optional path, then the value (`/images/ train-ai=n`). */
const signalOf = (key: string, value: string, line: number): RobotsSignal => {
  const path = /^(\/\S*)\s+(.*)$/.exec(value);
  return path === null
    ? { key, value, path: undefined, line }
    : { key, value: path[2]!.trim(), path: normalizePath(path[1]!), line };
};

export const parseRobots = (input: string): Robots => {
  const groups: Array<{
    agents: string[];
    line: number;
    rules: RobotsRule[];
    crawlDelaySeconds: number | undefined;
    signals: RobotsSignal[];
  }> = [];
  const sitemaps: string[] = [];
  const signals: string[] = [];
  const fileSignals: RobotsSignal[] = [];
  let current: (typeof groups)[number] | undefined;
  let collectingAgents = false;
  for (const [index, raw] of truncateUtf8(input, ROBOTS_MAX_BYTES)
    .split(/\r\n|\r|\n/)
    .entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (current === undefined || !collectingAgents) {
        current = {
          agents: [],
          line: index + 1,
          rules: [],
          crawlDelaySeconds: undefined,
          signals: [],
        };
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
    // an RSL `License` line names the license of the content: the crawler records it with the other usage lines
    if (key === "content-signal" || key === "content-usage" || key === "license") {
      signals.push(`${key}: ${value}`);
      (current?.signals ?? fileSignals).push(signalOf(key, value, index + 1));
      continue;
    }
    if (current === undefined) continue;
    if (key === "allow" || key === "disallow") {
      // only a rule ends the list of agents, so a crawl-delay between two agents keeps one group
      collectingAgents = false;
      if (value.length > 0)
        current.rules.push({
          allow: key === "allow",
          pattern: normalizePath(value),
          line: index + 1,
        });
    } else if (key === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return { groups, sitemaps, signals, fileSignals };
};

/**
 * This function tells if a normalized path matches the pattern of a rule. A `*` matches any
 * sequence, and a `$` at the end anchors the end. The function finds the parts between the stars
 * in sequence, each at its first position. No pattern makes it slow: its time is linear in the
 * length of the path for each part, and it uses no regular expression.
 */
export const matchesPattern = (pattern: string, path: string): boolean => {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0]!;
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return !anchored || path.length === first.length;
  let at = first.length;
  const last = parts.length - 1;
  for (let index = 1; index < last; index += 1) {
    const part = parts[index]!;
    // two stars in sequence give an empty part, which matches at once
    if (part.length === 0) continue;
    const found = path.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  const tail = parts[last]!;
  if (!anchored) return tail.length === 0 || path.indexOf(tail, at) !== -1;
  return path.length - tail.length >= at && path.endsWith(tail);
};

interface Chosen {
  readonly rules: readonly RobotsRule[];
  readonly groups: readonly RobotsGroup[];
  readonly crawlDelaySeconds: number | undefined;
  /** This value is true when a group names this token, and `*` did not apply. */
  readonly explicit: boolean;
}

const groupsFor = (robots: Robots, token: string): Chosen => {
  const wanted = token === "*" ? "*" : productToken(token);
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
    if (!matchesPattern(rule.pattern, path)) continue;
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
 * This function tells if these tokens can fetch `pathAndQuery`. Each token becomes its product
 * token (`productToken`), so `MyBot/1.0` matches the group `mybot`. The first token is the token of
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
  // the crawl delay of a group that names a further agent applies to the fetches of that agent too
  const delays = [primary.crawlDelaySeconds];
  for (const token of tokens.slice(1)) {
    const extra = groupsFor(robots, token);
    if (extra.explicit) delays.push(extra.crawlDelaySeconds);
  }
  const known = delays.filter((delay): delay is number => delay !== undefined);
  const crawlDelaySeconds = known.length > 0 ? Math.max(...known) : undefined;
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

/**
 * This function gives the usage lines that apply to these tokens and this path, as
 * `key: value` texts. The lines come from three places:
 *
 * - the lines before the first group
 * - the groups of the first token, or `*`
 * - the groups that name a further token
 *
 * In one group, the line with the longest matching path wins for each key.
 */
export const signalsFor = (
  robots: Robots,
  tokens: readonly string[],
  pathAndQuery: string,
): string[] => {
  const path = normalizePath(pathAndQuery.length === 0 ? "/" : pathAndQuery);
  const groups = new Set(groupsFor(robots, tokens[0] ?? "*").groups);
  for (const token of tokens.slice(1)) {
    const extra = groupsFor(robots, token);
    if (extra.explicit) for (const group of extra.groups) groups.add(group);
  }
  const chosen: RobotsSignal[] = [];
  const pick = (lines: readonly RobotsSignal[]): void => {
    // for each key: the length of the longest matching path, and the lines with that length
    const best = new Map<string, { length: number; lines: RobotsSignal[] }>();
    for (const line of lines) {
      if (line.path !== undefined && !matchesPattern(line.path, path)) continue;
      const length = line.path?.length ?? 0;
      const before = best.get(line.key);
      if (before === undefined || length > before.length)
        best.set(line.key, { length, lines: [line] });
      else if (length === before.length) before.lines.push(line);
    }
    for (const { lines: kept } of best.values()) chosen.push(...kept);
  };
  pick(robots.fileSignals ?? []);
  for (const group of groups) pick(group.signals ?? []);
  return chosen.sort((a, b) => a.line - b.line).map((line) => `${line.key}: ${line.value}`);
};

/** This function gives the robots of a site whose robots.txt the crawler cannot read. No path is permitted, and the reason stays. */
export const unreachableRobots = (reason: string): Robots => ({
  ...DISALLOW_ALL,
  unreachable: reason,
});

/** This text is the reason when a robots.txt that answered 200 is a web page, not a robots.txt file. */
export const HTML_ROBOTS =
  "robots.txt is a web page, not a robots.txt file (a login or challenge page)";

/**
 * This function tells if the body of a robots.txt is a web page. A server can send a challenge, a
 * login or an error page with a 200. Such a body starts with `<!doctype`, `<html`, `<head` or
 * `<body`. With the content type `text/html`, a tag of a page in the first 4 KB is enough. A plain
 * robots.txt that a server sends as `text/html` stays a file.
 */
export const isHtmlRobots = (contentType: string | null | undefined, text: string): boolean => {
  const head = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).slice(0, 4096);
  if (/^\s*<(!doctype|html|head|body)[\s>]/i.test(head)) return true;
  return (
    /html/i.test(contentType ?? "") &&
    /<(html|head|body|script|meta|title|div|form)[\s>/]/i.test(head)
  );
};

/**
 * This function reads the answer of a robots.txt fetch: the status, the content type and the body.
 * A 2xx with a web page in place of the file is unreadable. Thus no path is permitted (fail
 * closed), as for a body that does not decode. The other statuses follow `robotsFromStatus`.
 */
export const robotsFromResponse = (
  status: number,
  contentType: string | null | undefined,
  body: Uint8Array | string,
): Robots => {
  if (status < 200 || status >= 300) return robotsFromStatus(status, undefined);
  const text = typeof body === "string" ? body : new TextDecoder("utf-8").decode(body);
  if (isHtmlRobots(contentType, text)) return unreachableRobots(HTML_ROBOTS);
  return parseRobots(text);
};

/** This function gives the meaning of the status of a robots.txt fetch (RFC 9309 §2.3.1). */
export const robotsFromStatus = (status: number, body: string | undefined): Robots => {
  if (status >= 200 && status < 300) return parseRobots(body ?? "");
  if (status === 429) return unreachableRobots("status 429, rate-limited");
  if (status >= 400 && status < 500) return ALLOW_ALL;
  return unreachableRobots(status === 0 ? "no response" : `status ${String(status)}`);
};
