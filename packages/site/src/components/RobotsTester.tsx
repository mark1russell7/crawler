/**
 * The robots.txt tester. It parses the text with `parseRobots` and decides each path with `decide`,
 * the same functions that the crawler uses before each request. It shows the rule that decided, on
 * its line, for each user agent. The last column is the verdict of the MCP server, which obeys the
 * rules for its own token and for `Claude-User`.
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { RobotsDecision } from "polite-crawler/robots";
import { decide, parseRobots } from "polite-crawler/robots";
import { readSignals } from "polite-crawler/signals";
import { TRAINING_BLOCK_PATHS, TRAINING_BLOCK_ROBOTS } from "../lib/recipes.ts";
import { productToken, toPath } from "../lib/tester.ts";

const PRESETS: ReadonlyArray<{ readonly id: string; readonly name: string; readonly text: string; readonly paths: string }> = [
  {
    id: "typical",
    name: "A typical site",
    text: `# Keep the search pages and the account pages out of the crawl
User-agent: *
Disallow: /search
Disallow: /account/
Allow: /account/help

Sitemap: https://www.example.com/sitemap.xml
`,
    paths: "/\n/search?q=bread\n/account/orders\n/account/help\n/blog/robots",
  },
  {
    id: "ai",
    name: "Blocks AI crawlers",
    text: `User-agent: GPTBot
User-agent: ClaudeBot
User-agent: CCBot
Disallow: /

# An assistant that fetches a page for a person
User-agent: Claude-User
Disallow: /members/

User-agent: *
Allow: /
`,
    paths: "/\n/members/news\n/about",
  },
  {
    id: "training",
    name: "Refuses training, permits assistants",
    text: TRAINING_BLOCK_ROBOTS,
    paths: TRAINING_BLOCK_PATHS,
  },
  {
    id: "wildcards",
    name: "Wildcards and $",
    text: `User-agent: *
Disallow: /*.pdf$
Disallow: /*?sessionid=
Allow: /public/*.pdf$
Disallow: /tmp
`,
    paths: "/report.pdf\n/report.pdf?page=2\n/public/menu.pdf\n/shop?sessionid=42\n/tmp/a\n/tmpfile",
  },
  {
    id: "signals",
    name: "Crawl delay and content signals",
    text: `User-agent: *
Crawl-delay: 10
Content-Signal: search=yes, ai-train=no, ai-input=no
Disallow: /drafts/
`,
    paths: "/\n/drafts/next",
  },
];

const AGENTS = ["PoliteCrawler", "Claude-User", "GPTBot", "ClaudeBot", "Googlebot"] as const;

/** The tokens of the MCP server: its own token, and the token of the agent it fetches for. */
const MCP_TOKENS = ["PoliteCrawler", "Claude-User"] as const;

interface Column {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  readonly tokens: readonly string[];
}

/** This function gives the text that explains one decision. */
const reason = (decision: RobotsDecision): string => {
  const rule = decision.rule;
  if (rule === undefined) return "no rule matches";
  const verb = rule.allow ? "Allow" : "Disallow";
  const by = decision.by !== undefined && decision.by !== "PoliteCrawler" ? ` (the group for ${decision.by})` : "";
  return `line ${String(rule.line ?? "?")}: ${verb}: ${rule.pattern}${by}`;
};

/** The tester. */
export default function RobotsTester(): ReactElement {
  const [text, setText] = useState(PRESETS[0]!.text);
  const [paths, setPaths] = useState(PRESETS[0]!.paths);
  const [custom, setCustom] = useState("");
  const [selected, setSelected] = useState<string | undefined>(undefined);

  // a link can open an example: ?example=training
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("example");
    const preset = PRESETS.find((candidate) => candidate.id === id);
    if (preset !== undefined) {
      setText(preset.text);
      setPaths(preset.paths);
    }
  }, []);

  const robots = useMemo(() => parseRobots(text), [text]);
  const token = productToken(custom);
  const known = AGENTS.some((agent) => agent.toLowerCase() === token.toLowerCase());
  const columns: Column[] = [
    ...AGENTS.map((agent) => ({ key: agent, label: agent, title: agent, tokens: [agent] })),
    ...(token.length > 0 && !known ? [{ key: "custom", label: token, title: custom.trim(), tokens: [token] }] : []),
    {
      key: "mcp",
      label: "MCP server",
      title: "The MCP server of polite-crawler: the rules for PoliteCrawler and for Claude-User",
      tokens: MCP_TOKENS,
    },
  ];
  const targets = [
    ...new Map(
      paths
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => toPath(line))
        .map((target) => [target.path, target] as const),
    ).values(),
  ];
  const decisionOf = (path: string, column: Column): RobotsDecision => decide(robots, column.tokens, path);
  const [chosenPath, chosenKey] = selected?.split("\u0000") ?? [];
  const chosenColumn = columns.find((column) => column.key === chosenKey);
  const chosen =
    chosenPath !== undefined && chosenColumn !== undefined && targets.some((target) => target.path === chosenPath)
      ? { path: chosenPath, column: chosenColumn, decision: decisionOf(chosenPath, chosenColumn) }
      : undefined;
  const signals = readSignals(robots.signals, () => undefined);
  const lines = text.split(/\r\n|\r|\n/);
  const delay = decide(robots, ["PoliteCrawler"], "/").crawlDelaySeconds;

  return (
    <div className="pc-tool not-content">
      <div className="pc-presets" role="group" aria-label="Examples">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="pc-chip"
            aria-pressed={text === preset.text}
            onClick={() => {
              setText(preset.text);
              setPaths(preset.paths);
              setSelected(undefined);
            }}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div className="pc-tool-grid">
        <label className="pc-field">
          <span>robots.txt</span>
          <textarea
            value={text}
            spellCheck={false}
            rows={12}
            onChange={(event) => {
              setText(event.target.value);
              setSelected(undefined);
            }}
          />
        </label>
        <div className="pc-tool-side">
          <label className="pc-field">
            <span>Paths or URLs to test, one on each line</span>
            <textarea value={paths} spellCheck={false} rows={5} onChange={(event) => setPaths(event.target.value)} />
          </label>
          <label className="pc-field">
            <span>Your own user agent: a token or a full User-Agent header</span>
            <input
              value={custom}
              placeholder="For example MyBot/1.0"
              spellCheck={false}
              onChange={(event) => setCustom(event.target.value)}
            />
          </label>
          {token.length > 0 ? (
            <p className="pc-empty" aria-live="polite">
              {known ? (
                <>
                  The token <code>{token}</code> is already a column.
                </>
              ) : (
                <>
                  The tester matches the product token <code>{token}</code>.
                </>
              )}
            </p>
          ) : null}
          <dl className="pc-facts">
            <div>
              <dt>Groups</dt>
              <dd>{robots.groups.length}</dd>
            </div>
            <div>
              <dt>Crawl delay for PoliteCrawler</dt>
              <dd>{delay === undefined ? "none" : `${String(delay)} s`}</dd>
            </div>
            <div>
              <dt>AI input</dt>
              <dd>{signals.ai_input === "no" ? "refused: the text is kept but held back" : signals.ai_input === "yes" ? "permitted" : "not stated"}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="pc-table-wrap" tabIndex={0} role="region" aria-label="The verdict for each path and each agent">
        <table className="pc-table pc-tester-table">
          <thead>
            <tr>
              <th scope="col">Path</th>
              {columns.map((column) => (
                <th scope="col" key={column.key} title={column.title} className={column.key === "mcp" ? "pc-tester-mcp" : undefined}>
                  {column.label}
                  {column.key === "mcp" ? <span className="pc-tester-sub">PoliteCrawler and Claude-User</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {targets.map((target) => (
              <tr key={target.path}>
                <th scope="row">
                  <code>{target.path}</code>
                  {target.from !== undefined ? <span className="pc-tester-sub">from {target.from}</span> : null}
                </th>
                {columns.map((column) => {
                  const decision = decisionOf(target.path, column);
                  const key = `${target.path}\u0000${column.key}`;
                  return (
                    <td key={column.key} className={column.key === "mcp" ? "pc-tester-mcp" : undefined}>
                      <button
                        type="button"
                        className={`pc-verdict ${decision.allowed ? "pc-verdict-yes" : "pc-verdict-no"}`}
                        aria-pressed={selected === key}
                        title={reason(decision)}
                        onClick={() => setSelected(key)}
                      >
                        <span aria-hidden="true">{decision.allowed ? "✓" : "×"}</span>
                        {decision.allowed ? "Permitted" : "Refused"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pc-listing" aria-live="polite">
        <p className="pc-listing-head">
          {chosen === undefined
            ? "Select a result to see the rule that decided it."
            : `${chosen.column.label} on ${chosen.path}: ${chosen.decision.allowed ? "permitted" : "refused"}, ${reason(chosen.decision)}.`}
        </p>
        <ol>
          {lines.map((line, index) => {
            const number = index + 1;
            const decided = chosen?.decision.rule?.line === number;
            const inGroup = chosen?.decision.groups?.some((group) => group.line === number) ?? false;
            return (
              <li key={index} className={decided ? "pc-line-decided" : inGroup ? "pc-line-group" : undefined}>
                <code>{line.length > 0 ? line : " "}</code>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
