/**
 * Usage signals are the preferences that a page states about the use of its content. The crawler
 * records them with each capture, so a later use can obey them.
 *
 * The signal that changes behavior is AI input: the `ai-input` content signal of Cloudflare and the
 * `ai-use` signal of the IETF AIPREF draft. The crawler keeps a page that says no, but it holds back
 * the text from an AI reader by default. The crawler records a training opt-out (`ai-train`,
 * `train-ai`, and the `noai` and `noimageai` tags of `X-Robots-Tag`), but the opt-out does not
 * apply, because the crawler trains no model. Search engine tags (`noarchive`, `nosnippet`) are for
 * public caches and snippets. The crawler records them, but they do not block.
 *
 * The values can be structured fields (RFC 9651): `ai-input=?0`, `ai-input="no"` and `ai-input=no`
 * have the same meaning.
 */

export type AiInput = "yes" | "no" | "unset";

export interface Signals {
  readonly ai_input: AiInput;
  /** the raw lines and headers the verdict came from, for the audit trail */
  readonly raw: readonly string[];
  /** This value is the training preference. The crawler records it, and it does not change what the crawler does. */
  readonly ai_train?: AiInput | undefined;
  /** This line of `raw` decided `ai_input`. When no line states AI input, there is no line. */
  readonly deciding?: string | undefined;
}

export const NO_SIGNALS: Signals = { ai_input: "unset", raw: [] };

const NO = new Set(["no", "n", "false", "0", "?0"]);
const YES = new Set(["yes", "y", "true", "1", "?1"]);

const unquoted = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
};

/** This function reads `search=yes, ai-train=no` as a map. It ignores spaces, case and quotes. */
const pairs = (value: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const part of value.split(/[,;]/)) {
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    const key = part.slice(0, equals).trim().toLowerCase();
    out.set(key, unquoted(part.slice(equals + 1)).toLowerCase());
  }
  return out;
};

const verdictOf = (said: string | undefined): AiInput | undefined => {
  if (said === undefined) return undefined;
  if (NO.has(said)) return "no";
  if (YES.has(said)) return "yes";
  return undefined;
};

/** This function gives the bare tags of a value, for example `noai` in `X-Robots-Tag: noai, noimageai`. */
const tags = (value: string): string[] =>
  value
    .split(/[,;]/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0 && !part.includes("="))
    // a tag can name a bot first: `googlebot: noai`
    .map((part) => part.slice(part.lastIndexOf(":") + 1).trim());

/**
 * Read the signals from a site's robots.txt lines (`content-signal: …`,
 * `content-usage: …`) and the response's own headers. A "no" anywhere wins:
 * the most specific statement a site made is the one to respect.
 */
export const readSignals = (
  robotsLines: readonly string[],
  header: (name: string) => string | undefined,
): Signals => {
  const raw: string[] = [...robotsLines];
  for (const name of ["content-usage", "content-signal", "x-robots-tag"]) {
    const value = header(name);
    if (value !== undefined) raw.push(`${name}: ${value}`);
  }
  let verdict: AiInput = "unset";
  let deciding: string | undefined;
  let train: AiInput = "unset";
  for (const line of raw) {
    const colon = line.indexOf(":");
    const value = colon === -1 ? line : line.slice(colon + 1);
    const map = pairs(value);
    const said = verdictOf(map.get("ai-input") ?? map.get("ai-use"));
    if (said === "no" && verdict !== "no") {
      verdict = "no";
      deciding = line;
    } else if (said === "yes" && verdict === "unset") {
      verdict = "yes";
      deciding = line;
    }
    const trained =
      verdictOf(map.get("ai-train") ?? map.get("train-ai")) ??
      (tags(value).some((tag) => tag === "noai" || tag === "noimageai") ? "no" : undefined);
    if (trained === "no") train = "no";
    else if (trained === "yes" && train === "unset") train = "yes";
  }
  return {
    ai_input: verdict,
    raw,
    ...(train !== "unset" ? { ai_train: train } : {}),
    ...(deciding !== undefined ? { deciding } : {}),
  };
};
