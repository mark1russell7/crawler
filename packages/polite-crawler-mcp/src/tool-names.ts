/*
 * The names of the tools, and the choice of the option `tools`. This file imports nothing, so the
 * command line checks `--tools` before it loads the crawler and the MCP host.
 */

/** These are the names of the nine tools, in the order of the tool list. */
export const TOOL_NAMES: readonly string[] = [
  "crawl_fetch",
  "crawl_find",
  "crawl_read",
  "crawl_verify",
  "crawl_extract",
  "crawl_discover",
  "crawl_site",
  "crawl_diff",
  "crawl_watch_list",
];

/** The set `quote` is the four tools that prove a fact with a quote from a page. */
export const QUOTE_TOOLS: readonly string[] = [
  "crawl_fetch",
  "crawl_find",
  "crawl_read",
  "crawl_verify",
];

/**
 * This function gives the names of the tools that the option `tools` chooses, in the order of the
 * tool list. The name `quote` stands for the four tools of `QUOTE_TOOLS`. With no option, the
 * function gives all the tools. It throws for an empty list and for a name that is not a tool.
 */
export const chooseTools = (tools: readonly string[] | undefined): string[] => {
  if (tools === undefined) return [...TOOL_NAMES];
  if (tools.length === 0) throw new Error("tools: give quote or one tool name, or more");
  const chosen = new Set<string>();
  for (const name of tools) {
    if (name === "quote") {
      for (const one of QUOTE_TOOLS) chosen.add(one);
    } else if (TOOL_NAMES.includes(name)) {
      chosen.add(name);
    } else {
      throw new Error(`tools: "${name}" is not a tool. Give quote or ${TOOL_NAMES.join(", ")}`);
    }
  }
  return TOOL_NAMES.filter((name) => chosen.has(name));
};
