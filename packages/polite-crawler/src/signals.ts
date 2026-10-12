/**
 * Usage signals are the preferences that a page states about the use of its content. The crawler
 * records them with each capture, so a later use can obey them.
 *
 * The signal that changes behavior is AI input: the `ai-input` content signal of Cloudflare and the
 * `ai-use` signal of the IETF AIPREF draft. The crawler keeps a page that says no, but it holds back
 * the text from an AI reader by default. The crawler records a training opt-out (`ai-train`), but
 * the opt-out does not apply, because the crawler trains no model. Search engine tags (`noarchive`,
 * `nosnippet`) are for public caches and snippets. The crawler records them, but they do not block.
 */

export type AiInput = "yes" | "no" | "unset";

export interface Signals {
  readonly ai_input: AiInput;
  /** the raw lines and headers the verdict came from, for the audit trail */
  readonly raw: readonly string[];
}

export const NO_SIGNALS: Signals = { ai_input: "unset", raw: [] };

const NO = new Set(["no", "n", "false", "0"]);
const YES = new Set(["yes", "y", "true", "1"]);

/** This function reads `search=yes, ai-train=no` as a map. It ignores spaces and case. */
const pairs = (value: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const part of value.split(/[,;]/)) {
    const [key, raw] = part.split("=");
    if (key === undefined || raw === undefined) continue;
    out.set(key.trim().toLowerCase(), raw.trim().toLowerCase());
  }
  return out;
};

const aiInputOf = (value: string): AiInput | undefined => {
  const map = pairs(value);
  const said = map.get("ai-input") ?? map.get("ai-use");
  if (said === undefined) return undefined;
  if (NO.has(said)) return "no";
  if (YES.has(said)) return "yes";
  return undefined;
};

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
  for (const line of raw) {
    const colon = line.indexOf(":");
    const said = aiInputOf(colon === -1 ? line : line.slice(colon + 1));
    if (said === "no") return { ai_input: "no", raw };
    if (said === "yes") verdict = "yes";
  }
  return { ai_input: verdict, raw };
};
